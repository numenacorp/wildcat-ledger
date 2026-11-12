/**
 * Creates the tables of fixed assets, their value updates, loans and opening
 * balances in the ledger extension. All four are the extension's own
 * records; their ledger rows are written through Bigcapital's ledger.
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function (knex) {
  await knex.schema.createTable('ext_fixed_assets', (table) => {
    table.increments();
    table.string('name', 255).notNullable();
    table.string('asset_type', 60).notNullable();
    table.decimal('cost', 15, 3).notNullable();
    table.decimal('salvage_value', 15, 3).nullable();
    table.integer('useful_life_months').unsigned().nullable();
    table.integer('account_id').unsigned().notNullable();
    table.integer('accumulated_account_id').unsigned().nullable();
    table.timestamps();
  });

  await knex.schema.createTable('ext_asset_value_updates', (table) => {
    table.increments();
    table.integer('asset_id').unsigned().notNullable();
    table.string('update_type', 60).notNullable();
    table.decimal('amount', 15, 3).notNullable();
    table.string('posted_at', 24).notNullable();
    table.text('note').nullable();
    table.integer('counter_account_id').unsigned().notNullable();
    table.timestamps();

    table.index(['asset_id'], 'ext_asset_value_updates_asset_index');
    table.index(['posted_at'], 'ext_asset_value_updates_posted_index');
  });

  await knex.schema.createTable('ext_loans', (table) => {
    table.increments();
    table.string('name', 255).notNullable();
    table.string('loan_type', 60).notNullable();
    table.string('origination_date', 40).nullable();
    table.decimal('original_principal', 15, 3).nullable();
    table.decimal('credit_limit', 15, 3).nullable();
    table.integer('loan_term_months').unsigned().nullable();
    table.integer('account_id').unsigned().notNullable();
    table.timestamps();
  });

  // One opening entry of one account, against the opening balance equity
  // account. `source` says what made it: an import of opening balances, a
  // fixed asset or a loan. `amount` is debits less credits.
  await knex.schema.createTable('ext_opening_balances', (table) => {
    table.increments();
    table.string('source', 40).notNullable();
    table.integer('source_id').unsigned().nullable();
    table.integer('account_id').unsigned().notNullable();
    table.decimal('amount', 15, 3).notNullable();
    table.string('posted_at', 24).notNullable();
    table.timestamps();

    table.index(['source', 'source_id'], 'ext_opening_balances_source_index');
  });
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('ext_opening_balances');
  await knex.schema.dropTableIfExists('ext_loans');
  await knex.schema.dropTableIfExists('ext_asset_value_updates');
  await knex.schema.dropTableIfExists('ext_fixed_assets');
};
