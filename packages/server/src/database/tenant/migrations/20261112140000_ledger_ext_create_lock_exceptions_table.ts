/**
 * Lock exceptions: a range of locked days opened for a while, for a
 * correction. Each names its range, its reason, who made it and when it
 * expires, and stays listed after it has expired or been revoked.
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function (knex) {
  await knex.schema.createTable('ext_lock_exceptions', (table) => {
    table.increments('id');
    // Plain dates, both included.
    table.string('from_date', 10).notNullable();
    table.string('to_date', 10).notNullable();
    table.text('reason').notNullable();
    table.string('actor', 255).notNullable();
    // Timestamps are UTC ISO-8601 strings.
    table.string('expires_at', 24).notNullable();
    table.string('revoked_at', 24).nullable();
    table.string('revoked_by', 255).nullable();
    table.string('created_at', 24).notNullable();
  });
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('ext_lock_exceptions');
};
