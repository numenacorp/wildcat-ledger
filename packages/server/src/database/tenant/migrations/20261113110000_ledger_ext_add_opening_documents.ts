/**
 * An opening document: a bill, an invoice or a credit still open when the
 * books began, brought in as a document of its own so that it can be aged
 * and paid.
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function (knex) {
  await knex.schema.alterTable('ext_trade_documents', (table) => {
    table.boolean('opening').notNullable().defaultTo(false);
  });
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function (knex) {
  await knex.schema.alterTable('ext_trade_documents', (table) => {
    table.dropColumn('opening');
  });
};
