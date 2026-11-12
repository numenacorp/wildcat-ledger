/**
 * Creates the table the ledger extension keeps about each workspace
 * (organization): the caller's own id of it, and attributes Bigcapital's
 * tenants table has no column for.
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = function (knex) {
  return knex.schema.createTable('ext_workspaces', (table) => {
    table.bigIncrements('id');
    table
      .bigInteger('tenant_id')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable('tenants')
      .onDelete('CASCADE');
    table.integer('owner_user_id').unsigned().notNullable();

    // A binary collation: external ids that differ only by case are distinct.
    // `live` is 1 while the workspace exists and NULL once it is deleted, so
    // an id is unique among existing workspaces and free to reuse after.
    table.specificType('external_id', 'varchar(255) binary').nullable();
    table.boolean('live').nullable().defaultTo(true);

    table.string('status', 20).notNullable().defaultTo('building');
    table.string('build_job_id', 100).nullable();
    table.text('build_error').nullable();

    table.string('reporting_basis', 20).notNullable().defaultTo('accrual');
    // Instants are UTC ISO-8601 strings.
    table.string('books_start_at', 24).nullable();
    table.string('inactive_at', 24).nullable();

    // The chart of accounts requested at creation, held until the
    // organization database exists and the chart has been created in it.
    table.text('pending_accounts', 'mediumtext').nullable();

    table.timestamps();

    table.unique(['tenant_id'], 'ext_workspaces_tenant_unique');
    table.unique(
      ['owner_user_id', 'external_id', 'live'],
      'ext_workspaces_live_unique',
    );
  });
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = function (knex) {
  return knex.schema.dropTableIfExists('ext_workspaces');
};
