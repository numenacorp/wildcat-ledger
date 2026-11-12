import { Knex } from 'knex';
import { Inject, Injectable } from '@nestjs/common';
import { TENANCY_DB_CONNECTION } from '@/modules/Tenancy/TenancyDB/TenancyDB.constants';

const TABLE = 'ext_sequences';

/**
 * Number sequences of an organization.
 *
 * A number is taken outside the transaction of the document it is for. The
 * increment commits at once, so two documents created together get different
 * numbers without one waiting for the other to finish. A document that then
 * fails leaves a gap in the sequence; numbers are unique, not gapless.
 */
@Injectable()
export class ExtSequencesService {
  constructor(
    @Inject(TENANCY_DB_CONNECTION)
    private readonly tenantKnex: () => Knex,
  ) {}

  /** Takes the next `count` numbers of a sequence, returning the first. */
  public async next(name: string, count = 1): Promise<number> {
    const knex = this.tenantKnex();

    // The upsert and the read of the new value must use one connection:
    // LAST_INSERT_ID is kept per connection.
    return knex.transaction(async (trx) => {
      // Identifiers go through `??` so that they are written the way the
      // connection maps table and column names.
      await trx.raw(
        `INSERT INTO ?? (??, ??) VALUES (?, LAST_INSERT_ID(?))
         ON DUPLICATE KEY UPDATE ?? = LAST_INSERT_ID(?? + ?)`,
        [TABLE, 'name', 'value', name, count, 'value', 'value', count],
      );
      const [rows] = await trx.raw('SELECT LAST_INSERT_ID() AS value');
      const last = Number(rows[0].value ?? rows[0].VALUE);
      return last - count + 1;
    });
  }
}
