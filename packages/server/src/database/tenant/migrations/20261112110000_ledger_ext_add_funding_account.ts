/**
 * Lets the entry a fixed asset or a loan is recorded with name the account
 * its other side goes to: the bank account an asset was bought from, or the
 * one a loan was received into. With none named the other side is the
 * opening balance equity account, as before, which is right only for what
 * was already held when the books began.
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function (knex) {
  await knex.schema.alterTable('ext_opening_balances', (table) => {
    table.integer('against_account_id').unsigned().nullable();
  });
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function (knex) {
  await knex.schema.alterTable('ext_opening_balances', (table) => {
    table.dropColumn('against_account_id');
  });
};
