import * as path from 'path';
import { registerAs } from '@nestjs/config';
import { resolveDatabaseCharset } from './database-charset';
import { resolveDatabaseSsl } from './database-ssl';

export default registerAs('tenantDatabase', () => ({
  client: 'mysql',
  host: process.env.TENANT_DB_HOST || process.env.DB_HOST,
  port: process.env.TENANT_DB_PORT || process.env.DB_PORT || 3306,
  user: process.env.TENANT_DB_USER || process.env.DB_USER,
  password: process.env.TENANT_DB_PASSWORD || process.env.DB_PASSWORD,
  charset: resolveDatabaseCharset(
    process.env.TENANT_DB_CHARSET,
    process.env.DB_CHARSET,
  ),
  ssl: resolveDatabaseSsl(process.env.TENANT_DB_SSL, process.env.DB_SSL),
  dbNamePrefix: process.env.TENANT_DB_NAME_PERFIX || 'bigcapital_tenant_',
  // Connections kept per organization database, per server process.
  poolMax: parseInt(process.env.TENANT_DB_POOL_MAX, 10) || 7,
  migrationsDir: path.join(__dirname, '../../database/tenant/migrations'),
  seedsDir: path.join(__dirname, '../../database/tenant/seeds/core'),
}));
