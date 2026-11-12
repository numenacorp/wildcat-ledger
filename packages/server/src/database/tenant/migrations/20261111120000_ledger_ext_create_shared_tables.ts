/**
 * Creates the tables shared by every part of the ledger extension.
 *
 * The extension keeps its own rows beside Bigcapital's, keyed by the kind and
 * id of the record they belong to. Bigcapital's own tables are not altered.
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function (knex) {
  // Caller-supplied ids of records. `live` is 1 while the id is held and NULL
  // once it has been released; a unique index treats NULLs as distinct, so an
  // id is unique among held ones and free to reuse after. `deleted_at` marks
  // an id still held by a record that has been deleted and can be brought
  // back under the same record id.
  await knex.schema.createTable('ext_external_ids', (table) => {
    table.increments();
    table.string('kind', 40).notNullable();
    table.integer('record_id').unsigned().nullable();
    // A binary collation: external ids that differ only by case are distinct.
    table.specificType('external_id', 'varchar(255) binary').notNullable();
    table.boolean('live').nullable().defaultTo(true);
    table.dateTime('created_at').nullable();
    table.dateTime('released_at').nullable();
    table.dateTime('deleted_at').nullable();

    table.unique(
      ['kind', 'external_id', 'live'],
      'ext_external_ids_live_unique',
    );
    table.index(['kind', 'record_id'], 'ext_external_ids_record_index');
  });

  // Free-form JSON metadata of a record, stored and never interpreted.
  await knex.schema.createTable('ext_metadata', (table) => {
    table.increments();
    table.string('kind', 40).notNullable();
    table.integer('record_id').unsigned().notNullable();
    table.text('data', 'mediumtext').notNullable();

    table.unique(['kind', 'record_id'], 'ext_metadata_record_unique');
  });

  // What is kept about a document beyond Bigcapital's own columns.
  // Instants are UTC ISO-8601 strings, which sort in time order.
  await knex.schema.createTable('ext_documents', (table) => {
    table.increments();
    table.string('kind', 40).notNullable();
    table.integer('record_id').unsigned().notNullable();
    table.string('transacted_at', 24).nullable();
    table.string('payment_method', 60).nullable();
    table.string('reference', 255).nullable();
    table.text('memo').nullable();
    table.string('created_by', 255).nullable();
    table.string('voided_at', 24).nullable();
    table.text('void_snapshot', 'mediumtext').nullable();
    table.dateTime('created_at').nullable();
    table.dateTime('updated_at').nullable();

    table.unique(['kind', 'record_id'], 'ext_documents_record_unique');
    table.index(['kind', 'transacted_at'], 'ext_documents_transacted_index');
    table.index(['kind', 'voided_at'], 'ext_documents_voided_index');
  });

  // Stable identity for document lines, whose own ids change on every edit.
  await knex.schema.createTable('ext_lines', (table) => {
    table.increments();
    table.string('kind', 40).notNullable();
    table.integer('record_id').unsigned().notNullable();
    table.integer('entry_id').unsigned().nullable();
    table.integer('index').unsigned().notNullable();
    table.specificType('external_id', 'varchar(255) binary').nullable();
    table.text('description').nullable();

    table.index(['kind', 'record_id'], 'ext_lines_record_index');
    table.index(['kind', 'entry_id'], 'ext_lines_entry_index');
  });

  // Number sequences, advanced outside the transaction of the document that
  // takes a number, so that documents created at once never share one.
  await knex.schema.createTable('ext_sequences', (table) => {
    table.string('name', 60).notNullable().primary();
    table.bigInteger('value').unsigned().notNullable().defaultTo(0);
  });

  // Per-organization settings of the extension.
  await knex.schema.createTable('ext_settings', (table) => {
    table.string('key', 100).notNullable().primary();
    table.text('value', 'mediumtext').notNullable();
  });
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('ext_settings');
  await knex.schema.dropTableIfExists('ext_sequences');
  await knex.schema.dropTableIfExists('ext_lines');
  await knex.schema.dropTableIfExists('ext_documents');
  await knex.schema.dropTableIfExists('ext_metadata');
  await knex.schema.dropTableIfExists('ext_external_ids');
};
