import { Knex } from 'knex';
import { Inject, Injectable } from '@nestjs/common';
import { TENANCY_DB_CONNECTION } from '@/modules/Tenancy/TenancyDB/TenancyDB.constants';

const TABLE = 'ext_settings';

/**
 * Per-organization settings of the extension: a small key and JSON value
 * store kept in the organization's own database.
 */
@Injectable()
export class ExtSettingsService {
  constructor(
    @Inject(TENANCY_DB_CONNECTION)
    private readonly tenantKnex: () => Knex,
  ) {}

  public async get<T = unknown>(
    key: string,
    trx?: Knex.Transaction,
  ): Promise<T | null> {
    const row = await (trx ?? this.tenantKnex())(TABLE).where({ key }).first();
    return row ? (JSON.parse(row.value) as T) : null;
  }

  public async set(
    key: string,
    value: unknown,
    trx: Knex.Transaction,
  ): Promise<void> {
    await trx(TABLE).where({ key }).delete();
    if (value === null || value === undefined) return;

    await trx(TABLE).insert({ key, value: JSON.stringify(value) });
  }

  public async all(trx?: Knex.Transaction): Promise<Record<string, unknown>> {
    const rows = await (trx ?? this.tenantKnex())(TABLE);
    return Object.fromEntries(
      rows.map((row) => [row.key, JSON.parse(row.value)]),
    );
  }
}
