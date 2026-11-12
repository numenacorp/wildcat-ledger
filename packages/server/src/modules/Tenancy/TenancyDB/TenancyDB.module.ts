import knex from 'knex';
import * as LRUCache from 'lru-cache';
import { Global, Module } from '@nestjs/common';
import { knexSnakeCaseMappers } from 'objection';
import { ClsModule, ClsService } from 'nestjs-cls';
import { ConfigService } from '@nestjs/config';
import { DATE_ONLY_COLUMNS_OPTIONS } from '@/common/constants/database.constants';
import { TENANCY_DB_CONNECTION } from './TenancyDB.constants';
import { UnitOfWork } from './UnitOfWork.service';

const lruCache = new LRUCache();

export const TenancyDatabaseProxyProvider = ClsModule.forFeatureAsync({
  provide: TENANCY_DB_CONNECTION,
  global: true,
  strict: true,
  inject: [ConfigService, ClsService],
  useFactory: async (configService: ConfigService, cls: ClsService) => () => {
    const organizationId = cls.get('organizationId');
    const database = `bigcapital_tenant_${organizationId}`;
    const cachedInstance = lruCache.get(database);

    if (cachedInstance) {
      return cachedInstance;
    }
    const knexInstance = knex({
      client: configService.get('tenantDatabase.client'),
      connection: {
        host: configService.get('tenantDatabase.host'),
        port: configService.get('tenantDatabase.port'),
        user: configService.get('tenantDatabase.user'),
        password: configService.get('tenantDatabase.password'),
        database,
        charset: configService.get('tenantDatabase.charset'),
        ssl: configService.get<any>('tenantDatabase.ssl'),
        ...DATE_ONLY_COLUMNS_OPTIONS,
      },
      migrations: {
        directory: configService.get('tenantDatabase.migrationsDir'),
        // Compiled output holds `.js` migrations; under a TypeScript runtime
        // (the test runner) the sources are loaded directly.
        loadExtensions: [__filename.endsWith('.ts') ? '.ts' : '.js'],
      },
      seeds: {
        directory: configService.get('tenantDatabase.seedsDir'),
      },
      pool: { min: 0, max: configService.get('tenantDatabase.poolMax') },
      ...knexSnakeCaseMappers({ upperCase: true }),
    });
    lruCache.set(database, knexInstance);

    return knexInstance;
  },
  type: 'function',
});

@Global()
@Module({
  imports: [TenancyDatabaseProxyProvider],
  providers: [UnitOfWork],
  exports: [UnitOfWork],
})
export class TenancyDatabaseModule {}
