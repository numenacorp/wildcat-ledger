/**
 * Credit applications: an amount a payment left unapplied, or a credit
 * document, set against a bill or an invoice of the same party. No money
 * moves. Each is dated the later of its source's day and its document's.
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function (knex) {
  await knex.schema.createTable('ext_credit_applications', (table) => {
    table.increments('id');
    // The kind of the payment or of the credit document applied.
    table.string('source_kind', 64).notNullable();
    table.integer('source_id').unsigned().notNullable();
    // The bill or invoice applied to.
    table.integer('document_id').unsigned().notNullable();
    table.decimal('amount', 15, 3).notNullable();
    // A plain date.
    table.string('applied_on', 10).notNullable();
    // The document's lines, each with its share of the amount.
    table.text('lines', 'mediumtext').notNullable();
    // A credit document's own lines and their shares; null for a payment.
    table.text('source_lines', 'mediumtext').nullable();
    table.integer('version').unsigned().notNullable().defaultTo(1);
    table.string('deleted_at', 24).nullable();
    table.timestamps();
    table.index(['source_kind', 'source_id']);
    table.index(['document_id']);
  });
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('ext_credit_applications');
};
