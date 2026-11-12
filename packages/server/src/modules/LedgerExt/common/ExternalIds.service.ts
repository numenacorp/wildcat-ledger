import { Knex } from 'knex';
import { Inject, Injectable } from '@nestjs/common';
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

export interface CreateOnceOptions<T> {
  kind: ExtRecordKind;
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
}

/**
 * Caller-supplied ids of records, and the guarantee that a create carrying one
 * happens once.
 *
 * A live `external_id` is unique per kind by a database constraint, written in
 * the same transaction as the record it names. A repeated create therefore
 * returns the record the first one made, and of two simultaneous creates
 * exactly one writes anything.
 *
 * What a repeated id means is the caller's to decide: return the record as it
 * stands, or replace it. An id can be released, and then used again, or kept
 * by a deleted record that a later create brings back.
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
   * Retrieves the id of the deleted record still holding the given external
   * id, which a create carrying that id brings back.
   */
  public async findDeletedRecordId(
    kind: ExtRecordKind,
    externalId: string,
    trx?: Knex.Transaction,
  ): Promise<number | null> {
    const row = await (trx ?? this.tenantKnex())(TABLE)
      .where({ kind, externalId, live: 1 })
      .whereNotNull('recordId')
      .whereNotNull('deletedAt')
      .first();
    return row ? Number(row.recordId) : null;
  }

  /**
   * Marks the record of an external id deleted. The id stays held, so that a
   * later create carrying it can bring the record back under its old id.
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
   * Takes back the external id of a deleted record for the record about to
   * be re-created under the same id.
   * @returns False when another request has already brought it back.
   */
  public async revive(
    kind: ExtRecordKind,
    externalId: string,
    trx: Knex.Transaction,
  ): Promise<boolean> {
    const changed = await trx(TABLE)
      .where({ kind, externalId, live: 1 })
      .whereNotNull('deletedAt')
      .update({ deletedAt: null });
    return Number(changed) > 0;
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
    const reservationId = await this.reserve(kind, externalId, trx);
    await trx(TABLE).where({ id: reservationId }).update({ recordId });
  }

  /**
   * Releases the external id of a deleted or voided record, so that it can be
   * used again. The released row is kept.
   */
  public async release(
    kind: ExtRecordKind,
    recordId: number,
    trx: Knex.Transaction,
  ): Promise<void> {
    await trx(TABLE)
      .where({ kind, recordId, live: 1 })
      .update({ live: null, releasedAt: trx.fn.now() });
  }

  /**
   * Creates a record at most once per external id.
   *
   * The id is reserved before the record is written. A concurrent create of
   * the same id waits on that reservation: if the first commits, the second
   * fails on the unique constraint, writes nothing, and is answered with the
   * record the first one made.
   */
  public async createOnce<T>(
    options: CreateOnceOptions<T>,
  ): Promise<CreateOnceResult<T>> {
    const { kind, externalId, create, read, trx } = options;

    if (externalId === undefined || externalId === null) {
      const recordId = await this.uow.withTransaction(create, trx);
      return { recordId, record: await read(recordId), created: true };
    }
    this.validate(externalId);

    const existingId = await this.findRecordId(kind, externalId, trx);
    if (existingId !== null) {
      return {
        recordId: existingId,
        record: await read(existingId),
        created: false,
      };
    }
    try {
      const recordId = await this.uow.withTransaction(async (innerTrx) => {
        const reservationId = await this.reserve(kind, externalId, innerTrx);
        const createdId = await create(innerTrx);

        await innerTrx(TABLE)
          .where({ id: reservationId })
          .update({ recordId: createdId });
        return createdId;
      }, trx);

      return { recordId, record: await read(recordId), created: true };
    } catch (error) {
      if (!this.isInUse(error)) throw error;
      // Inside an outer transaction the caller decides what a clash means.
      if (trx) throw error;

      const winnerId = await this.findRecordId(kind, externalId);
      if (winnerId === null) throw error;

      return {
        recordId: winnerId,
        record: await read(winnerId),
        created: false,
      };
    }
  }

  /**
   * Reserves an external id, returning the id of the reservation row.
   */
  private async reserve(
    kind: ExtRecordKind,
    externalId: string,
    trx: Knex.Transaction,
  ): Promise<number> {
    this.validate(externalId);
    // An id held only by a deleted record is given up to the new holder.
    await trx(TABLE)
      .where({ kind, externalId, live: 1 })
      .whereNotNull('deletedAt')
      .update({ live: null, releasedAt: trx.fn.now() });
    try {
      const [id] = await trx(TABLE).insert({
        kind,
        externalId,
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
