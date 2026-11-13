import request = require('supertest');
import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import {
  createTestApp,
  createTestUser,
  dropOrganizations,
  organizationRows,
  systemKnex,
  TestUser,
} from './harness';
import { LedgerWorkspacesService } from '../../src/modules/LedgerExt/Workspaces/LedgerWorkspaces.service';

/** Accounts Bigcapital seeds into every new organization. */
const SEEDED_ACCOUNTS = 34;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A chart of seven accounts: two share a name, one is a child of an account of
 * another type of the same root, and four stand for accounts Bigcapital already has (the
 * receivable and payable accounts by type, two equity accounts by slug).
 */
const chart = () => [
  { code: '1000', name: 'Cash', account_type: 'cash' },
  {
    code: '1010',
    name: 'Cash',
    account_type: 'cash',
    parent_code: '1000',
    metadata: {
      label: 'Operating — “main” 😀',
      // Keys in every style: they are the caller's data and come back as sent.
      inServiceDate: '2026-01-01',
      snake_key: 1,
      'X-Ref': 'a',
      nested: { camelKey: true, snake_key: [{ innerKey: 1 }] },
    },
  },
  {
    code: '1200',
    name: 'Trade Receivables',
    account_type: 'accounts-receivable',
  },
  { code: '2010', name: 'Trade Payables', account_type: 'accounts-payable' },
  {
    code: '3900',
    name: 'Opening Balances',
    account_type: 'equity',
    slug: 'opening-balance-equity',
  },
  {
    code: '3949',
    name: 'Retained Earnings',
    account_type: 'equity',
    slug: 'retained-earnings',
  },
  {
    code: '1500',
    name: 'Equipment',
    account_type: 'fixed-asset',
    parent_code: '1010',
  },
];

describe('Ledger extension: workspaces', () => {
  let app: INestApplication;
  let user: TestUser;
  const createdIds: number[] = [];

  const http = () => request(app.getHttpServer());
  const body = (over: Record<string, unknown> = {}) => ({
    external_id: `ws:${randomUUID()}`,
    name: 'Birchline Goods',
    country: 'US',
    base_currency: 'USD',
    timezone: 'America/Chicago',
    ...over,
  });
  const create = async (
    payload: Record<string, unknown>,
    as: TestUser = user,
  ) => {
    const res = await http()
      .post('/ledger/workspaces')
      .set(as.headers())
      .send(payload);
    if (res.body?.data?.id) createdIds.push(res.body.data.id);
    return res;
  };
  const rows = (workspace: any, table: string, where = {}) =>
    organizationRows(app, workspace.organization_id, user.userId, table, where);
  const databaseExists = async (organizationId: string) => {
    const [found] = await systemKnex(app).raw(
      'SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME = ?',
      [`bigcapital_tenant_${organizationId}`],
    );
    return found.length > 0;
  };

  beforeAll(async () => {
    app = await createTestApp();
    user = await createTestUser(app);
  });

  afterAll(async () => {
    // Drops the databases of the workspaces this file made.
    const tenants = await systemKnex(app)('tenants').whereIn(
      'id',
      createdIds.length ? createdIds : [0],
    );
    await dropOrganizations(
      app,
      tenants.map((tenant) => tenant.organizationId),
    );
    await app.close();
  });

  describe('create with a chart', () => {
    let workspace: any;
    let payload: Record<string, unknown>;

    beforeAll(async () => {
      payload = body({
        reporting_basis: 'cash',
        books_start_on: '2026-01-01',
        accounts: chart(),
      });
      const res = await create(payload);
      expect(res.status).toBe(201);
      workspace = res.body.data;
    });

    it('answers with the workspace, ready', () => {
      expect(workspace).toEqual({
        id: expect.any(Number),
        organization_id: expect.any(String),
        external_id: payload.external_id,
        name: 'Birchline Goods',
        country: 'US',
        base_currency: 'USD',
        timezone: 'America/Chicago',
        reporting_basis: 'cash',
        // Midnight in Chicago in January is 06:00 UTC.
        books_start_on: '2026-01-01',
        // The fiscal year starts in January unless the create says otherwise.
        fiscal_year_start_month: 1,
        inactive_at: null,
        status: 'ready',
      });
    });

    it('presents the seven accounts of the chart, and nothing else', async () => {
      const tree = await rows(workspace, 'ext_account_tree');
      const byCode = Object.fromEntries(tree.map((n) => [n.code, n]));

      expect(tree).toHaveLength(7);
      expect(tree.filter((n) => n.name === 'Cash')).toHaveLength(2);
      expect(byCode['1010'].parentAccountId).toBe(byCode['1000'].accountId);
      // A child of an account of another type: Bigcapital itself would refuse it.
      expect(byCode['1500'].parentAccountId).toBe(byCode['1010'].accountId);
      expect(byCode['1000'].parentAccountId).toBeNull();
      expect(tree.filter((n) => n.code === null)).toHaveLength(0);
    });

    it('reuses the four accounts Bigcapital already has instead of making twins', async () => {
      const accounts = await rows(workspace, 'accounts');
      const tree = await rows(workspace, 'ext_account_tree');
      const accountOf = (code: string) =>
        accounts.find(
          (a) => a.id === tree.find((n) => n.code === code).accountId,
        );

      // 34 seeded, plus three new chart accounts (1000, 1010, 1500). The
      // other four chart accounts are seeded ones.
      expect(accounts).toHaveLength(SEEDED_ACCOUNTS + 3);
      expect(accountOf('1200').slug).toBe('accounts-receivable');
      expect(accountOf('2010').slug).toBe('accounts-payable');
      expect(accountOf('3900').slug).toBe('opening-balance-equity');
      expect(accountOf('3949').slug).toBe('retained-earnings');
      expect(
        accounts.filter((a) => a.accountType === 'accounts-receivable'),
      ).toHaveLength(1);
      expect(
        accounts.filter((a) => a.accountType === 'accounts-payable'),
      ).toHaveLength(1);
      expect(accountOf('1500').accountType).toBe('fixed-asset');
      // Flat in Bigcapital: no account has a parent there.
      expect(accounts.filter((a) => a.parentAccountId)).toHaveLength(0);
    });

    it('keeps each account metadata as given', async () => {
      const tree = await rows(workspace, 'ext_account_tree');
      const accountId = tree.find((n) => n.code === '1010').accountId;
      const stored = await rows(workspace, 'ext_metadata', { kind: 'account' });

      expect(stored).toHaveLength(1);
      expect(stored[0].recordId).toBe(accountId);
      expect(JSON.parse(stored[0].data)).toEqual({
        label: 'Operating — “main” 😀',
        inServiceDate: '2026-01-01',
        snake_key: 1,
        'X-Ref': 'a',
        nested: { camelKey: true, snake_key: [{ innerKey: 1 }] },
      });
    });

    it('creates the helper records and records their ids', async () => {
      const settings = Object.fromEntries(
        (await rows(workspace, 'ext_settings')).map((s) => [
          s.key,
          JSON.parse(s.value),
        ]),
      );
      expect(settings.workspace_provisioned).toBe(true);

      expect(settings.transit_account_id).toBeUndefined();
      expect(
        await rows(workspace, 'items', { id: settings.generic_item_id }),
      ).toHaveLength(1);
      expect(await rows(workspace, 'items')).toHaveLength(1);

      const contacts = await rows(workspace, 'contacts');
      expect(contacts.map((c) => [c.id, c.contactService]).sort()).toEqual(
        [
          [settings.placeholder_customer_id, 'customer'],
          [settings.placeholder_vendor_id, 'vendor'],
        ].sort(),
      );
    });

    it('switches tracking categories on', async () => {
      await http()
        .get('/tracking-categories')
        .set({
          ...user.headers(),
          'organization-id': workspace.organization_id,
        })
        .expect(200);
    });

    it('posts nothing to the ledger', async () => {
      expect(await rows(workspace, 'accounts_transactions')).toHaveLength(0);
    });

    it('a repeat with a different body returns the same workspace and changes nothing', async () => {
      const before = (await rows(workspace, 'accounts')).length;
      const res = await create({
        ...body({ external_id: payload.external_id }),
        name: 'A Different Name',
        reporting_basis: 'accrual',
        accounts: [{ code: '9', name: 'Other', account_type: 'expense' }],
      });
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual(workspace);
      expect(await rows(workspace, 'accounts')).toHaveLength(before);
    });

    it('is read back by id and found by external id', async () => {
      const read = await http()
        .get(`/ledger/workspaces/${workspace.id}`)
        .set(user.headers())
        .expect(200);
      expect(read.body.data).toEqual(workspace);

      const found = await http()
        .get('/ledger/workspaces')
        .query({ external_id: payload.external_id })
        .set(user.headers())
        .expect(200);
      expect(found.body).toEqual({
        data: [workspace],
        pagination: { total: 1, page: 1, page_size: 50 },
      });
    });

    it('is not visible to another user', async () => {
      const other = await createTestUser(app);

      const read = await http()
        .get(`/ledger/workspaces/${workspace.id}`)
        .set(other.headers());
      expect(read.status).toBe(404);
      expect(read.body.errors[0].type).toBe('WORKSPACE_NOT_FOUND');

      const found = await http()
        .get('/ledger/workspaces')
        .query({ external_id: payload.external_id })
        .set(other.headers())
        .expect(200);
      expect(found.body.data).toEqual([]);

      // The other user may use the same external id for a workspace of its own.
      await http()
        .put(`/ledger/workspaces/${workspace.id}/inactivate`)
        .set(other.headers())
        .expect(404);
    });

    it('updates the start of the books', async () => {
      const res = await http()
        .put(`/ledger/workspaces/${workspace.id}`)
        .set(user.headers())
        .send({ books_start_on: '2025-07-01' })
        .expect(200);
      expect(res.body.data).toEqual({
        ...workspace,
        books_start_on: '2025-07-01',
      });
    });

    it('inactivates and reactivates', async () => {
      const service = app.get(LedgerWorkspacesService, { strict: false });
      await expect(
        service.requireUsable(workspace.organization_id),
      ).resolves.toBeUndefined();

      const off = await http()
        .put(`/ledger/workspaces/${workspace.id}/inactivate`)
        .set(user.headers())
        .expect(200);
      expect(off.body.data.inactive_at).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);

      // Still listed, and calls under it are refused.
      const found = await http()
        .get('/ledger/workspaces')
        .query({ external_id: payload.external_id })
        .set(user.headers())
        .expect(200);
      expect(found.body.data[0].inactive_at).toBe(off.body.data.inactive_at);
      await expect(
        service.requireUsable(workspace.organization_id),
      ).rejects.toMatchObject({
        errorType: 'WORKSPACE_INACTIVE',
      });

      const on = await http()
        .put(`/ledger/workspaces/${workspace.id}/activate`)
        .set(user.headers())
        .expect(200);
      expect(on.body.data.inactive_at).toBeNull();
      await expect(
        service.requireUsable(workspace.organization_id),
      ).resolves.toBeUndefined();
    });
  });

  describe('create without a chart', () => {
    it('presents the seeded chart', async () => {
      const res = await create(body());
      expect(res.status).toBe(201);
      expect(res.body.data.status).toBe('ready');
      expect(res.body.data.reporting_basis).toBe('accrual');
      expect(res.body.data.books_start_on).toBeNull();

      const tree = await rows(res.body.data, 'ext_account_tree');
      expect(tree).toHaveLength(SEEDED_ACCOUNTS);
      expect(await rows(res.body.data, 'accounts')).toHaveLength(
        SEEDED_ACCOUNTS,
      );
    });
  });

  describe('a chart that leaves out receivables and payables', () => {
    it('still presents both, since documents post to them', async () => {
      const res = await create(
        body({
          accounts: [{ code: '1000', name: 'Cash', account_type: 'cash' }],
        }),
      );
      expect(res.status).toBe(201);

      const tree = await rows(res.body.data, 'ext_account_tree');
      const accounts = await rows(res.body.data, 'accounts');
      const typeOf = (node: any) =>
        accounts.find((a) => a.id === node.accountId).accountType;

      // Cash and the two seeded control accounts.
      expect(tree.map(typeOf).sort()).toEqual([
        'accounts-payable',
        'accounts-receivable',
        'cash',
      ]);
    });
  });

  describe('refusals', () => {
    it('refuses an invalid chart and creates nothing', async () => {
      const payload = body({
        accounts: [
          { code: '1', name: 'A', account_type: 'cash' },
          { code: '1', name: 'B', account_type: 'not-a-type' },
        ],
      });
      const res = await create(payload);
      expect(res.status).toBe(400);
      expect(res.body.errors[0].type).toBe('CHART_INVALID');
      expect(res.body.errors[0].payload.problems).toHaveLength(2);

      const found = await http()
        .get('/ledger/workspaces')
        .query({ external_id: payload.external_id })
        .set(user.headers())
        .expect(200);
      expect(found.body).toEqual({
        data: [],
        pagination: { total: 0, page: 1, page_size: 50 },
      });
    });

    it('refuses an unknown field, at the top and on an account', async () => {
      expect((await create(body({ legal_name: 'x' }))).status).toBe(400);
      expect(
        (
          await create(
            body({
              accounts: [
                { code: '1', name: 'A', account_type: 'cash', subtype: 'x' },
              ],
            }),
          )
        ).status,
      ).toBe(400);
    });

    it('refuses a missing external id, a bad timezone and a bad basis', async () => {
      const { external_id: _omitted, ...withoutId } = body();
      expect((await create(withoutId)).status).toBe(400);
      expect((await create(body({ timezone: 'Mars/Olympus' }))).status).toBe(
        400,
      );
      expect((await create(body({ reporting_basis: 'modified' }))).status).toBe(
        400,
      );
    });

    it('refuses a call without a token', async () => {
      await http().post('/ledger/workspaces').send(body()).expect(401);
      await http().get('/ledger/workspaces').expect(401);
    });

    it('answers an unknown id as not found', async () => {
      for (const id of ['999999999', 'abc']) {
        const res = await http()
          .get(`/ledger/workspaces/${id}`)
          .set(user.headers());
        expect(res.status).toBe(404);
        expect(res.body.errors[0].type).toBe('WORKSPACE_NOT_FOUND');
      }
    });
  });

  describe('five simultaneous creates of one external id', () => {
    it('make one workspace and one database', async () => {
      const payload = body({ accounts: chart() });
      const results = await Promise.all(
        Array.from({ length: 5 }, () => create(payload)),
      );

      expect(results.map((r) => r.status).sort()).toEqual([
        200, 200, 200, 200, 201,
      ]);
      expect(new Set(results.map((r) => r.body.data.id)).size).toBe(1);
      expect(results.every((r) => r.body.data.status === 'ready')).toBe(true);

      const knex = systemKnex(app);
      expect(
        await knex('ext_workspaces').where({ externalId: payload.external_id }),
      ).toHaveLength(1);
      // Provisioned once: seven presented accounts, not thirty-five.
      expect(await rows(results[0].body.data, 'ext_account_tree')).toHaveLength(
        7,
      );
      expect(await rows(results[0].body.data, 'items')).toHaveLength(1);
    });
  });

  describe('a build that outlasts the request', () => {
    const previous = process.env.LEDGER_WORKSPACE_BUILD_WAIT_MS;
    afterAll(() => {
      if (previous === undefined)
        delete process.env.LEDGER_WORKSPACE_BUILD_WAIT_MS;
      else process.env.LEDGER_WORKSPACE_BUILD_WAIT_MS = previous;
    });

    it('answers building, and a repeat finishes it without a second build', async () => {
      const payload = body({ accounts: chart() });

      process.env.LEDGER_WORKSPACE_BUILD_WAIT_MS = '0';
      const first = await create(payload);
      expect(first.status).toBe(201);
      expect(first.body.data.status).toBe('building');

      // Repeats while it builds: each answers the same workspace.
      const during = await Promise.all([create(payload), create(payload)]);
      expect(during.map((r) => r.body.data.id)).toEqual([
        first.body.data.id,
        first.body.data.id,
      ]);

      process.env.LEDGER_WORKSPACE_BUILD_WAIT_MS = '60000';
      const last = await create(payload);
      expect(last.status).toBe(200);
      expect(last.body.data).toEqual({ ...first.body.data, status: 'ready' });

      expect(await rows(last.body.data, 'ext_account_tree')).toHaveLength(7);
      const [row] = await systemKnex(app)('ext_workspaces').where({
        tenantId: last.body.data.id,
      });
      expect(row.buildJobId).toBe(`ledger-workspace-${row.id}`);
      expect(row.pendingAccounts).toBeNull();
    });
  });

  describe('delete', () => {
    it('drops the database and frees the external id', async () => {
      const payload = body();
      const first = (await create(payload)).body.data;
      expect(await databaseExists(first.organization_id)).toBe(true);

      await http()
        .delete(`/ledger/workspaces/${first.id}`)
        .set(user.headers())
        .expect(200);

      const found = await http()
        .get('/ledger/workspaces')
        .query({ external_id: payload.external_id })
        .set(user.headers())
        .expect(200);
      expect(found.body.data).toEqual([]);
      await http()
        .get(`/ledger/workspaces/${first.id}`)
        .set(user.headers())
        .expect(404);

      let dropped = false;
      for (let i = 0; i < 120 && !dropped; i += 1) {
        dropped = !(await databaseExists(first.organization_id));
        if (!dropped) await sleep(500);
      }
      expect(dropped).toBe(true);

      const second = await create(payload);
      expect(second.status).toBe(201);
      expect(second.body.data.id).not.toBe(first.id);
    });
  });
});
