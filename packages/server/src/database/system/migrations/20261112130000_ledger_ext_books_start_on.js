const moment = require('moment-timezone');

/**
 * The day a workspace's books start becomes a plain date: the day the stored
 * instant fell on in the workspace's time zone, or in UTC where it has none.
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function (knex) {
  const rows = await knex('ext_workspaces as w')
    .leftJoin('tenants_metadata as m', 'm.tenant_id', 'w.tenant_id')
    .whereNotNull('w.books_start_at')
    .select('w.id', 'w.books_start_at as instant', 'm.timezone');

  for (const row of rows) {
    const timezone =
      row.timezone && moment.tz.zone(row.timezone) ? row.timezone : 'UTC';

    await knex('ext_workspaces')
      .where({ id: row.id })
      .update({
        books_start_at: moment.tz(row.instant, timezone).format('YYYY-MM-DD'),
      });
  }
  await knex.raw('ALTER TABLE ?? CHANGE ?? ?? varchar(10) NULL', [
    'ext_workspaces',
    'books_start_at',
    'books_start_on',
  ]);
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function (knex) {
  await knex.raw('ALTER TABLE ?? CHANGE ?? ?? varchar(24) NULL', [
    'ext_workspaces',
    'books_start_on',
    'books_start_at',
  ]);
  await knex('ext_workspaces')
    .whereNotNull('books_start_at')
    .update({
      books_start_at: knex.raw("CONCAT(??, 'T00:00:00.000Z')", [
        'books_start_at',
      ]),
    });
};
