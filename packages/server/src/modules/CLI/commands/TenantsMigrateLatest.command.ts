import { Command, Option } from 'nest-commander';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PromisePool } from '@supercharge/promise-pool';
import { BaseCommand } from './BaseCommand';

interface TenantsMigrateLatestOptions {
  tenant_id?: string;
}

@Injectable()
@Command({
  name: 'tenants:migrate:latest',
  description: 'Migrate all tenants or the given tenant id.',
})
export class TenantsMigrateLatestCommand extends BaseCommand {
  private readonly MIGRATION_CONCURRENCY = 10;

  constructor(configService: ConfigService) {
    super(configService);
  }

  @Option({
    flags: '-t, --tenant_id [tenant_id]',
    description: 'Which organization id do you migrate.',
  })
  parseTenantId(val: string): string {
    return val;
  }

  async run(
    passedParams: string[],
    options: TenantsMigrateLatestOptions,
  ): Promise<void> {
    try {
      const sysKnex = this.initSystemKnex();
      const tenants = await this.getAllInitializedTenants(sysKnex);
      const tenantsOrgsIds = tenants.map(
        (tenant: any) => tenant.organizationId,
      );

      if (
        options.tenant_id &&
        tenantsOrgsIds.indexOf(options.tenant_id) === -1
      ) {
        this.exit(`The given tenant id ${options.tenant_id} does not exist.`);
      }

      // An organization whose database does not exist (it was deleted, or
      // never finished building) is skipped. Any other failure fails the
      // command, but only once every other organization has been migrated,
      // so that none is cut off halfway through a migration.
      const failures: Array<{ organizationId: string; error: any }> = [];

      const migrateTenant = async (organizationId: string) => {
        const tenantDb = `${this.configService.get('tenantDatabase.dbNamePrefix')}${organizationId}`;
        const tenantKnex = this.initTenantKnex(organizationId);
        try {
          const [batchNo, _log] = await tenantKnex.migrate.latest();

          if (_log.length === 0) {
            this.log('Already up to date');
          }
          this.log(
            `Tenant ${tenantDb} > Batch ${batchNo} run: ${_log.length} migrations`,
          );
          this.log('-------------------');
        } catch (error) {
          if (error?.code === 'ER_BAD_DB_ERROR') {
            this.log(
              `Tenant ${tenantDb} > skipped, the database does not exist`,
            );
            this.log('-------------------');
          } else {
            failures.push({ organizationId, error });
          }
        } finally {
          await tenantKnex.destroy();
        }
      };

      if (!options.tenant_id) {
        await PromisePool.withConcurrency(this.MIGRATION_CONCURRENCY)
          .for(tenants)
          .process((tenant: any) => {
            return migrateTenant(tenant.organizationId);
          });
      } else {
        await migrateTenant(options.tenant_id);
      }
      if (failures.length > 0) {
        failures.forEach(({ organizationId, error }) => {
          console.error(`Tenant ${organizationId} > migration failed:`, error);
        });
        this.exit(`${failures.length} tenant(s) failed to migrate.`);
      }
      this.success('All tenants are migrated.');
    } catch (error) {
      this.exit(error);
    }
  }
}
