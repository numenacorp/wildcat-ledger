import request = require('supertest');
import { INestApplication } from '@nestjs/common';
import {
  createTestApp,
  createTestWorkspace,
  dropOrganizations,
  TestWorkspace,
} from './harness';

/**
 * The bank feed's routes before there is a bank feed: a workspace has no
 * bank accounts and no bank lines, and the lists say so.
 */
describe('Ledger extension: the bank routes with no bank feed', () => {
  let app: INestApplication;
  let ws: TestWorkspace;

  const get = (path: string, query: Record<string, unknown> = {}) =>
    request(app.getHttpServer()).get(path).query(query).set(ws.headers());

  beforeAll(async () => {
    app = await createTestApp();
    ws = await createTestWorkspace(app);
  });

  afterAll(async () => {
    await dropOrganizations(app, [ws.workspace.organization_id]);
    await app.close();
  });

  it('lists no bank lines, as an empty page of the size asked for', async () => {
    const res = await get('/ledger/bank/transactions').expect(200);
    expect(res.body).toEqual({
      data: [],
      pagination: { total: 0, page: 1, page_size: 50 },
    });
    const paged = await get('/ledger/bank/transactions', {
      page: 3,
      page_size: 100000,
    }).expect(200);
    expect(paged.body.pagination).toEqual({
      total: 0,
      page: 3,
      page_size: 200,
    });
  });

  it('lists no bank accounts of either kind', async () => {
    expect((await get('/ledger/bank/accounts').expect(200)).body).toEqual({
      data: [],
    });
    expect(
      (await get('/ledger/bank/manual-accounts').expect(200)).body,
    ).toEqual({ data: [] });
  });

  it('needs a workspace, as every ledger route does', async () => {
    const res = await request(app.getHttpServer())
      .get('/ledger/bank/accounts')
      .set(ws.user.headers());
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
