/**
 * Lets a part of a payment be paid to an account in place of a document:
 * the rest of a check that is more than the invoices it pays, kept as the
 * customer's credit. Such a part names the account, and may carry a memo.
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function (knex) {
  await knex.schema.alterTable('ext_payment_allocations', (table) => {
    table.integer('document_id').unsigned().nullable().alter();
    table.integer('account_id').unsigned().nullable();
    table.text('memo').nullable();
  });
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function (knex) {
  await knex('ext_payment_allocations').whereNull('document_id').delete();
  await knex.schema.alterTable('ext_payment_allocations', (table) => {
    table.dropColumns('account_id', 'memo');
    table.integer('document_id').unsigned().notNullable().alter();
  });
};
