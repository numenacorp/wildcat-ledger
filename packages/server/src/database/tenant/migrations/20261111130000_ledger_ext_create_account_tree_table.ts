/**
 * Creates the account tree of the ledger extension.
 *
 * Bigcapital requires a child account to have its parent's type and every
 * account name to be unique. The extension keeps accounts flat in Bigcapital
 * and holds the tree, the display name and the account number here, free of
 * those rules. An account without a row here is not part of the chart the
 * extension presents.
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function (knex) {
  await knex.schema.createTable('ext_account_tree', (table) => {
    table.integer('account_id').unsigned().notNullable().primary();
    table.integer('parent_account_id').unsigned().nullable();
    table.string('name', 255).notNullable();
    table.specificType('code', 'varchar(60) binary').nullable();
    table.dateTime('created_at').nullable();
    table.dateTime('updated_at').nullable();

    // Two accounts may carry the same number.
    table.index(['code'], 'ext_account_tree_code_index');
    table.index(['parent_account_id'], 'ext_account_tree_parent_index');
  });

  // Every account a document has ever posted to. A deleted document takes its
  // ledger rows with it; this remembers that the account was used.
  await knex.schema.createTable('ext_posted_accounts', (table) => {
    table.integer('account_id').unsigned().notNullable().primary();
  });
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('ext_posted_accounts');
  await knex.schema.dropTableIfExists('ext_account_tree');
};
