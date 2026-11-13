/**
 * Creates the audit log of the ledger extension: one row for every create,
 * edit, void, delete, archive and restore of the records the extension
 * keeps, with who it was made for and the record as it stood before and
 * after.
 *
 * Bigcapital's own `audit_logs` holds who, when, the action and a number,
 * and cannot hold the values: its metadata is cut off at 8,000 characters.
 * A row here stands on its own. Where Bigcapital's log also has a row for
 * the change, `audit_log_id` points to it.
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function (knex) {
  await knex.schema.createTable('ext_audit_log', (table) => {
    table.increments();
    table.string('action', 40).notNullable();
    table.string('subject', 60).notNullable();
    table.integer('subject_id').unsigned().nullable();
    // The record's own number or reference, kept so that a deleted record
    // can still be named.
    table.string('number', 255).nullable();
    // Who the caller made the change for: the caller's own name for its
    // user, since every call arrives as one platform user.
    table.string('actor', 255).nullable();
    table.integer('user_id').unsigned().nullable();
    table.specificType('before', 'mediumtext').nullable();
    table.specificType('after', 'mediumtext').nullable();
    table.integer('audit_log_id').unsigned().nullable();
    // An ISO-8601 instant, as every instant of the extension is kept.
    table.string('created_at', 24).notNullable();

    table.index(['subject', 'subject_id'], 'ext_audit_log_subject_index');
    table.index(['created_at'], 'ext_audit_log_created_index');
  });
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('ext_audit_log');
};
