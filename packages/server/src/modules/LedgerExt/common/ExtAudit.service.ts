import { Knex } from 'knex';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { TENANCY_DB_CONNECTION } from '@/modules/Tenancy/TenancyDB/TenancyDB.constants';
import { ExtRecordKind } from '../LedgerExt.constants';

const TABLE = 'ext_audit_log';
const BIGCAPITAL_TABLE = 'audit_logs';

/** The key the actor of a request is kept under for the length of the request. */
export const ACTOR_CLS_KEY = 'ledgerActor';
/** The header a caller names the actor in. */
export const ACTOR_HEADER = 'x-ledger-actor';
/** The longest actor kept. */
export const ACTOR_MAX_LENGTH = 255;

export type AuditAction =
  | 'create'
  | 'edit'
  | 'void'
  | 'delete'
  | 'archive'
  | 'restore'
  | 'revoke';

export interface AuditEntry {
  action: AuditAction;
  subject: ExtRecordKind;
  subjectId: number | null;
  /** The record's own number or reference, so a deleted record can be named. */
  number?: string | null;
  /** The record as its route answered it before the change; null on a create. */
  before?: unknown;
  /**
   * Also write a row to Bigcapital's own log, for a record Bigcapital's
   * services know nothing of and so do not log themselves.
   */
  index?: boolean;
}

export interface AuditRow {
  id: number;
  action: string;
  subject: string;
  subjectId: number | null;
  number: string | null;
  actor: string | null;
  before: unknown;
  after: unknown;
  createdAt: string;
}

/**
 * The audit log of the extension.
 *
 * A change is logged in two steps. The row is written inside the change's
 * own transaction, with the record as it stood before, so a change that
 * fails leaves no row and a change that lands always has one. What the
 * record became is added once the transaction has committed, when it can be
 * read as its route answers it.
 */
@Injectable()
export class ExtAuditService {
  private readonly logger = new Logger(ExtAuditService.name);

  constructor(
    @Inject(TENANCY_DB_CONNECTION)
    private readonly tenantKnex: () => Knex,
    private readonly cls: ClsService,
  ) {}

  /**
   * Writes the row of a change, inside the change's transaction.
   * @returns The id of the row, for `finish`.
   */
  public async record(
    entry: AuditEntry,
    trx: Knex.Transaction,
  ): Promise<number> {
    const userId = this.cls.get<number>('userId') ?? null;
    const createdAt = new Date().toISOString();
    let auditLogId: number | null = null;

    if (entry.index) {
      [auditLogId] = await trx(BIGCAPITAL_TABLE).insert({
        userId,
        action: entry.action,
        subject: entry.subject,
        subjectId: entry.subjectId,
        metadata: JSON.stringify({ number: entry.number ?? null }),
        ip: this.cls.get<string>('ip') ?? null,
        createdAt: trx.fn.now(),
      });
    }
    const [id] = await trx(TABLE).insert({
      action: entry.action,
      subject: entry.subject,
      subjectId: entry.subjectId,
      number: entry.number ?? null,
      actor: this.actor(),
      userId,
      before: this.serialize(entry.before),
      after: null,
      auditLogId,
      createdAt,
    });
    return id;
  }

  /**
   * Adds what the record became, once the change has committed. A failure
   * here is logged and not raised: the change stands, and its row already
   * says that it happened and what the record was before.
   */
  public async finish(id: number | null | undefined, after: unknown) {
    if (id === null || id === undefined) return;
    try {
      await this.tenantKnex()(TABLE)
        .where({ id })
        .update({ after: this.serialize(after) });
    } catch (error: any) {
      this.logger.error(
        `The audit row ${id} was left without its "after": ${error?.message ?? error}`,
      );
    }
  }

  /** Rows newest first, of one record or of every record. */
  public async list(query: {
    subject?: string;
    subjectId?: string | number;
    from?: string;
    to?: string;
    page?: string | number;
    pageSize?: string | number;
  }): Promise<{
    data: AuditRow[];
    pagination: { total: number; page: number; pageSize: number };
  }> {
    const page = Math.max(1, Number(query.page) || 1);
    const pageSize = Math.min(
      Math.max(1, Number(query.pageSize) || 50),
      AUDIT_LIST_MAX_PAGE_SIZE,
    );
    const scope = () => {
      const q = this.tenantKnex()(TABLE);
      if (query.subject) q.where({ subject: query.subject });
      if (query.subjectId !== undefined && query.subjectId !== '') {
        q.where({ subjectId: Number(query.subjectId) || 0 });
      }
      if (query.from) q.where('createdAt', '>=', query.from);
      if (query.to) q.where('createdAt', '<', query.to);
      return q;
    };
    const [{ total }] = await scope().count({ total: '*' });
    const rows = await scope()
      .orderBy([
        { column: 'createdAt', order: 'desc' },
        { column: 'id', order: 'desc' },
      ])
      .limit(pageSize)
      .offset((page - 1) * pageSize);

    return {
      data: rows.map((row: any) => ({
        id: Number(row.id),
        action: row.action,
        subject: row.subject,
        subjectId: row.subjectId === null ? null : Number(row.subjectId),
        number: row.number ?? null,
        actor: row.actor ?? null,
        before: this.parse(row.before),
        after: this.parse(row.after),
        createdAt: row.createdAt,
      })),
      pagination: { total: Number(total), page, pageSize },
    };
  }

  private actor(): string | null {
    const actor = this.cls.get<string>(ACTOR_CLS_KEY);
    return typeof actor === 'string' && actor !== '' ? actor : null;
  }

  private serialize(value: unknown): string | null {
    return value === null || value === undefined ? null : JSON.stringify(value);
  }

  private parse(value: string | null): unknown {
    if (value === null || value === undefined) return null;
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
}

/** The most rows one page of the audit log holds. */
export const AUDIT_LIST_MAX_PAGE_SIZE = 500;
