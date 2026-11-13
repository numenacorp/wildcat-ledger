import * as moment from 'moment-timezone';

/**
 * Accounting dates become plain dates.
 *
 * The extension kept the exact instant of each document and worked its
 * calendar day out from it. A document is dated by day and nothing more, so
 * each stored instant becomes its day in the organization's time zone, and
 * the columns are named for what they hold. The table of an instant per
 * ledger row goes: a ledger row's own date is its day.
 *
 * The lock was an instant, with everything before it locked. It becomes the
 * last locked day: the day before the day the old instant fell on.
 *
 * The time zone is read from the system database, which this connection can
 * reach on the same server. Where it cannot be read the days are worked out
 * in UTC.
 */
const COLUMNS: Array<[string, string, string, boolean]> = [
  ['ext_trade_documents', 'posted_at', 'posted_on', false],
  ['ext_trade_documents', 'due_at', 'due_on', true],
  ['ext_payments', 'paid_at', 'paid_on', false],
  ['ext_documents', 'transacted_at', 'transacted_on', true],
  ['ext_asset_value_updates', 'posted_at', 'posted_on', false],
  ['ext_opening_balances', 'posted_at', 'posted_on', false],
];

async function timezoneOf(knex) {
  const system = process.env.SYSTEM_DB_NAME || process.env.DB_NAME;
  if (!system) return 'UTC';

  try {
    const [rows] = await knex.raw(
      `SELECT m.TIMEZONE AS timezone
         FROM \`${system}\`.TENANTS t
         JOIN \`${system}\`.TENANTS_METADATA m ON m.TENANT_ID = t.ID
        WHERE DATABASE() LIKE CONCAT('%', t.ORGANIZATION_ID)
        LIMIT 1`,
    );
    // Read under either spelling: the connection renames result columns.
    const timezone = rows[0] && (rows[0].timezone || rows[0].TIMEZONE);
    return timezone && moment.tz.zone(timezone) ? timezone : 'UTC';
  } catch (error) {
    return 'UTC';
  }
}

/** The name a column's value is returned under. */
const camel = (name) =>
  name.replace(/_(\w)/g, (match, letter) => letter.toUpperCase());

const dayOf = (instant, timezone) =>
  moment.tz(instant, timezone).format('YYYY-MM-DD');

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function (knex) {
  const timezone = await timezoneOf(knex);

  for (const [table, from, to, nullable] of COLUMNS) {
    const values = await knex(table)
      .distinct(from)
      .whereNotNull(from)
      .whereRaw('CHAR_LENGTH(??) > 10', [from]);

    for (const row of values) {
      const instant = row[camel(from)] ?? row[from];
      await knex(table)
        .where(from, instant)
        .update({ [from]: dayOf(instant, timezone) });
    }
    await knex.raw(
      `ALTER TABLE ?? CHANGE ?? ?? varchar(10) ${nullable ? 'NULL' : 'NOT NULL'}`,
      [table, from, to],
    );
  }

  const closing = await knex('ext_settings')
    .where({ key: 'closing_at' })
    .first();
  if (closing) {
    const instant = JSON.parse(closing.value);
    const lockedThrough = instant
      ? moment
          .utc(dayOf(instant, timezone), 'YYYY-MM-DD', true)
          .subtract(1, 'day')
          .format('YYYY-MM-DD')
      : null;

    await knex('ext_settings').where({ key: 'locked_through' }).delete();
    await knex('ext_settings')
      .where({ key: 'closing_at' })
      .update({ key: 'locked_through', value: JSON.stringify(lockedThrough) });
  }
  await knex.schema.dropTableIfExists('ext_row_instants');
};

/**
 * The time of day is gone and does not come back: a day returns as its
 * first instant in UTC.
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function (knex) {
  await knex.schema.createTable('ext_row_instants', (table) => {
    table.integer('account_transaction_id').unsigned().primary();
    table.string('posted_at', 24).notNullable();
  });
  for (const [table, from, to, nullable] of COLUMNS) {
    await knex.raw(
      `ALTER TABLE ?? CHANGE ?? ?? varchar(24) ${nullable ? 'NULL' : 'NOT NULL'}`,
      [table, to, from],
    );
    await knex(table)
      .whereNotNull(from)
      .update({ [from]: knex.raw("CONCAT(??, 'T00:00:00.000Z')", [from]) });
  }
  const locked = await knex('ext_settings')
    .where({ key: 'locked_through' })
    .first();
  if (locked) {
    const day = JSON.parse(locked.value);
    const instant = day
      ? moment.utc(day, 'YYYY-MM-DD', true).add(1, 'day').toISOString()
      : null;

    await knex('ext_settings')
      .where({ key: 'locked_through' })
      .update({ key: 'closing_at', value: JSON.stringify(instant) });
  }
};
