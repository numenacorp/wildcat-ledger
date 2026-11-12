/**
 * Adds what invoices and their payments carry beyond bills and theirs: an
 * invoice's own number, and on a payment the customer it came from and the
 * account a redeemed credit balance is taken from.
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function (knex) {
  await knex.schema.alterTable('ext_trade_documents', (table) => {
    table.string('number', 255).nullable();
  });
  await knex.schema.alterTable('ext_payments', (table) => {
    table.integer('party_id').unsigned().nullable();
    table.integer('redemption_account_id').unsigned().nullable();
  });
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function (knex) {
  await knex.schema.alterTable('ext_payments', (table) => {
    table.dropColumns('party_id', 'redemption_account_id');
  });
  await knex.schema.alterTable('ext_trade_documents', (table) => {
    table.dropColumn('number');
  });
};
