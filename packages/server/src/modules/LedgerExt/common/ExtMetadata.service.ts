import { Knex } from 'knex';
import { Inject, Injectable } from '@nestjs/common';
import { TENANCY_DB_CONNECTION } from '@/modules/Tenancy/TenancyDB/TenancyDB.constants';
import { ServiceError } from '@/modules/Items/ServiceError';
import {
  ERRORS,
  ExtRecordKind,
  METADATA_MAX_BYTES,
} from '../LedgerExt.constants';

const TABLE = 'ext_metadata';

export type ExtMetadataValue = Record<string, unknown>;

/**
 * Free-form metadata of a record: a JSON object the caller attaches and reads
 * back. The server stores it and never interprets it.
 */
@Injectable()
export class ExtMetadataService {
  constructor(
    @Inject(TENANCY_DB_CONNECTION)
    private readonly tenantKnex: () => Knex,
  ) {}

  /**
   * Replaces the metadata of a record. `null` removes it; `undefined` leaves
   * what is stored untouched.
   */
  public async set(
    kind: ExtRecordKind,
    recordId: number,
    metadata: ExtMetadataValue | null | undefined,
    trx: Knex.Transaction,
  ): Promise<void> {
    if (metadata === undefined) return;

    await trx(TABLE).where({ kind, recordId }).delete();
    if (metadata === null) return;

    await trx(TABLE).insert({
      kind,
      recordId,
      data: this.serialize(metadata),
    });
  }

  public async get(
    kind: ExtRecordKind,
    recordId: number,
    trx?: Knex.Transaction,
  ): Promise<ExtMetadataValue | null> {
    const row = await (trx ?? this.tenantKnex())(TABLE)
      .where({ kind, recordId })
      .first();
    return row ? JSON.parse(row.data) : null;
  }

  /**
   * Retrieves the metadata of several records, keyed by record id.
   */
  public async getMany(
    kind: ExtRecordKind,
    recordIds: number[],
    trx?: Knex.Transaction,
  ): Promise<Map<number, ExtMetadataValue>> {
    const found = new Map<number, ExtMetadataValue>();
    if (recordIds.length === 0) return found;

    const rows = await (trx ?? this.tenantKnex())(TABLE)
      .where({ kind })
      .whereIn('recordId', recordIds);
    rows.forEach((row) =>
      found.set(Number(row.recordId), JSON.parse(row.data)),
    );
    return found;
  }

  public async remove(
    kind: ExtRecordKind,
    recordIds: number | number[],
    trx: Knex.Transaction,
  ): Promise<void> {
    const ids = Array.isArray(recordIds) ? recordIds : [recordIds];
    if (ids.length === 0) return;

    await trx(TABLE).where({ kind }).whereIn('recordId', ids).delete();
  }

  private serialize(metadata: ExtMetadataValue): string {
    const isPlainObject =
      typeof metadata === 'object' &&
      metadata !== null &&
      !Array.isArray(metadata);

    if (!isPlainObject) {
      throw new ServiceError(
        ERRORS.METADATA_NOT_SERIALIZABLE,
        'The metadata must be a JSON object.',
      );
    }
    const data = JSON.stringify(metadata);

    if (Buffer.byteLength(data, 'utf8') > METADATA_MAX_BYTES) {
      throw new ServiceError(
        ERRORS.METADATA_NOT_SERIALIZABLE,
        `The metadata must not exceed ${METADATA_MAX_BYTES} bytes.`,
      );
    }
    return data;
  }
}
