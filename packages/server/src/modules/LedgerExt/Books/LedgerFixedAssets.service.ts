import { Knex } from 'knex';
import {
  raiseVersion,
  refusingStale,
  requireVersion,
} from '../common/versions';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ServiceError } from '@/modules/Items/ServiceError';
import { TENANCY_DB_CONNECTION } from '@/modules/Tenancy/TenancyDB/TenancyDB.constants';
import { ExtUnitOfWork } from '../common/ExtUnitOfWork.service';
import { ExternalIdsService } from '../common/ExternalIds.service';
import { ExtMetadataService } from '../common/ExtMetadata.service';
import { LedgerPostingsService } from '../common/LedgerPostings.service';
import { fromCents, toCents } from '../common/money';
import { toPlainDate } from '../common/timestamps';
import { ExtRecordKind } from '../LedgerExt.constants';
import {
  LedgerAccountBrief,
  LedgerAccountsService,
} from '../Accounts/LedgerAccounts.service';
import { ExtMarkedAccountsService } from '../Accounts/ExtMarkedAccounts.service';
import { isMarkedAccountSlug } from '../Accounts/markedAccounts';
import { ExtLockService } from '../Lock/ExtLock.service';
import { toIso } from '../Trade/TradePaymentViews.service';
import {
  BOOKS_ERRORS,
  VALUE_UPDATE_REFERENCE,
  paging,
} from './books.constants';
import { FundingView, OpeningEntriesService } from './OpeningEntries.service';
import {
  CreateLedgerFixedAssetDto,
  CreateLedgerValueUpdateDto,
  EditLedgerFixedAssetDto,
} from './LedgerBooks.dto';

const ASSETS_TABLE = 'ext_fixed_assets';
const UPDATES_TABLE = 'ext_asset_value_updates';

export interface FixedAssetView {
  id: number;
  externalId: string | null;
  /** Raised by every change to the asset's fields. */
  version: number;
  name: string;
  assetType: string;
  cost: string;
  salvageValue: string | null;
  usefulLifeMonths: number | null;
  metadata: Record<string, unknown> | null;
  /** The asset's own account, made with it. */
  account: LedgerAccountBrief | null;
  accumulatedAccount: LedgerAccountBrief | null;
  /** The entry the asset was recorded with, and where its other side went. */
  funding: FundingView | null;
  createdAt: string | null;
}

export interface ValueUpdateView {
  id: number;
  externalId: string | null;
  assetId: number;
  amount: string;
  updateType: string;
  postedOn: string;
  note: string | null;
  counterAccount: LedgerAccountBrief | null;
  createdAt: string | null;
}

type Page<T> = {
  data: T[];
  pagination: { total: number; page: number; pageSize: number };
};

const named = (value: unknown): boolean =>
  value !== null && value !== undefined;

/**
 * Fixed assets and the updates of their value.
 *
 * An asset is made with an account of its own, a fixed asset account under
 * the account the chart marks `fixed-assets` (or under the root of the
 * assets when it marks none). Its cost is entered against the account it
 * was paid from, or against opening balance equity when it was held before
 * the books began. Its value falls by value updates, each one
 * entry: a debit to a counter account, a credit to the asset's accumulated
 * account.
 */
@Injectable()
export class LedgerFixedAssetsService {
  constructor(
    @Inject(TENANCY_DB_CONNECTION)
    private readonly tenantKnex: () => Knex,
    private readonly uow: ExtUnitOfWork,
    private readonly externalIds: ExternalIdsService,
    private readonly metadata: ExtMetadataService,
    private readonly accounts: LedgerAccountsService,
    private readonly marked: ExtMarkedAccountsService,
    private readonly lock: ExtLockService,
    private readonly postings: LedgerPostingsService,
    private readonly openings: OpeningEntriesService,
  ) {}

  /**
   * Creates an asset, its account and, when given, the entry of its cost, in
   * one transaction. A create carrying the external id of an existing asset
   * is a retry when its body is the one the asset was made with; otherwise
   * it is refused.
   */
  public async create(
    dto: CreateLedgerFixedAssetDto,
  ): Promise<{ asset: FixedAssetView; replayed: boolean }> {
    const accumulatedAccountId = await this.accountNamed(
      dto.accumulatedAccountId,
      dto.accumulatedAccountSlug,
      false,
    );
    const funding = await this.openings.prepareFunding(dto.funding);

    const { recordId, replayed } = await this.externalIds.createOnce({
      kind: ExtRecordKind.FixedAsset,
      externalId: dto.externalId ?? undefined,
      body: dto,
      describe: async (id) => ({
        state: 'live' as const,
        version: Number((await this.rowOrThrow(id)).version),
      }),
      create: async (trx) => {
        if (funding) await this.lock.assertOpen([funding.postedOn], trx);

        const parentAccountId =
          (await this.marked.find('fixed-assets', trx)) ??
          (await this.accounts.rootOf('asset', trx));
        const accountId = await this.accounts.createWithin(
          { name: dto.name, accountType: 'fixed-asset', parentAccountId },
          trx,
        );
        const [id] = await trx(ASSETS_TABLE).insert({
          name: dto.name,
          assetType: dto.assetType,
          cost: fromCents(toCents(dto.cost)),
          salvageValue: named(dto.salvageValue)
            ? fromCents(toCents(dto.salvageValue))
            : null,
          usefulLifeMonths: dto.usefulLifeMonths ?? null,
          accountId,
          accumulatedAccountId,
          createdAt: trx.fn.now(),
          updatedAt: trx.fn.now(),
        });
        await this.metadata.set(
          ExtRecordKind.FixedAsset,
          id,
          dto.metadata ?? null,
          trx,
        );
        if (funding) {
          await this.openings.post(
            {
              source: 'fixed_asset',
              sourceId: id,
              accountId,
              cents: funding.cents,
              postedOn: funding.postedOn,
              againstAccountId: funding.againstAccountId,
            },
            trx,
          );
        }
        return id;
      },
      read: async (id) => id,
    });
    return { asset: await this.get(recordId), replayed };
  }

  /**
   * Changes the fields given. Renaming an asset leaves its account's name
   * as it was.
   */
  public async edit(
    assetId: number,
    dto: EditLedgerFixedAssetDto,
  ): Promise<FixedAssetView> {
    await this.rowOrThrow(assetId);

    const changes: Record<string, unknown> = {};
    if (dto.name !== undefined) changes.name = dto.name;
    if (dto.salvageValue !== undefined) {
      changes.salvageValue = named(dto.salvageValue)
        ? fromCents(toCents(dto.salvageValue))
        : null;
    }
    if (dto.usefulLifeMonths !== undefined) {
      changes.usefulLifeMonths = dto.usefulLifeMonths;
    }
    if (
      dto.accumulatedAccountId !== undefined ||
      named(dto.accumulatedAccountSlug)
    ) {
      changes.accumulatedAccountId = await this.accountNamed(
        dto.accumulatedAccountId,
        dto.accumulatedAccountSlug,
        false,
      );
    }
    const version = requireVersion(dto.version);

    await refusingStale(
      () =>
        this.uow.withTransaction(async (trx) => {
          await raiseVersion(trx, ASSETS_TABLE, { id: assetId }, version);
          await trx(ASSETS_TABLE)
            .where({ id: assetId })
            .update({ ...changes, updatedAt: trx.fn.now() });
          await this.metadata.set(
            ExtRecordKind.FixedAsset,
            assetId,
            dto.metadata,
            trx,
          );
        }),
      () => this.get(assetId),
    );
    return this.get(assetId);
  }

  public async get(assetId: number): Promise<FixedAssetView> {
    await this.rowOrThrow(assetId);
    return (await this.views([assetId]))[0];
  }

  /** Assets, oldest made first. */
  public async list(query: {
    page?: string | number;
    pageSize?: string | number;
  }): Promise<Page<FixedAssetView>> {
    const { page, pageSize } = paging(query);
    const knex = this.tenantKnex();
    const [{ total }] = await knex(ASSETS_TABLE).count({ total: '*' });
    const rows = await knex(ASSETS_TABLE)
      .orderBy('id')
      .limit(pageSize)
      .offset((page - 1) * pageSize)
      .select('id');

    return {
      data: await this.views(rows.map((row: any) => Number(row.id))),
      pagination: { total: Number(total), page, pageSize },
    };
  }

  /**
   * Records a fall in an asset's value and posts it. A create carrying the
   * external id of an existing update answers that update unchanged.
   */
  public async createValueUpdate(
    dto: CreateLedgerValueUpdateDto,
  ): Promise<{ update: ValueUpdateView; replayed: boolean }> {
    const asset = await this.rowOrThrow(dto.assetId);
    const counterAccountId = await this.accountNamed(
      dto.counterAccountId,
      dto.counterAccountSlug,
      true,
    );
    const postedOn = toPlainDate(dto.postedOn);

    const { recordId, replayed } = await this.externalIds.createOnce({
      kind: ExtRecordKind.FixedAssetValueUpdate,
      externalId: dto.externalId ?? undefined,
      body: dto,
      create: async (trx) => {
        const held = await trx(ASSETS_TABLE)
          .where({ id: asset.id })
          .first()
          .forUpdate();

        if (!named(held.accumulatedAccountId)) {
          throw new ServiceError(
            BOOKS_ERRORS.ACCUMULATED_ACCOUNT_NOT_SET,
            'The fixed asset has no accumulated account, which a value update posts to.',
            { assetId: Number(asset.id) },
          );
        }
        await this.lock.assertOpen([postedOn], trx);

        const cents = toCents(dto.amount);
        const [id] = await trx(UPDATES_TABLE).insert({
          assetId: Number(asset.id),
          updateType: dto.updateType,
          amount: fromCents(cents),
          postedOn,
          note: dto.note ?? null,
          counterAccountId,
          createdAt: trx.fn.now(),
          updatedAt: trx.fn.now(),
        });
        await this.postings.replace(
          await this.openings.context(VALUE_UPDATE_REFERENCE, id),
          [
            { accountId: counterAccountId, cents, postedOn, basis: null },
            {
              accountId: Number(held.accumulatedAccountId),
              cents: -cents,
              postedOn,
              basis: null,
            },
          ],
          trx,
        );
        return id;
      },
      read: async (id) => id,
    });
    return {
      update: (await this.valueUpdateViews([recordId]))[0],
      replayed,
    };
  }

  /** Value updates, oldest dated first, of one asset when one is named. */
  public async listValueUpdates(query: {
    page?: string | number;
    pageSize?: string | number;
    assetId?: string | number;
  }): Promise<Page<ValueUpdateView>> {
    const { page, pageSize } = paging(query);
    const scoped = () => {
      const q = this.tenantKnex()(UPDATES_TABLE);
      if (named(query.assetId) && query.assetId !== '') {
        q.where({ assetId: Number(query.assetId) || 0 });
      }
      return q;
    };
    const [{ total }] = await scoped().count({ total: '*' });
    const rows = await scoped()
      .orderBy([
        { column: 'postedOn', order: 'asc' },
        { column: 'id', order: 'asc' },
      ])
      .limit(pageSize)
      .offset((page - 1) * pageSize)
      .select('id');

    return {
      data: await this.valueUpdateViews(rows.map((row: any) => Number(row.id))),
      pagination: { total: Number(total), page, pageSize },
    };
  }

  /**
   * The account a write names by id or by slug. Naming it both ways is
   * refused; so is naming it neither way where one is required.
   */
  private async accountNamed(
    accountId: number | null | undefined,
    slug: string | null | undefined,
    required: boolean,
  ): Promise<number | null> {
    if (named(accountId) && named(slug)) {
      throw new ServiceError(
        BOOKS_ERRORS.ACCOUNT_NAMED_ONCE,
        'An account is named by its id or by its slug, and not by both.',
      );
    }
    if (named(slug)) {
      if (!isMarkedAccountSlug(slug)) {
        throw new ServiceError(
          BOOKS_ERRORS.ACCOUNT_NAMED_ONCE,
          `"${slug}" is not a slug a chart marks an account by.`,
          { slug },
        );
      }
      return this.marked.get(slug);
    }
    if (named(accountId)) {
      await this.accounts.assertPostable([accountId]);
      return accountId;
    }
    if (required) {
      throw new ServiceError(
        BOOKS_ERRORS.ACCOUNT_NAMED_ONCE,
        'The account is named by its id or by its slug.',
      );
    }
    return null;
  }

  private async views(assetIds: number[]): Promise<FixedAssetView[]> {
    if (assetIds.length === 0) return [];

    const kind = ExtRecordKind.FixedAsset;
    const rows = await this.tenantKnex()(ASSETS_TABLE).whereIn('id', assetIds);
    const [externalIds, metadata, briefs, openings] = await Promise.all([
      this.externalIds.findExternalIds(kind, assetIds),
      this.metadata.getMany(kind, assetIds),
      this.accounts.briefs(
        rows
          .flatMap((row: any) => [row.accountId, row.accumulatedAccountId])
          .filter(named)
          .map(Number),
      ),
      this.openings.list('fixed_asset', assetIds),
    ]);
    const openingOf = new Map(openings.map((row) => [row.sourceId, row]));
    const rowById = new Map(rows.map((row: any) => [Number(row.id), row]));

    return assetIds
      .filter((id) => rowById.has(id))
      .map((id) => {
        const row: any = rowById.get(id);
        const opening = openingOf.get(id);

        return {
          id,
          externalId: externalIds.get(id) ?? null,
          version: Number(row.version),
          name: row.name,
          assetType: row.assetType,
          cost: fromCents(toCents(String(row.cost))),
          salvageValue: named(row.salvageValue)
            ? fromCents(toCents(String(row.salvageValue)))
            : null,
          usefulLifeMonths: named(row.usefulLifeMonths)
            ? Number(row.usefulLifeMonths)
            : null,
          metadata: (metadata.get(id) as Record<string, unknown>) ?? null,
          account: briefs.get(Number(row.accountId)) ?? null,
          accumulatedAccount: named(row.accumulatedAccountId)
            ? (briefs.get(Number(row.accumulatedAccountId)) ?? null)
            : null,
          funding: this.openings.fundingView(opening, 1),
          createdAt: toIso(row.createdAt),
        };
      });
  }

  private async valueUpdateViews(ids: number[]): Promise<ValueUpdateView[]> {
    if (ids.length === 0) return [];

    const kind = ExtRecordKind.FixedAssetValueUpdate;
    const rows = await this.tenantKnex()(UPDATES_TABLE).whereIn('id', ids);
    const [externalIds, briefs] = await Promise.all([
      this.externalIds.findExternalIds(kind, ids),
      this.accounts.briefs(
        rows.map((row: any) => Number(row.counterAccountId)),
      ),
    ]);
    const rowById = new Map(rows.map((row: any) => [Number(row.id), row]));

    return ids
      .filter((id) => rowById.has(id))
      .map((id) => {
        const row: any = rowById.get(id);

        return {
          id,
          externalId: externalIds.get(id) ?? null,
          assetId: Number(row.assetId),
          amount: fromCents(toCents(String(row.amount))),
          updateType: row.updateType,
          postedOn: row.postedOn,
          note: row.note ?? null,
          counterAccount: briefs.get(Number(row.counterAccountId)) ?? null,
          createdAt: toIso(row.createdAt),
        };
      });
  }

  private async rowOrThrow(assetId: number): Promise<any> {
    const row = Number.isInteger(assetId)
      ? await this.tenantKnex()(ASSETS_TABLE).where({ id: assetId }).first()
      : null;

    if (!row) {
      throw new ServiceError(
        BOOKS_ERRORS.FIXED_ASSET_NOT_FOUND,
        'The fixed asset was not found.',
        { assetId },
        HttpStatus.NOT_FOUND,
      );
    }
    return row;
  }
}
