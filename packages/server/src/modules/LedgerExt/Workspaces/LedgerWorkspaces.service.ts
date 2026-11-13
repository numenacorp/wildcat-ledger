import { Knex } from 'knex';
import { Queue } from 'bullmq';
import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { HttpStatus } from '@nestjs/common';
import { ServiceError } from '@/modules/Items/ServiceError';
import { events } from '@/common/events/events';
import { SystemKnexConnection } from '@/modules/System/SystemDB/SystemDB.constants';
import { TenantRepository } from '@/modules/System/repositories/Tenant.repository';
import { transformBuildDto } from '@/modules/Organization/Organization.utils';
import {
  OrganizationBuildQueue,
  OrganizationBuildQueueJob,
  OrganizationBuildQueueJobPayload,
} from '@/modules/Organization/Organization.types';
import { DeleteWorkspaceJobService } from '@/modules/ee/Workspaces/commands/DeleteWorkspaceJob.service';
import { ExtServiceLocator } from '../common/ExtServiceLocator.service';
import { toPlainDate } from '../common/timestamps';
import { fiscalMonthName, fiscalMonthOf } from './fiscalYear';
import { isDuplicateKey } from '../common/dbErrors';
import { validateChart } from '../Accounts/chart';
import { ProvisionWorkspaceService } from './ProvisionWorkspace.service';
import {
  CreateLedgerWorkspaceDto,
  LedgerWorkspaceResponseDto,
  UpdateLedgerWorkspaceDto,
} from './LedgerWorkspace.dto';
import {
  DEFAULT_BUILD_WAIT_MS,
  ReportingBasis,
  WORKSPACE_ERRORS,
  WorkspaceStatus,
} from './LedgerWorkspaces.constants';

const TABLE = 'ext_workspaces';
const UNIQUE_INDEX = 'ext_workspaces_live_unique';
const POLL_INTERVAL_MS = 250;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface ListWorkspacesFilter {
  externalId?: string;
  page?: number;
  pageSize?: number;
}

/**
 * Workspaces of the ledger extension. A workspace is a Bigcapital
 * organization, with its own database, that carries the caller's own id and
 * is created with its chart of accounts in one call.
 */
@Injectable()
export class LedgerWorkspacesService {
  constructor(
    @Inject(SystemKnexConnection)
    private readonly systemKnex: Knex,
    @InjectQueue(OrganizationBuildQueue)
    private readonly buildQueue: Queue,
    private readonly cls: ClsService,
    private readonly configService: ConfigService,
    private readonly eventEmitter: EventEmitter2,
    private readonly locator: ExtServiceLocator,
    private readonly provisioner: ProvisionWorkspaceService,
  ) {}

  /**
   * Creates a workspace, or returns the one that already carries the
   * external id. The call waits for the organization database to be built.
   * If the build outlasts the wait the workspace is returned as `building`,
   * and repeating the call picks the work up where it stands; a repeat never
   * starts a second build.
   */
  public async create(
    userId: number,
    dto: CreateLedgerWorkspaceDto,
  ): Promise<{ workspace: LedgerWorkspaceResponseDto; created: boolean }> {
    let row = await this.findRow(userId, { externalId: dto.externalId });
    let created = false;

    if (!row) {
      if (dto.accounts) validateChart(dto.accounts);
      try {
        row = await this.insert(userId, dto);
        created = true;
      } catch (error: any) {
        if (!isDuplicateKey(error, UNIQUE_INDEX)) throw error;
        // A concurrent create of the same external id got there first.
        row = await this.findRow(userId, { externalId: dto.externalId });
        if (!row) throw error;
      }
    }
    row = await this.advance(row, this.buildWaitMs);

    return { workspace: await this.toWorkspace(row), created };
  }

  public async list(
    userId: number,
    filter: ListWorkspacesFilter,
  ): Promise<{
    data: LedgerWorkspaceResponseDto[];
    pagination: { total: number; page: number; pageSize: number };
  }> {
    const page = Math.max(1, Number(filter.page) || 1);
    const pageSize = Math.min(Math.max(1, Number(filter.pageSize) || 50), 200);

    const scope = () => {
      const query = this.systemKnex(TABLE).where({
        ownerUserId: userId,
        live: 1,
      });
      if (filter.externalId !== undefined) {
        query.where({ externalId: filter.externalId });
      }
      return query;
    };
    const [{ total }] = await scope().count({ total: '*' });
    const rows = await scope()
      .orderBy('id', 'asc')
      .limit(pageSize)
      .offset((page - 1) * pageSize);

    return {
      data: await Promise.all(rows.map((row) => this.toWorkspace(row))),
      pagination: { total: Number(total), page, pageSize },
    };
  }

  public async get(
    userId: number,
    workspaceId: number,
  ): Promise<LedgerWorkspaceResponseDto> {
    return this.toWorkspace(await this.getRowOrThrow(userId, workspaceId));
  }

  public async update(
    userId: number,
    workspaceId: number,
    dto: UpdateLedgerWorkspaceDto,
  ): Promise<LedgerWorkspaceResponseDto> {
    const row = await this.getRowOrThrow(userId, workspaceId);
    const changes: Record<string, unknown> = {};

    if (dto.booksStartOn !== undefined) {
      changes.booksStartOn = toPlainDate(dto.booksStartOn);
    }
    if (dto.reportingBasis !== undefined) {
      changes.reportingBasis = dto.reportingBasis;
    }
    if (Object.keys(changes).length > 0) {
      await this.systemKnex(TABLE)
        .where({ id: row.id })
        .update({ ...changes, updatedAt: this.systemKnex.fn.now() });
    }
    // The fiscal year is Bigcapital's own setting, kept where it keeps it.
    if (dto.fiscalYearStartMonth !== undefined) {
      await this.systemKnex('tenants_metadata')
        .where({ tenantId: row.tenantId })
        .update({ fiscalYear: fiscalMonthName(dto.fiscalYearStartMonth) });
    }
    return this.get(userId, workspaceId);
  }

  /**
   * Inactivates a workspace. It stays listed; calls under it are refused.
   */
  public async inactivate(
    userId: number,
    workspaceId: number,
  ): Promise<LedgerWorkspaceResponseDto> {
    const row = await this.getRowOrThrow(userId, workspaceId);

    if (!row.inactiveAt) {
      await this.systemKnex.transaction(async (trx) => {
        await trx('tenants')
          .where({ id: row.tenantId })
          .update({ isInactive: true });
        await trx(TABLE).where({ id: row.id }).update({
          inactiveAt: new Date().toISOString(),
          updatedAt: trx.fn.now(),
        });
      });
    }
    return this.get(userId, workspaceId);
  }

  public async activate(
    userId: number,
    workspaceId: number,
  ): Promise<LedgerWorkspaceResponseDto> {
    const row = await this.getRowOrThrow(userId, workspaceId);

    await this.systemKnex.transaction(async (trx) => {
      await trx('tenants')
        .where({ id: row.tenantId })
        .update({ isInactive: false });
      await trx(TABLE)
        .where({ id: row.id })
        .update({ inactiveAt: null, updatedAt: trx.fn.now() });
    });
    return this.get(userId, workspaceId);
  }

  /**
   * Deletes a workspace and its database. Its external id can be used again
   * at once; the database is dropped by a background job.
   */
  public async delete(userId: number, workspaceId: number): Promise<void> {
    const row = await this.getRowOrThrow(userId, workspaceId);
    const tenant = await this.systemKnex('tenants')
      .where({ id: row.tenantId })
      .first();

    await this.systemKnex(TABLE)
      .where({ id: row.id })
      .update({ live: null, updatedAt: this.systemKnex.fn.now() });

    const deleteJob = await this.locator.resolve(DeleteWorkspaceJobService);
    await deleteJob.initiateDelete(userId, tenant.organizationId);
  }

  /**
   * Resolves the workspace a call under an organization belongs to, refusing
   * one that is inactive or not yet ready.
   */
  public async requireUsable(organizationId: string): Promise<void> {
    const row = await this.systemKnex(TABLE)
      .join('tenants', 'tenants.id', `${TABLE}.tenantId`)
      .where('tenants.organizationId', organizationId)
      .where(`${TABLE}.live`, 1)
      .select(`${TABLE}.*`)
      .first();

    if (!row) {
      throw new ServiceError(
        WORKSPACE_ERRORS.WORKSPACE_NOT_FOUND,
        'The workspace was not found.',
        undefined,
        HttpStatus.NOT_FOUND,
      );
    }
    if (row.inactiveAt) {
      throw new ServiceError(
        WORKSPACE_ERRORS.WORKSPACE_INACTIVE,
        'The workspace is inactive.',
        undefined,
        HttpStatus.NOT_FOUND,
      );
    }
    if (row.status !== WorkspaceStatus.Ready) {
      throw new ServiceError(
        WORKSPACE_ERRORS.WORKSPACE_NOT_READY,
        'The workspace is still being set up.',
        undefined,
        HttpStatus.CONFLICT,
      );
    }
  }

  /**
   * The workspace of an organization, or null when it has none.
   */
  public async findByOrganization(organizationId: string): Promise<{
    id: number;
    reportingBasis: 'accrual' | 'cash';
    booksStartOn: string | null;
    timezone: string;
    baseCurrency: string;
    fiscalYearStartMonth: number;
  } | null> {
    const row = await this.systemKnex(TABLE)
      .join('tenants', 'tenants.id', `${TABLE}.tenantId`)
      .leftJoin('tenants_metadata', 'tenants_metadata.tenantId', 'tenants.id')
      .where('tenants.organizationId', organizationId)
      .where(`${TABLE}.live`, 1)
      .select(
        `${TABLE}.id`,
        `${TABLE}.reportingBasis`,
        `${TABLE}.booksStartOn`,
        'tenants_metadata.timezone',
        'tenants_metadata.baseCurrency',
        'tenants_metadata.fiscalYear',
      )
      .first();
    if (!row) return null;

    const { fiscalYear, ...workspace } = row;
    return { ...workspace, fiscalYearStartMonth: fiscalMonthOf(fiscalYear) };
  }

  /** Changes the reporting basis of an organization's workspace. */
  public async setReportingBasis(
    organizationId: string,
    reportingBasis: 'accrual' | 'cash',
  ): Promise<void> {
    const workspace = await this.findByOrganization(organizationId);
    if (!workspace) return;

    await this.systemKnex(TABLE)
      .where({ id: workspace.id })
      .update({ reportingBasis, updatedAt: this.systemKnex.fn.now() });
  }

  private get buildWaitMs(): number {
    const configured = Number(process.env.LEDGER_WORKSPACE_BUILD_WAIT_MS);
    return Number.isFinite(configured) && configured >= 0
      ? configured
      : DEFAULT_BUILD_WAIT_MS;
  }

  /**
   * Creates the tenant, its owner link, its metadata and the workspace row
   * in one transaction of the system database.
   */
  private async insert(userId: number, dto: CreateLedgerWorkspaceDto) {
    const tenants = await this.locator.resolve(TenantRepository);
    const buildDto = this.toBuildDto(dto);

    const row = await this.systemKnex.transaction(async (trx) => {
      const tenant = await tenants.createWithUniqueOrgId(undefined, trx);

      await trx('user_tenants').insert({
        userId,
        tenantId: tenant.id,
        role: 'owner',
        createdAt: trx.fn.now(),
        updatedAt: trx.fn.now(),
      });
      await tenants.saveMetadata(tenant.id, buildDto, trx);

      const [id] = await trx(TABLE).insert({
        tenantId: tenant.id,
        ownerUserId: userId,
        externalId: dto.externalId,
        live: 1,
        status: WorkspaceStatus.Building,
        reportingBasis: dto.reportingBasis ?? ReportingBasis.Accrual,
        booksStartOn: dto.booksStartOn ? toPlainDate(dto.booksStartOn) : null,
        pendingAccounts: dto.accounts ? JSON.stringify(dto.accounts) : null,
        createdAt: trx.fn.now(),
        updatedAt: trx.fn.now(),
      });
      return trx(TABLE).where({ id }).first();
    });
    const tenant = await this.systemKnex('tenants')
      .where({ id: row.tenantId })
      .first();

    await this.eventEmitter.emitAsync(events.workspace.created, {
      tenantId: tenant.id,
      organizationId: tenant.organizationId,
      userId,
      buildDTO: buildDto,
    });
    return row;
  }

  /**
   * Moves a workspace as far towards `ready` as it can within the wait:
   * queues the build if no one has, waits for it, then provisions.
   */
  private async advance(row: any, waitMs: number): Promise<any> {
    if (row.status === WorkspaceStatus.Ready) return row;

    const tenant = await this.systemKnex('tenants')
      .where({ id: row.tenantId })
      .first();
    const metadata = await this.systemKnex('tenants_metadata')
      .where({ tenantId: tenant.id })
      .first();

    if (!tenant.builtAt) {
      await this.releaseDeadBuild(row);
      await this.queueBuildOnce(row, tenant, metadata);

      const deadline = Date.now() + waitMs;
      let built = false;

      while (!built) {
        const state = await this.buildState(row.id);
        if (state.builtAt) {
          built = true;
        } else if (state.failedReason) {
          await this.systemKnex(TABLE).where({ id: row.id }).update({
            status: WorkspaceStatus.Failed,
            buildError: state.failedReason,
            updatedAt: this.systemKnex.fn.now(),
          });
          throw new ServiceError(
            WORKSPACE_ERRORS.WORKSPACE_BUILD_FAILED,
            'The workspace could not be built.',
            { reason: state.failedReason },
            HttpStatus.INTERNAL_SERVER_ERROR,
          );
        } else if (Date.now() >= deadline) {
          return this.systemKnex(TABLE).where({ id: row.id }).first();
        } else {
          await sleep(POLL_INTERVAL_MS);
        }
      }
    }
    const accounts = row.pendingAccounts
      ? JSON.parse(row.pendingAccounts)
      : null;

    await this.inTenant(tenant.organizationId, row.ownerUserId, () =>
      this.provisioner.provision({
        baseCurrency: metadata.baseCurrency,
        accounts,
      }),
    );
    await this.systemKnex(TABLE).where({ id: row.id }).update({
      status: WorkspaceStatus.Ready,
      pendingAccounts: null,
      buildError: null,
      updatedAt: this.systemKnex.fn.now(),
    });
    return this.systemKnex(TABLE).where({ id: row.id }).first();
  }

  /**
   * Queues the build of the organization database, at most once. The build
   * begins by dropping any database of the organization, so a second build
   * started beside the first would destroy it. The job id is claimed on the
   * workspace row first, and only the claimer queues the job.
   */
  private async queueBuildOnce(row: any, tenant: any, metadata: any) {
    const jobId = `ledger-workspace-${row.id}`;
    const claimed = await this.systemKnex(TABLE)
      .where({ id: row.id })
      .whereNull('buildJobId')
      .update({ buildJobId: jobId });

    if (!claimed) return;

    await this.buildQueue.add(
      OrganizationBuildQueueJob,
      {
        organizationId: tenant.organizationId,
        userId: row.ownerUserId,
        buildDto: {
          name: metadata.name,
          location: metadata.location,
          baseCurrency: metadata.baseCurrency,
          timezone: metadata.timezone,
          fiscalYear: metadata.fiscalYear,
          language: metadata.language,
          dateFormat: metadata.dateFormat,
        },
      } as OrganizationBuildQueueJobPayload,
      { jobId },
    );
  }

  /**
   * Gives up the claim on a build that will never finish, so that it is
   * queued again: one whose job failed on an earlier request, or whose job
   * is gone from the queue with the organization still unbuilt. Without this
   * a workspace whose build failed once could only be deleted.
   */
  private async releaseDeadBuild(row: any): Promise<void> {
    const current = await this.systemKnex(TABLE).where({ id: row.id }).first();
    if (!current?.buildJobId) return;

    const job = await this.buildQueue.getJob(current.buildJobId);
    const failed = job ? await job.isFailed() : false;
    if (job && !failed) return;

    // A job that finished is removed from the queue only after it marked
    // the organization built, so one that is gone and unbuilt is lost.
    const tenant = await this.systemKnex('tenants')
      .where({ id: current.tenantId })
      .first();
    if (tenant.builtAt) return;

    const released = await this.systemKnex(TABLE)
      .where({ id: row.id, buildJobId: current.buildJobId })
      .update({
        buildJobId: null,
        status: WorkspaceStatus.Building,
        buildError: null,
        updatedAt: this.systemKnex.fn.now(),
      });
    if (released && job) await job.remove();
  }

  private async buildState(
    workspaceRowId: number,
  ): Promise<{ builtAt: string | null; failedReason: string | null }> {
    const row = await this.systemKnex(TABLE)
      .join('tenants', 'tenants.id', `${TABLE}.tenantId`)
      .where(`${TABLE}.id`, workspaceRowId)
      .select('tenants.builtAt', `${TABLE}.buildJobId`)
      .first();

    if (row.builtAt) return { builtAt: row.builtAt, failedReason: null };

    const job = row.buildJobId
      ? await this.buildQueue.getJob(row.buildJobId)
      : null;
    const failed = job ? await job.isFailed() : false;

    return {
      builtAt: null,
      failedReason: failed ? job.failedReason || 'The build job failed.' : null,
    };
  }

  /** Runs work with the tenancy context of an organization set. */
  private inTenant<T>(
    organizationId: string,
    userId: number,
    work: () => Promise<T>,
  ): Promise<T> {
    return this.cls.run(async () => {
      this.cls.set('organizationId', organizationId);
      this.cls.set('userId', userId);
      await this.cls.resolveProxyProviders();
      return work();
    });
  }

  private toBuildDto(dto: CreateLedgerWorkspaceDto) {
    return transformBuildDto({
      name: dto.name,
      location: dto.country,
      baseCurrency: dto.baseCurrency,
      timezone: dto.timezone,
      fiscalYear: fiscalMonthName(dto.fiscalYearStartMonth ?? 1),
      language: 'en',
    } as any);
  }

  private findRow(
    userId: number,
    where: { externalId?: string; tenantId?: number },
  ) {
    return this.systemKnex(TABLE)
      .where({ ownerUserId: userId, live: 1, ...where })
      .first();
  }

  private async getRowOrThrow(userId: number, workspaceId: number) {
    const row = Number.isInteger(workspaceId)
      ? await this.findRow(userId, { tenantId: workspaceId })
      : null;

    if (!row) {
      throw new ServiceError(
        WORKSPACE_ERRORS.WORKSPACE_NOT_FOUND,
        'The workspace was not found.',
        undefined,
        HttpStatus.NOT_FOUND,
      );
    }
    return row;
  }

  private async toWorkspace(row: any): Promise<LedgerWorkspaceResponseDto> {
    const tenant = await this.systemKnex('tenants')
      .where({ id: row.tenantId })
      .first();
    const metadata = await this.systemKnex('tenants_metadata')
      .where({ tenantId: row.tenantId })
      .first();

    return {
      id: Number(row.tenantId),
      organizationId: tenant.organizationId,
      externalId: row.externalId,
      name: metadata?.name ?? null,
      country: metadata?.location ?? null,
      baseCurrency: metadata?.baseCurrency ?? null,
      timezone: metadata?.timezone ?? null,
      reportingBasis: row.reportingBasis,
      booksStartOn: row.booksStartOn ?? null,
      fiscalYearStartMonth: fiscalMonthOf(metadata?.fiscalYear),
      inactiveAt: row.inactiveAt ?? null,
      status: row.status,
    };
  }
}
