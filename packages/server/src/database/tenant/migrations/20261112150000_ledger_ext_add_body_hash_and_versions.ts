/**
 * Two additions.
 *
 * An external id keeps a hash of the body its record was created with, so
 * that a repeated create can be told from a different one: the same body is
 * a retry and is answered with the record, another body is a conflict.
 * Ids kept from before have no hash, and a repeat of one is a conflict.
 *
 * Each record that can be edited keeps a version, a counter that every
 * change raises. An edit says which version it was made from and is refused
 * when the record has moved on.
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
const VERSIONED = [
  'ext_trade_documents',
  'ext_payments',
  'ext_documents',
  'ext_account_tree',
  'ext_fixed_assets',
  'ext_parties',
];

exports.up = async function (knex) {
  await knex.schema.alterTable('ext_external_ids', (table) => {
    table.string('body_hash', 64).nullable();
  });
  for (const name of VERSIONED) {
    await knex.schema.alterTable(name, (table) => {
      table.integer('version').unsigned().notNullable().defaultTo(1);
    });
  }
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function (knex) {
  for (const name of VERSIONED) {
    await knex.schema.alterTable(name, (table) => {
      table.dropColumn('version');
    });
  }
  await knex.schema.alterTable('ext_external_ids', (table) => {
    table.dropColumn('body_hash');
  });
};

export {};
