import { NestExpressApplication } from '@nestjs/platform-express';
import { applyRequestBodyLimit } from '../../src/common/request-body';
import request = require('supertest');
import { randomBytes } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ClsService } from 'nestjs-cls';
import { AppModule } from '../../src/modules/App/App.module';
import { TenancyContext } from '../../src/modules/Tenancy/TenancyContext.service';
import { TenantRepository } from '../../src/modules/System/repositories/Tenant.repository';
import { BuildOrganizationService } from '../../src/modules/Organization/commands/BuildOrganization.service';
import { transformBuildDto } from '../../src/modules/Organization/Organization.utils';

/**
 * Test harness for the ledger tests.
 *
 * Unlike the shared-tenant e2e specs, every spec file that uses this harness
 * gets an organization of its own: a fresh user is signed up, its
 * organization database is built, and the organization is dropped again when
 * the file finishes. Spec files therefore never see each other's data and can
 * assert on absolute report figures.
 */
export interface TestOrganization {
  app: INestApplication;
  userId: number;
  organizationId: string;
  token: string;
  headers: () => Record<string, string>;
  /** Runs `work` with the tenancy context of the organization set. */
  inTenant: <T>(work: () => Promise<T>) => Promise<T>;
  /** Milliseconds the organization database took to build. */
  buildMs: number;
}

// Tests run on a Redis of their own (see docker-compose.yml), so that they
// never take, or lose, queued jobs of a server running beside them.
const TEST_REDIS_PORT = process.env.LEDGER_TEST_REDIS_PORT ?? '36380';
process.env.QUEUE_PORT = TEST_REDIS_PORT;
process.env.REDIS_PORT = TEST_REDIS_PORT;
// Each spec file gets job queues of its own. A queue worker of an application
// closed by an earlier spec file can outlive it for a moment; with a prefix
// per file it has nothing of the next file's to take.
process.env.QUEUE_PREFIX = `ledger-test-${randomBytes(6).toString('hex')}`;

const PASSWORD = 'ledger-test-password';

export async function createTestApp(): Promise<INestApplication> {
  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleFixture.createNestApplication<NestExpressApplication>({
    rawBody: true,
  });
  applyRequestBodyLimit(app, '/ledger');
  await app.init();
  return app;
}

export interface TestUser {
  userId: number;
  email: string;
  token: string;
  /** Headers of a call that is not made under an organization. */
  headers: () => Record<string, string>;
}

/** Signs up a user and signs it in. Its own organization is left unbuilt. */
export async function createTestUser(app: INestApplication): Promise<TestUser> {
  const email = `ledger-${randomBytes(6).toString('hex')}@example.com`;
  const http = () => request(app.getHttpServer());

  await http()
    .post('/auth/signup')
    .send({ firstName: 'Ledger', lastName: 'Test', email, password: PASSWORD })
    .expect(201);

  const signin = await http()
    .post('/auth/signin')
    .send({ email, password: PASSWORD })
    .expect(201);

  const token: string = signin.body.access_token;
  return {
    userId: signin.body.user_id,
    email,
    token,
    headers: () => ({ Authorization: `Bearer ${token}` }),
  };
}

/** Runs a query against the system database. */
export function systemKnex(app: INestApplication) {
  const {
    SystemKnexConnection,
  } = require('../../src/modules/System/SystemDB/SystemDB.constants');
  return app.get(SystemKnexConnection, { strict: false });
}

/** Runs work with the tenancy context of any organization set. */
export function inOrganization<T>(
  app: INestApplication,
  organizationId: string,
  userId: number,
  work: () => Promise<T>,
): Promise<T> {
  const cls = app.get(ClsService, { strict: false });
  return cls.run(async () => {
    cls.set('organizationId', organizationId);
    cls.set('userId', userId);
    await cls.resolveProxyProviders();
    return work();
  });
}

/** Reads rows of a table of any organization's database. */
export function organizationRows(
  app: INestApplication,
  organizationId: string,
  userId: number,
  table: string,
  where: Record<string, unknown> = {},
): Promise<any[]> {
  const {
    TENANCY_DB_CONNECTION,
  } = require('../../src/modules/Tenancy/TenancyDB/TenancyDB.constants');
  return inOrganization(app, organizationId, userId, async () => {
    const knex = app.get(TENANCY_DB_CONNECTION, { strict: false })();
    return knex(table).where(where);
  });
}

export interface TestWorkspace {
  app: INestApplication;
  user: TestUser;
  /** The workspace as the create route answered it. */
  workspace: any;
  /** Headers of a call made under the workspace. */
  headers: () => Record<string, string>;
  rows: (table: string, where?: Record<string, unknown>) => Promise<any[]>;
}

/**
 * Creates a workspace through the extension's own route, for a new user.
 */
export async function createTestWorkspace(
  app: INestApplication,
  body: Record<string, unknown> = {},
  user?: TestUser,
): Promise<TestWorkspace> {
  const owner = user ?? (await createTestUser(app));
  const payload = {
    external_id: `ws:${randomBytes(8).toString('hex')}`,
    name: 'Ledger Test Workspace',
    country: 'US',
    base_currency: 'USD',
    timezone: 'America/Chicago',
    ...body,
  };
  const send = () =>
    request(app.getHttpServer())
      .post('/ledger/workspaces')
      .set(owner.headers())
      .send(payload);
  let workspace = (await send().expect(201)).body.data;

  // On a busy machine a build can outlast one request's wait. The same create
  // sent again answers with the same workspace and waits on it again.
  const deadline = Date.now() + 180_000;
  while (workspace.status === 'building' && Date.now() < deadline) {
    workspace = (await send().expect(200)).body.data;
  }

  if (workspace.status !== 'ready') {
    throw new Error(`The workspace is ${workspace.status}, not ready.`);
  }
  return {
    app,
    user: owner,
    workspace,
    headers: () => ({
      ...owner.headers(),
      'organization-id': workspace.organization_id,
    }),
    rows: (table, where = {}) =>
      organizationRows(
        app,
        workspace.organization_id,
        owner.userId,
        table,
        where,
      ),
  };
}

/**
 * Makes a tracking category with the options named, or adds the options it
 * lacks. A write takes only tags that exist, so a spec makes its tags before
 * it uses them.
 */
export async function createTestTags(
  app: INestApplication,
  headers: Record<string, string>,
  category: string,
  options: string[],
): Promise<any> {
  const res = await request(app.getHttpServer())
    .post('/ledger/tracking-categories')
    .set(headers)
    .send({ name: category, options: options.map((name) => ({ name })) });

  if (res.status !== 201 && res.status !== 200) {
    throw new Error(`The category ${category} was not made: ${res.status}.`);
  }
  return res.body.data;
}

export async function createTestOrganization(
  app: INestApplication,
): Promise<TestOrganization> {
  const email = `ledger-${randomBytes(6).toString('hex')}@example.com`;
  const http = () => request(app.getHttpServer());

  await http()
    .post('/auth/signup')
    .send({ firstName: 'Ledger', lastName: 'Test', email, password: PASSWORD })
    .expect(201);

  const signin = await http()
    .post('/auth/signin')
    .send({ email, password: PASSWORD })
    .expect(201);

  const token: string = signin.body.access_token;
  const organizationId: string = signin.body.organization_id;
  const userId: number = signin.body.user_id;

  const headers = () => ({
    'organization-id': organizationId,
    Authorization: `Bearer ${token}`,
  });

  const cls = app.get(ClsService, { strict: false });
  const inTenant = <T>(work: () => Promise<T>): Promise<T> =>
    cls.run(async () => {
      cls.set('organizationId', organizationId);
      cls.set('userId', userId);
      await cls.resolveProxyProviders();
      return work();
    });

  // The organization is built here, in-process, rather than through the build
  // queue: a queue worker of an application closed by an earlier spec file can
  // outlive it for a moment and take the job.
  const startedAt = Date.now();
  await inTenant(async () => {
    const tenancy = app.get(TenancyContext, { strict: false });
    const tenants = app.get(TenantRepository, { strict: false });
    const builder = app.get(BuildOrganizationService, { strict: false });

    const tenant = await tenancy.getTenant();
    const buildDto = transformBuildDto({
      name: 'Ledger Test Organization',
      location: 'US',
      baseCurrency: 'USD',
      timezone: 'America/Chicago',
      fiscalYear: 'january',
      language: 'en',
    } as any);

    await tenants.saveMetadata(tenant.id, buildDto);
    await builder.build(buildDto);
  });
  const buildMs = Date.now() - startedAt;

  return { app, userId, organizationId, token, headers, inTenant, buildMs };
}

/**
 * Drops the organization database. The organization rows of the system
 * database are left in place; they are small and carry no books.
 */
export async function dropTestOrganization(org: TestOrganization) {
  await dropOrganizations(org.app, [org.organizationId]);
}

/**
 * Drops organization databases and removes the organizations from the system
 * database.
 */
export async function dropOrganizations(
  app: INestApplication,
  organizationIds: string[],
) {
  const knex = systemKnex(app);

  for (const organizationId of organizationIds) {
    await knex.raw(
      `DROP DATABASE IF EXISTS \`bigcapital_tenant_${organizationId}\``,
    );
    const tenant = await knex('tenants').where({ organizationId }).first();
    if (!tenant) continue;

    await knex('subscription_plan_subscriptions')
      .where({ tenantId: tenant.id })
      .delete();
    // A user signed up for a test belongs to the organization made with it.
    await knex('users').where({ tenantId: tenant.id }).delete();
    await knex('tenants_metadata').where({ tenantId: tenant.id }).delete();
    await knex('tenants').where({ id: tenant.id }).delete();
  }
}

export interface TestAccount {
  id: number;
  name: string;
  code: string;
  account_type: string;
  slug: string;
}

export async function listAccounts(
  org: TestOrganization,
): Promise<TestAccount[]> {
  const res = await request(org.app.getHttpServer())
    .get('/accounts')
    .set(org.headers())
    .expect(200);
  return res.body.accounts ?? res.body;
}

/** Reads rows of a table straight from the organization's database. */
export async function tableRows(
  org: TestOrganization,
  table: string,
  where: Record<string, unknown> = {},
): Promise<any[]> {
  const {
    TENANCY_DB_CONNECTION,
  } = require('../../src/modules/Tenancy/TenancyDB/TenancyDB.constants');
  return org.inTenant(async () => {
    const knex = org.app.get(TENANCY_DB_CONNECTION, { strict: false })();
    return knex(table).where(where);
  });
}

/** Reads the ledger rows straight from the organization's database. */
export const ledgerRows = (
  org: TestOrganization,
  where: Record<string, unknown> = {},
): Promise<any[]> => tableRows(org, 'accounts_transactions', where);

/** The routes that change a record and so name the version it was read at. */
const VERSIONED_ROUTE =
  /^(\/ledger\/(?:bills|invoices|bill-payments|invoice-payments|vendor-credits|credit-notes|credit-applications|manual-journals|accounts|fixed-assets|vendors|customers)\/\d+)(\/(?:void|archive|restore|applications))?$/;

/**
 * Sends a write as a spec's `post`, `put` and `del` do.
 *
 * A change to a record names the version it was made from. A spec that is
 * not about versions makes its change from the record as it is now: the
 * record is read first and its version sent. A call that names a version
 * itself, in its body or its query, is sent as it is, and so is every call
 * that changes no record. A record that cannot be read is sent no version,
 * so the route answers for itself.
 *
 * What is returned can be awaited and takes `.expect(status)`, as a
 * supertest call does.
 */
export function change(
  app: INestApplication,
  method: 'post' | 'put' | 'delete',
  path: string,
  headers: Record<string, string>,
  body?: unknown,
): any {
  const http = () => request(app.getHttpServer());
  const send = (version?: number) => {
    if (method === 'delete') {
      const call = http().delete(path).set(headers);
      return version === undefined ? call : call.query({ version });
    }
    const sent =
      version === undefined
        ? body
        : { ...((body as Record<string, unknown>) ?? {}), version };
    return http()
      [method](path)
      .set(headers)
      .send(sent as any);
  };
  const [bare] = path.split('?');
  const match = VERSIONED_ROUTE.exec(bare);
  const named =
    path.includes('version=') ||
    (body !== null &&
      typeof body === 'object' &&
      'version' in (body as Record<string, unknown>));
  const changesRecord =
    match !== null &&
    (method === 'post' ? match[2] !== undefined : match[2] === undefined);

  if (!changesRecord || named) return send();

  let expected: number | undefined;
  const call = {
    expect(status: number) {
      expected = status;
      return call;
    },
    then(
      resolve: (value: unknown) => unknown,
      reject?: (e: unknown) => unknown,
    ) {
      return http()
        .get(match[1])
        .set(headers)
        .then((read) => {
          const sent = send(read.body?.data?.version);
          return expected === undefined ? sent : sent.expect(expected);
        })
        .then(resolve, reject);
    },
  };
  return call;
}
