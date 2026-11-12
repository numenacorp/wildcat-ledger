/**
 * Creates the display names of tracking options in the ledger extension.
 *
 * An option is named once, by the value callers match it by. A caller may
 * also give the name it is shown under, which is kept here.
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function (knex) {
  await knex.schema.createTable('ext_tracking_option_names', (table) => {
    table.integer('option_id').unsigned().notNullable().primary();
    table.string('name', 255).notNullable();
  });
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('ext_tracking_option_names');
};
