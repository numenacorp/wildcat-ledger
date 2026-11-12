/**
 * Makes the link between a document line and a tracking option a record with
 * an id of its own for every kind of line, and gives categories a display
 * name.
 *
 * Until now only the lines of bills and invoices had link rows; a journal
 * line's assignments were Bigcapital's alone, which have no id. Journal lines
 * get link rows here, and a line is held to one option of a category.
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function (knex) {
  await knex.schema.createTable('ext_tracking_category_names', (table) => {
    table.integer('category_id').unsigned().notNullable().primary();
    table.string('name', 255).notNullable();
  });

  // Of two links of one line to one category, the later stands.
  const links = await knex('ext_tracking_links').orderBy('id');
  const latest = new Map();
  links.forEach((link) =>
    latest.set(`${link.lineId}:${link.categoryId}`, link.id),
  );
  const stale = links
    .filter(
      (link) => latest.get(`${link.lineId}:${link.categoryId}`) !== link.id,
    )
    .map((link) => link.id);

  const held = await knex('manual_journal_entry_tracking_categories as t')
    .join('ext_lines as l', 'l.entry_id', 't.manual_journal_entry_id')
    .where('l.kind', 'manual_journal_entry')
    .select(
      'l.id as lineId',
      't.category_id as categoryId',
      't.option_id as optionId',
    );
  const missing = held.filter(
    (row) => !latest.has(`${row.lineId}:${row.categoryId}`),
  );

  for (let i = 0; i < stale.length; i += 1000) {
    await knex('ext_tracking_links')
      .whereIn('id', stale.slice(i, i + 1000))
      .delete();
  }
  for (let i = 0; i < missing.length; i += 1000) {
    await knex('ext_tracking_links').insert(
      missing.slice(i, i + 1000).map((row) => ({
        lineId: row.lineId,
        categoryId: row.categoryId,
        optionId: row.optionId,
      })),
    );
  }
  await knex.schema.alterTable('ext_tracking_links', (table) => {
    table.unique(['line_id', 'category_id'], {
      indexName: 'ext_tracking_links_line_category_unique',
    });
  });
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function (knex) {
  await knex.schema.alterTable('ext_tracking_links', (table) => {
    table.dropUnique(
      ['line_id', 'category_id'],
      'ext_tracking_links_line_category_unique',
    );
  });
  await knex.schema.dropTableIfExists('ext_tracking_category_names');
};
