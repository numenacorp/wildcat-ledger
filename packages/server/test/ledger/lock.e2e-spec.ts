import request = require('supertest');
import { INestApplication } from '@nestjs/common';
import {
  change,
  createTestApp,
  createTestWorkspace,
  dropOrganizations,
  TestWorkspace,
} from './harness';

/**
 * The lock is a day and it is inclusive, and a lock exception opens a range
 * of locked days until it expires or is revoked.
 *
 * The books are locked through 31 March 2031. Every bill is 100.00 to Rent.
 * Worked by hand, as debits less credits:
 *
 *   A bill dated 31 March is refused: the last locked day is locked.
 *   A bill dated 1 April is taken. Through 30 April: Payables -100.00,
 *   Rent 100.00.
 *
 *   ana opens 1 to 31 March. A bill dated 15 March is taken. Through 31
 *   March: Payables -100.00, Rent 100.00 (the April bill is after the
 *   range). A bill dated 28 February is refused: locked, and not in the
 *   range opened.
 *
 *   ben revokes the exception. A bill dated 16 March is refused.
 *
 *   An exception that expires two seconds on lets a bill dated 17 March
 *   through at once, and refuses one dated 18 March three seconds later.
 *   Through 31 March then: Payables -200.00, Rent 200.00.
 */
const chart = () => [
  { code: '1010', name: 'Bank', account_type: 'bank' },
  { code: '2010', name: 'Payables', account_type: 'accounts-payable' },
  { code: '6000', name: 'Rent', account_type: 'expense' },
];
const LOCKED_THROUGH = '2031-03-31';
const FAR = '2999-01-01T00:00:00.000Z';

describe('Ledger extension: the lock and lock exceptions', () => {
  let app: INestApplication;
  let ws: TestWorkspace;
  let id: Record<string, number>;
  let vendor: any;
  let first: any;

  const http = () => request(app.getHttpServer());
  const as = (actor: string | null) =>
    actor ? { ...ws.headers(), 'x-ledger-actor': actor } : ws.headers();
  const get = (path: string, query: Record<string, unknown> = {}) =>
    http().get(path).query(query).set(ws.headers());
  const post = (actor: string | null, path: string, body: unknown = {}) =>
    change(app, 'post', path, as(actor), body);
  const errorType = (res: request.Response) => res.body?.errors?.[0]?.type;
  const bill = (day: string) =>
    post('ana', '/ledger/bills', {
      vendor_id: vendor.id,
      posted_on: day,
      entries: [{ account_id: id['6000'], rate: '100.00' }],
    });
  const refused = async (day: string) => {
    const res = await bill(day);
    expect(res.status).toBe(400);
    expect(errorType(res)).toBe('TRANSACTIONS_DATE_LOCKED');
    expect(res.body.errors[0].payload).toEqual({
      lockedThrough: LOCKED_THROUGH,
      date: day,
    });
  };
  const through = async (day: string) => {
    const accounts = (await get('/ledger/accounts', { to: day }).expect(200))
      .body.data;
    const of = (code: string) =>
      accounts.find((a: any) => a.code === code).balance;
    return { payables: of('2010'), rent: of('6000') };
  };
  const exception = (
    actor: string | null,
    body: Record<string, unknown> = {},
  ) =>
    post(actor, '/ledger/lock-exceptions', {
      from: '2031-03-01',
      to: '2031-03-31',
      reason: 'A March bill came late',
      expires_at: FAR,
      ...body,
    });
  const bigcapitalLock = async () =>
    JSON.stringify(
      (await http().get('/transactions-locking').set(ws.headers()).expect(200))
        .body,
    );
  const logOf = async (subject: string) =>
    (
      await get('/ledger/audit-log', { subject }).expect(200)
    ).body.data.reverse() as any[];

  beforeAll(async () => {
    app = await createTestApp();
    ws = await createTestWorkspace(app, { accounts: chart() });
    id = Object.fromEntries(
      (await get('/ledger/accounts').expect(200)).body.data.map((a: any) => [
        a.code,
        a.id,
      ]),
    );
    vendor = (await post(null, '/ledger/vendors', { external_id: 'v-1' })).body
      .data;
  });

  afterAll(async () => {
    await dropOrganizations(app, [ws.workspace.organization_id]);
    await app.close();
  });

  describe('the lock', () => {
    it('opening days where nothing is locked is refused', async () => {
      const res = await exception('ana');
      expect(res.status).toBe(400);
      expect(errorType(res)).toBe('LOCK_EXCEPTION_NOT_LOCKED');
    });

    it('is set to a day, and logged with who set it', async () => {
      const res = await http()
        .put('/ledger/settings')
        .set(as('ana'))
        .send({ locked_through: LOCKED_THROUGH })
        .expect(200);
      expect(res.body.data.locked_through).toBe(LOCKED_THROUGH);

      const log = await logOf('lock');
      expect(log).toHaveLength(1);
      expect(log[0]).toMatchObject({
        action: 'edit',
        actor: 'ana',
        before: { locked_through: null },
        after: { locked_through: LOCKED_THROUGH },
      });
    });

    it('refuses a bill dated the last locked day', async () => {
      await refused('2031-03-31');
    });

    it('takes a bill dated the day after', async () => {
      expect((await bill('2031-04-01')).status).toBe(201);
      expect(await through('2031-04-30')).toEqual({
        payables: '-100.00',
        rent: '100.00',
      });
      expect(await through('2031-03-31')).toEqual({
        payables: '0.00',
        rent: '0.00',
      });
    });
  });

  describe('a lock exception', () => {
    it('names who made it, a range in order, an end still to come, and days that are locked', async () => {
      const cases: Array<[string | null, Record<string, unknown>, string]> = [
        [null, {}, 'LOCK_EXCEPTION_ACTOR_REQUIRED'],
        [
          'ana',
          { from: '2031-03-20', to: '2031-03-10' },
          'LOCK_EXCEPTION_RANGE_INVALID',
        ],
        [
          'ana',
          { expires_at: '2020-01-01T00:00:00Z' },
          'LOCK_EXCEPTION_EXPIRY_PAST',
        ],
        // 15 April is not locked.
        ['ana', { to: '2031-04-15' }, 'LOCK_EXCEPTION_NOT_LOCKED'],
        ['ana', { from: '2031-03-01T06:00:00Z' }, 'DATE_NOT_PLAIN'],
      ];
      for (const [actor, body, type] of cases) {
        const res = await exception(actor, body);
        expect(res.status).toBe(400);
        expect(errorType(res)).toBe(type);
      }
      expect((await exception('ana', { reason: '' })).status).toBe(400);
      expect((await exception('ana', { expires_at: undefined })).status).toBe(
        400,
      );
      expect((await get('/ledger/lock-exceptions')).body.data).toEqual([]);
    });

    it('opens its range: a bill dated in it is taken, one before it is still refused', async () => {
      const res = await exception('ana');
      expect(res.status).toBe(201);
      first = res.body.data;
      expect(first).toMatchObject({
        from: '2031-03-01',
        to: '2031-03-31',
        reason: 'A March bill came late',
        actor: 'ana',
        expires_at: FAR,
        revoked_at: null,
        revoked_by: null,
        active: true,
      });

      expect((await bill('2031-03-15')).status).toBe(201);
      expect(await through('2031-03-31')).toEqual({
        payables: '-100.00',
        rent: '100.00',
      });
      await refused('2031-02-28');
    });

    it("opens the same range on Bigcapital's own lock", async () => {
      const lock = await bigcapitalLock();
      expect(lock).toContain('2031-03-01');
    });

    it('is the only one active', async () => {
      const res = await exception('ben', {
        from: '2031-02-01',
        to: '2031-02-28',
      });
      expect(res.status).toBe(400);
      expect(errorType(res)).toBe('LOCK_EXCEPTION_ACTIVE');
    });

    it('once revoked locks its range again, and stays listed', async () => {
      const res = await post(
        'ben',
        `/ledger/lock-exceptions/${first.id}/revoke`,
      ).expect(200);
      expect(res.body.data).toMatchObject({
        id: first.id,
        active: false,
        revoked_by: 'ben',
      });
      expect(res.body.data.revoked_at).toEqual(expect.any(String));

      await refused('2031-03-16');
      expect(await bigcapitalLock()).not.toContain('2031-03-01');

      // Revoking it again answers it as it stands.
      const again = await post(
        'ana',
        `/ledger/lock-exceptions/${first.id}/revoke`,
      ).expect(200);
      expect(again.body.data).toEqual(res.body.data);

      const list = (await get('/ledger/lock-exceptions').expect(200)).body.data;
      expect(list).toEqual([res.body.data]);

      const unknown = await post(
        'ana',
        '/ledger/lock-exceptions/999999/revoke',
      );
      expect(unknown.status).toBe(404);
      expect(errorType(unknown)).toBe('LOCK_EXCEPTION_NOT_FOUND');
    });

    it('is logged when made and when revoked, with who did each', async () => {
      const log = await logOf('lock_exception');
      expect(log.map((row) => [row.action, row.actor, row.subject_id])).toEqual(
        [
          ['create', 'ana', first.id],
          ['revoke', 'ben', first.id],
        ],
      );
      expect(log[0].before).toBeNull();
      expect(log[0].after).toMatchObject({ active: true, actor: 'ana' });
      expect(log[1].before).toMatchObject({ active: true });
      expect(log[1].after).toMatchObject({ active: false, revoked_by: 'ben' });
    });

    it('once expired locks its range again without being revoked, and another can be made', async () => {
      const expiresAt = new Date(Date.now() + 2000).toISOString();
      const made = await exception('ana', { expires_at: expiresAt });
      expect(made.status).toBe(201);
      expect((await bill('2031-03-17')).status).toBe(201);

      await new Promise((resolve) => setTimeout(resolve, 3000));
      await refused('2031-03-18');
      expect(await through('2031-03-31')).toEqual({
        payables: '-200.00',
        rent: '200.00',
      });

      const list = (await get('/ledger/lock-exceptions').expect(200)).body.data;
      expect(list.map((e: any) => [e.id, e.active, e.revoked_at])).toEqual([
        [made.body.data.id, false, null],
        [first.id, false, expect.any(String)],
      ]);
      // Reading the list closed the range Bigcapital's lock still held.
      expect(await bigcapitalLock()).not.toContain('2031-03-01');

      const next = await exception('ben');
      expect(next.status).toBe(201);
      await post(
        'ben',
        `/ledger/lock-exceptions/${next.body.data.id}/revoke`,
      ).expect(200);
    });
  });
});
