/**
 * Creates the tables of bills, invoices and their payments in the ledger
 * extension.
 *
 * These documents are the extension's own. Their ledger rows are written to
 * Bigcapital's ledger, each row with its own exact instant where a document
 * posts on more than one day.
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function (knex) {
  // What the caller said about a vendor or customer. Bigcapital's own contact
  // row carries the balance.
  await knex.schema.createTable('ext_parties', (table) => {
    table.integer('contact_id').unsigned().notNullable().primary();
    table.string('kind', 40).notNullable();
    table.string('company_name', 255).nullable();
    table.string('individual_name', 255).nullable();
    table.string('email', 255).nullable();
    table.string('mobile_phone', 60).nullable();
    table.string('office_phone', 60).nullable();
    table.text('address_string').nullable();
    table.text('notes').nullable();
    table.dateTime('created_at').nullable();
    table.dateTime('updated_at').nullable();
  });

  // A bill or an invoice. Instants are UTC ISO-8601 strings.
  await knex.schema.createTable('ext_trade_documents', (table) => {
    table.increments();
    table.string('kind', 40).notNullable();
    table.integer('party_id').unsigned().notNullable();
    table.string('posted_at', 24).notNullable();
    table.string('due_at', 24).nullable();
    table.string('terms', 40).nullable();
    table.string('reference', 255).nullable();
    table.text('note').nullable();
    table.decimal('amount', 15, 3).notNullable().defaultTo(0);
    table.string('voided_at', 24).nullable();
    table.dateTime('created_at').nullable();
    table.dateTime('updated_at').nullable();

    table.index(['kind', 'posted_at'], 'ext_trade_documents_posted_index');
    table.index(['kind', 'party_id'], 'ext_trade_documents_party_index');
  });

  // The line of a bill or invoice, beside its stable identity in ext_lines.
  await knex.schema.alterTable('ext_lines', (table) => {
    table.integer('account_id').unsigned().nullable();
    table.string('item', 255).nullable();
    table.string('rate', 40).nullable();
    table.string('quantity', 40).nullable();
    table.decimal('amount', 15, 3).nullable();
  });

  // Tracking options named on a document line.
  await knex.schema.createTable('ext_tracking_links', (table) => {
    table.increments();
    table.integer('line_id').unsigned().notNullable();
    table.integer('category_id').unsigned().notNullable();
    table.integer('option_id').unsigned().notNullable();

    table.index(['line_id'], 'ext_tracking_links_line_index');
  });

  // A payment of bills or of invoices. A deleted payment is kept.
  await knex.schema.createTable('ext_payments', (table) => {
    table.increments();
    table.string('kind', 40).notNullable();
    table.string('paid_at', 24).notNullable();
    table.string('method', 60).nullable();
    table.string('processor', 60).nullable();
    table.decimal('amount', 15, 3).notNullable().defaultTo(0);
    table.integer('account_id').unsigned().nullable();
    table.string('reference', 255).nullable();
    table.text('note').nullable();
    table.string('deleted_at', 24).nullable();
    table.dateTime('created_at').nullable();
    table.dateTime('updated_at').nullable();

    table.index(['kind', 'paid_at'], 'ext_payments_paid_index');
  });

  // What a payment pays of one document. `lines` is the document's lines as
  // they stood when the payment was made, as JSON.
  await knex.schema.createTable('ext_payment_allocations', (table) => {
    table.increments();
    table.integer('payment_id').unsigned().notNullable();
    table.integer('document_id').unsigned().notNullable();
    table.integer('index').unsigned().notNullable();
    table.decimal('amount', 15, 3).notNullable();
    table.text('lines', 'mediumtext').notNullable();

    table.index(['payment_id'], 'ext_payment_allocations_payment_index');
    table.index(['document_id'], 'ext_payment_allocations_document_index');
  });

  // The exact instant of a ledger row, where its document posts rows on more
  // than one day.
  await knex.schema.createTable('ext_row_instants', (table) => {
    table.integer('account_transaction_id').unsigned().notNullable().primary();
    table.string('posted_at', 24).notNullable();
  });
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('ext_row_instants');
  await knex.schema.dropTableIfExists('ext_payment_allocations');
  await knex.schema.dropTableIfExists('ext_payments');
  await knex.schema.dropTableIfExists('ext_tracking_links');
  await knex.schema.alterTable('ext_lines', (table) => {
    table.dropColumns('account_id', 'item', 'rate', 'quantity', 'amount');
  });
  await knex.schema.dropTableIfExists('ext_trade_documents');
  await knex.schema.dropTableIfExists('ext_parties');
};
