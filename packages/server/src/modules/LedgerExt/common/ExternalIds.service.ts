import { Knex } from 'knex';
import { createHash } from 'crypto';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { TENANCY_DB_CONNECTION } from '@/modules/Tenancy/TenancyDB/TenancyDB.constants';
import { ServiceError } from '@/modules/Items/ServiceError';
import { ExtUnitOfWork } from './ExtUnitOfWork.service';
import { isDuplicateKey } from './dbErrors';
import {
  ERRORS,
  EXTERNAL_ID_MAX_LENGTH,
  ExtRecordKind,
} from '../LedgerExt.constants';

const TABLE = 'ext_external_ids';
const UNIQUE_INDEX = 'ext_external_ids_live_unique';

/** What an external id's record is now. */
export type ExternalIdState = 'live' | 'voided' | 'deleted';

/**
 * The hash of a create body: SHA-256 of the body as JSON with every object's
 * keys in order, so that two bodies holding the same values hash alike
 * however they were written. A value left undefined is left out.
 */
export function hashBody(body: unknown): string {
  const ordered = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(ordered);
    if (value && typeof value === 'object' && !(value instanceof Date)) {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([, v]) => v !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, v]) => [k, ordered(v)]),
      );
    }
    return value;
  };
  return createHash('sha256')
    .update(JSON.stringify(ordered(body)) ?? 'null')
    .digest('hex');
}

export interface CreateOnceOptions<T> {
  kind: ExtRecordKind;
  /**
   * The body the record is created with. A repeat of the external id with
   * the same body is a retry and is answered with the record; with another
   * body it is a conflict.
   */
  body?: unknown;
  /**
   * For a record made on first sight from its id alone, which has no body:
   * whatever record holds the id is the one meant.
   */
  anyBody?: boolean;
  /**
   * What the record holding the id is now, for the answer to a conflict.
   * Without it a record that exists is `live` and has no version.
   */
  describe?: (
    recordId: number,
  ) => Promise<{ state?: 'live' | 'voided'; version?: number | null }>;
  /** The caller's own id of the record. Without one the create is not repeat-safe. */
  externalId?: string | null;
  /** Creates the record inside the given transaction and returns its id. */
  create: (trx: Knex.Transaction) => Promise<number>;
  /** Reads a record back by id, after the transaction has ended. */
  read: (recordId: number) => Promise<T>;
  /** Joins an outer transaction instead of opening one. */
  trx?: Knex.Transaction;
}

export interface CreateOnceResult<T> {
  record: T;
  recordId: number;
  /** False when the record already existed and nothing was written. */
  created: boolean;
  /** True when this was a retry: the same id with the same body. */
  replayed: boolean;
}

/**
 * Caller-supplied ids of records, and the guarantee that a create carrying one
 * happens once.
 *
 * A live `external_id` is unique per kind by a database constraint, written in
 * the same transaction as the record it names, and of two simultaneous
 * creates exactly one writes anything.
 *
 * An external id is the record's for ever. It is never given to another
 * record, not when its own is voided and not when it is deleted. A repeated
 * create with the body the record was made with is a retry, and is answered
 * with the record. A repeated create with another body, or with the id of a
 * record since voided or deleted, is a conflict that names the record. A
 * record is changed through its update route and no other way.
 */
@Injectable()
export class ExternalIdsService {
  constructor(
    @Inject(TENANCY_DB_CONNECTION)
    private readonly tenantKnex: () => Knex,
    private readonly uow: ExtUnitOfWork,
  ) {}

  /**
   * Retrieves the id of the live record carrying the given external id.
   */
  public async findRecordId(
    kind: ExtRecordKind,
    externalId: string,
    trx?: Knex.Transaction,
  ): Promise<number | null> {
    const row = await (trx ?? this.tenantKnex())(TABLE)
      .where({ kind, externalId, live: 1 })
      .whereNotNull('recordId')
      .whereNull('deletedAt')
      .first();
    return row ? Number(row.recordId) : null;
  }

  /**
   * Marks the record of an external id deleted. The id stays held: it is not
   * given to another record.
   */
  public async markDeleted(
    kind: ExtRecordKind,
    recordId: number,
    trx: Knex.Transaction,
  ): Promise<void> {
    await trx(TABLE)
      .where({ kind, recordId, live: 1 })
      .update({ deletedAt: trx.fn.now() });
  }

  /**
   * Retrieves the external id of a live record.
   */
  public async findExternalId(
    kind: ExtRecordKind,
    recordId: number,
    trx?: Knex.Transaction,
  ): Promise<string | null> {
    const row = await (trx ?? this.tenantKnex())(TABLE)
      .where({ kind, recordId, live: 1 })
      .whereNull('deletedAt')
      .first();
    return row ? row.externalId : null;
  }

  /**
   * Retrieves the external id a record last carried, whether or not it still
   * holds it: what a deleted record is shown with.
   */
  public async findLastExternalId(
    kind: ExtRecordKind,
    recordId: number,
    trx?: Knex.Transaction,
  ): Promise<string | null> {
    const row = await (trx ?? this.tenantKnex())(TABLE)
      .where({ kind, recordId })
      .orderBy('id', 'desc')
      .first();
    return row ? row.externalId : null;
  }

  /**
   * Retrieves the external ids of several live records, keyed by record id.
   */
  public async findExternalIds(
    kind: ExtRecordKind,
    recordIds: number[],
    trx?: Knex.Transaction,
  ): Promise<Map<number, string>> {
    const found = new Map<number, string>();
    if (recordIds.length === 0) return found;

    const rows = await (trx ?? this.tenantKnex())(TABLE)
      .where({ kind, live: 1 })
      .whereNull('deletedAt')
      .whereIn('recordId', recordIds);
    rows.forEach((row) => found.set(Number(row.recordId), row.externalId));
    return found;
  }

  /**
   * Attaches an external id to a record inside the given transaction.
   * @throws {ServiceError} EXTERNAL_ID_IN_USE when a live record carries it.
   */
  public async attach(
    kind: ExtRecordKind,
    recordId: number,
    externalId: string,
    trx: Knex.Transaction,
  ): Promise<void> {
    const reservationId = await this.reserve(kind, externalId, null, trx);
    await trx(TABLE).where({ id: reservationId }).update({ recordId });
  }

  /**
   * Keeps the body a record now holds as the one its external id answers
   * a retry for. Used where a record's fields are replaced whole by an
   * update, so that a caller who sends those same fields again under the id
   * is answered with the record and writes nothing.
   */
  public async rehash(
    kind: ExtRecordKind,
    recordId: number,
    body: (externalId: string) => unknown,
    trx: Knex.Transaction,
  ): Promise<void> {
    const row = await trx(TABLE)
      .where({ kind, recordId, live: 1 })
      .whereNull('deletedAt')
      .first();
    if (!row) return;

    await trx(TABLE)
      .where({ id: row.id })
      .update({ bodyHash: hashBody(body(row.externalId)) });
  }

  /**
   * Creates a record at most once per external id.
   *
   * The id is reserved before the record is written. A concurrent create of
   * the same id waits on that reservation: if the first commits, the second
   * fails on the unique constraint, writes nothing, and is answered as any
   * repeat is.
   * @throws {ServiceError} EXTERNAL_ID_IN_USE - The id is held by a record
   *   made with another body, or since voided or deleted.
   */
  public async createOnce<T>(
    options: CreateOnceOptions<T>,
  ): Promise<CreateOnceResult<T>> {
    const { kind, externalId, create, read, trx } = options;

    if (externalId === undefined || externalId === null) {
      const recordId = await this.uow.withTransaction(create, trx);
      return {
        recordId,
        record: await read(recordId),
        created: true,
        replayed: false,
      };
    }
    this.validate(externalId);

    const bodyHash = options.anyBody ? null : hashBody(options.body ?? null);
    const held = await this.repeat(options, bodyHash, trx);
    if (held) return held;

    try {
      const recordId = await this.uow.withTransaction(async (innerTrx) => {
        const reservationId = await this.reserve(
          kind,
          externalId,
          bodyHash,
          innerTrx,
        );
        const createdId = await create(innerTrx);

        await innerTrx(TABLE)
          .where({ id: reservationId })
          .update({ recordId: createdId });
        return createdId;
      }, trx);

      return {
        recordId,
        record: await read(recordId),
        created: true,
        replayed: false,
      };
    } catch (error) {
      if (!this.isInUse(error)) throw error;
      // Inside an outer transaction the caller decides what a clash means.
      if (trx) throw error;

      // Lost to a simultaneous create: answered as a repeat of the winner.
      const winner = await this.repeat(options, bodyHash);
      if (!winner) throw error;
      return winner;
    }
  }

  /**
   * Answers a create whose external id is already held: the record, when the
   * body is the one it was made with; a conflict otherwise. Null when no
   * record holds the id.
   */
  private async repeat<T>(
    options: CreateOnceOptions<T>,
    bodyHash: string | null,
    trx?: Knex.Transaction,
  ): Promise<CreateOnceResult<T> | null> {
    const { kind, externalId } = options;
    const row = await (trx ?? this.tenantKnex())(TABLE)
      .where({ kind, externalId, live: 1 })
      .whereNotNull('recordId')
      .first();
    if (!row) return null;

    const recordId = Number(row.recordId);
    const deleted = row.deletedAt !== null && row.deletedAt !== undefined;
    const described =
      !deleted && options.describe ? await options.describe(recordId) : {};
    const state: ExternalIdState = deleted
      ? 'deleted'
      : (described.state ?? 'live');
    const sameBody =
      options.anyBody || (row.bodyHash !== null && row.bodyHash === bodyHash);

    if (state === 'live' && sameBody) {
      return {
        recordId,
        record: await options.read(recordId),
        created: false,
        replayed: true,
      };
    }
    throw new ServiceError(
      ERRORS.EXTERNAL_ID_IN_USE,
      state === 'live'
        ? 'A record with this external id already exists, made with a different body. Change it through its update route.'
        : `This external id belongs to a record that has been ${state}. An external id is never used again.`,
      {
        kind,
        externalId,
        recordId,
        state,
        version: described.version ?? null,
      },
      HttpStatus.CONFLICT,
    );
  }

  /**
   * Reserves an external id, returning the id of the reservation row.
   */
  private async reserve(
    kind: ExtRecordKind,
    externalId: string,
    bodyHash: string | null,
    trx: Knex.Transaction,
  ): Promise<number> {
    this.validate(externalId);
    try {
      const [id] = await trx(TABLE).insert({
        kind,
        externalId,
        bodyHash,
        live: 1,
        createdAt: trx.fn.now(),
      });
      return id;
    } catch (error) {
      if (isDuplicateKey(error, UNIQUE_INDEX)) {
        throw new ServiceError(
          ERRORS.EXTERNAL_ID_IN_USE,
          'A record with this external id already exists.',
          { kind, externalId },
          HttpStatus.CONFLICT,
        );
      }
      throw error;
    }
  }

  private validate(externalId: string) {
    if (
      typeof externalId !== 'string' ||
      externalId.length === 0 ||
      externalId.length > EXTERNAL_ID_MAX_LENGTH
    ) {
      throw new ServiceError(
        ERRORS.EXTERNAL_ID_IN_USE,
        `The external id must be a string of 1 to ${EXTERNAL_ID_MAX_LENGTH} characters.`,
      );
    }
  }

  private isInUse(error: any): boolean {
    return (
      error instanceof ServiceError &&
      error.errorType === ERRORS.EXTERNAL_ID_IN_USE
    );
  }
}
