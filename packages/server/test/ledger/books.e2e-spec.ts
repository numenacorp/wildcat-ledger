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
 * Fixed assets, value updates, loans and opening balances, on a workspace
 * in America/Chicago. Worked by hand; balances are debits less credits.
 *
 *   Truck      a fixed asset costing 30,000.00, opened at 30,000.00 on 2 Jan
 *                Truck's account +30,000.00   3900 Opening Equity -30,000.00
 *   U1  31 Jan a value update of 450.00, (30,000 - 3,000) / 60 months
 *                6500 Depreciation +450.00    1590 Accumulated -450.00
 *   U2  15 Jan a value update of 10.00
 *                6500 +10.00                  1590 -10.00
 *   Bank Note  a loan owing 42,000.00 on 2 Jan
 *                3900 +42,000.00              the note's account -42,000.00
 *   Import     dated the last millisecond of 31 Dec in US Eastern time,
 *              which is 31 Dec in Chicago too:
 *                1010 Operating    debit  1,000.50   against 3900
 *                1300 Deposits     debit    200.00   against 3900
 *                2300 Accrued      credit   300.25   against 3900
 *                3900 itself       credit   900.25   against itself: nothing
 *
 * So, each account's own balance, with everything in:
 *   1010 +1,000.50   1300 +200.00   2300 -300.25
 *   1590 -460.00     6500 +460.00
 *   3900 = -30,000 + 42,000 - 1,000.50 - 200 + 300.25 = +11,099.75
 * and once the import is deleted: 3900 = +12,000.00, and 1010, 1300 and
 * 2300 hold nothing.
 *
 * The import takes no row on Receivables or Payables: what was owed either
 * way comes in as opening invoices and bills.
 */
const chart = () => [
  { code: '1000', name: 'Assets', account_type: 'other-current-asset' },
  {
    code: '1010',
    name: 'Operating',
    account_type: 'bank',
    parent_code: '1000',
  },
  {
    code: '1200',
    name: 'Receivables',
    account_type: 'accounts-receivable',
    slug: 'accounts-receivable',
    parent_code: '1000',
  },
  {
    code: '1300',
    name: 'Deposits',
    account_type: 'other-current-asset',
    parent_code: '1000',
  },
  {
    code: '1500',
    name: 'Equipment',
    account_type: 'fixed-asset',
    slug: 'fixed-assets',
    parent_code: '1000',
  },
  {
    code: '1590',
    name: 'Accumulated',
    account_type: 'fixed-asset',
    slug: 'accumulated-depreciation',
    parent_code: '1000',
  },
  {
    code: '2000',
    name: 'Liabilities',
    account_type: 'other-current-liability',
  },
  {
    code: '2010',
    name: 'Payables',
    account_type: 'accounts-payable',
    slug: 'accounts-payable',
    parent_code: '2000',
  },
  {
    code: '2300',
    name: 'Accrued',
    account_type: 'other-current-liability',
    parent_code: '2000',
  },
  {
    code: '3900',
    name: 'Opening Equity',
    account_type: 'equity',
    slug: 'opening-balance-equity',
  },
  { code: '6000', name: 'Rent', account_type: 'expense' },
  {
    code: '6500',
    name: 'Depreciation',
    account_type: 'expense',
    slug: 'depreciation',
  },
];

const OPENED = '2031-01-02';
const IMPORT_AT = '2030-12-31';

describe('Ledger extension: fixed assets, loans and opening balances', () => {
  let app: INestApplication;
  let ws: TestWorkspace;
  let id: Record<string, number>;
  let truck: any;
  let u1: any;
  let u2: any;
  let note: any;

  const http = () => request(app.getHttpServer());
  const get = (path: string, query: Record<string, unknown> = {}) =>
    http().get(path).query(query).set(ws.headers());
  const post = (path: string, body: unknown = {}) =>
    change(app, 'post', path, ws.headers(), body);
  const put = (path: string, body: unknown) =>
    change(app, 'put', path, ws.headers(), body);
  const del = (path: string) => change(app, 'delete', path, ws.headers());
  const error = (res: request.Response) => res.body?.errors?.[0];
  const errorType = (res: request.Response) => res.body?.errors?.[0]?.type;

  const accounts = async () =>
    (await get('/ledger/accounts').expect(200)).body.data as any[];
  /** Each account's own balance, by code, or by name where it has no code. */
  const own = async () =>
    Object.fromEntries(
      (await accounts())
        .filter((a) => a.own_balance !== '0.00')
        .map((a) => [a.code ?? a.name, a.own_balance]),
    );
  const rowsOf = async (referenceType: string, referenceId: number) => {
    const nameOf = Object.fromEntries(
      (await accounts()).map((a) => [a.id, a.code ?? a.name]),
    );
    return (
      await ws.rows('accounts_transactions', { referenceType, referenceId })
    )
      .map((row) => [
        row.date,
        row.basis ?? 'both',
        nameOf[row.accountId],
        (Number(row.debit) - Number(row.credit)).toFixed(2),
      ])
      .sort((a, b) => a.join('|').localeCompare(b.join('|')));
  };
  const feed = async () =>
    (await get('/ledger/entries', { order: 'asc' }).expect(200)).body.data;

  beforeAll(async () => {
    app = await createTestApp();
    ws = await createTestWorkspace(app, { accounts: chart() });
    id = Object.fromEntries((await accounts()).map((a) => [a.code, a.id]));
  });

  afterAll(async () => {
    await dropOrganizations(app, [ws.workspace.organization_id]);
    await app.close();
  });

  describe('a fixed asset', () => {
    const body = (extra = {}) => ({
      external_id: 'fa-1',
      name: 'Truck',
      asset_type: 'VEHICLE',
      cost: '30000.00',
      salvage_value: '3000.00',
      useful_life_months: 60,
      metadata: { plateNumber: 'ABC 123' },
      funding: {
        amount: '30000.00',
        posted_on: '2031-01-02',
        from: 'opening',
      },
      ...extra,
    });

    it('is made with an account of its own under the marked account, and its opening entry', async () => {
      const res = await post('/ledger/fixed-assets', body());
      expect(res.status).toBe(201);
      // A first create is no retry, and says nothing of one.
      expect(res.body).not.toHaveProperty('replayed');
      truck = res.body.data;
      expect(truck).toEqual({
        id: expect.any(Number),
        external_id: 'fa-1',
        version: 1,
        name: 'Truck',
        asset_type: 'VEHICLE',
        cost: '30000.00',
        salvage_value: '3000.00',
        useful_life_months: 60,
        metadata: { plateNumber: 'ABC 123' },
        account: {
          id: expect.any(Number),
          code: null,
          name: 'Truck',
          account_type: 'fixed-asset',
          metadata: null,
        },
        accumulated_account: null,
        funding: {
          amount: '30000.00',
          posted_on: OPENED,
          from: 'opening',
          account_id: null,
        },
        created_at: expect.any(String),
      });
      const account = (await accounts()).find((a) => a.id === truck.account.id);
      expect(account.parent_id).toBe(id['1500']);
      expect(account.own_balance).toBe('30000.00');
    });

    it('posts the opening on its Central day, against opening balance equity, on both bases', async () => {
      const opening = (await feed()).find(
        (e: any) => e.source_type === 'opening_balance',
      );
      expect(opening.description).toBe('Opening balance for Truck');
      expect(opening.posted_on).toBe(OPENED);
      expect(await rowsOf('OpeningBalance', opening.source_id)).toEqual([
        ['2031-01-02', 'both', '3900', '-30000.00'],
        ['2031-01-02', 'both', 'Truck', '30000.00'],
      ]);
    });

    it('a repeat of its external id is a retry with the same body, and refused with another', async () => {
      // The truck alone is in the books: 30,000.00 on its own account,
      // against opening balance equity.
      const books = { Truck: '30000.00', '3900': '-30000.00' };
      expect(await own()).toEqual(books);

      const retry = await post('/ledger/fixed-assets', body());
      expect(retry.status).toBe(200);
      expect(retry.body).toEqual({ data: truck, replayed: true });

      const bodies = [
        body({ name: 'Another', cost: '1.00', funding: null }),
        body({ salvage_value: '3000.01' }),
        body({ metadata: { plateNumber: 'XYZ 789' } }),
      ];
      for (const other of bodies) {
        const again = await post('/ledger/fixed-assets', other);
        expect(again.status).toBe(409);
        expect(errorType(again)).toBe('EXTERNAL_ID_IN_USE');
        expect(error(again).payload).toEqual({
          kind: 'fixed_asset',
          externalId: 'fa-1',
          recordId: truck.id,
          state: 'live',
          version: 1,
        });
      }
      // One asset, one account of its own, one opening entry: as they were.
      expect((await get(`/ledger/fixed-assets/${truck.id}`)).body.data).toEqual(
        truck,
      );
      expect(
        (await get('/ledger/fixed-assets').expect(200)).body.pagination.total,
      ).toBe(1);
      expect((await accounts()).filter((a) => a.name === 'Truck')).toHaveLength(
        1,
      );
      expect(await own()).toEqual(books);
    });

    it('refuses a value update while it has no accumulated account', async () => {
      const res = await post('/ledger/fixed-assets/value-updates', {
        asset_id: truck.id,
        amount: '450.00',
        update_type: 'DEPRECIATION_AMORTIZATION',
        posted_on: '2031-01-31',
        counter_account_slug: 'depreciation',
      });
      expect(res.status).toBe(400);
      expect(errorType(res)).toBe('ACCUMULATED_ACCOUNT_NOT_SET');
    });

    it('is edited field by field, and renaming it leaves its account named as it was', async () => {
      const res = await put(`/ledger/fixed-assets/${truck.id}`, {
        name: 'Truck 2',
        accumulated_account_slug: 'accumulated-depreciation',
      });
      expect(res.status).toBe(200);
      // Made at 1, and each of the three edits here raises it by one.
      expect(res.body.data).toEqual({
        ...truck,
        name: 'Truck 2',
        accumulated_account: {
          id: id['1590'],
          code: '1590',
          name: 'Accumulated',
          account_type: 'fixed-asset',
          metadata: null,
        },
        version: 2,
      });
      truck = res.body.data;

      const byId = await put(`/ledger/fixed-assets/${truck.id}`, {
        accumulated_account_id: id['1590'],
        useful_life_months: 48,
        salvage_value: null,
      });
      expect(byId.body.data).toEqual({
        ...truck,
        useful_life_months: 48,
        salvage_value: null,
        version: 3,
      });
      truck = (
        await put(`/ledger/fixed-assets/${truck.id}`, {
          useful_life_months: 60,
          salvage_value: '3000.00',
        })
      ).body.data;
      expect((await get(`/ledger/fixed-assets/${truck.id}`)).body.data).toEqual(
        truck,
      );
      expect([truck.useful_life_months, truck.version]).toEqual([60, 4]);
    });

    it('is edited from the version it was read at: an old version or none is refused, and nothing is written', async () => {
      const path = `/ledger/fixed-assets/${truck.id}`;
      const current = (await get(path)).body.data;
      expect(current.version).toBe(4);

      const stale = await put(path, { name: 'Late Truck', version: 3 });
      expect(stale.status).toBe(409);
      expect(errorType(stale)).toBe('STALE_VERSION');
      expect(error(stale).payload).toEqual({ current });

      const none = await http()
        .put(path)
        .set(ws.headers())
        .send({ name: 'Unversioned Truck' });
      expect(none.status).toBe(400);
      expect(errorType(none)).toBe('VERSION_REQUIRED');
      expect((await get(path)).body.data).toEqual(current);

      // From the version it has, the edit lands: 4 to 5. Then back, 5 to 6,
      // so the asset is named as the tests after this one expect.
      const landed = await put(path, { name: 'Truck 3', version: 4 });
      expect(landed.status).toBe(200);
      expect(landed.body.data).toEqual({
        ...current,
        name: 'Truck 3',
        version: 5,
      });
      truck = (await put(path, { name: 'Truck 2', version: 5 })).body.data;
      expect(truck).toEqual({ ...current, version: 6 });

      // Not found is answered before the version is looked at.
      const missing = await http()
        .put('/ledger/fixed-assets/99999999')
        .set(ws.headers())
        .send({ name: 'Nothing' });
      expect(missing.status).toBe(404);
      expect(errorType(missing)).toBe('fixed_asset_not_found');
    });

    it('eight simultaneous creates of one external id and body make one asset', async () => {
      // A trailer with no funding: it posts nothing, so the books stay the
      // truck's 30,000.00 against opening balance equity.
      const trailer = {
        external_id: 'fa-8',
        name: 'Trailer',
        asset_type: 'VEHICLE',
        cost: '8000.00',
      };
      const results = await Promise.all(
        Array.from({ length: 8 }, () => post('/ledger/fixed-assets', trailer)),
      );
      expect(results.map((r) => [r.status, r.body.replayed]).sort()).toEqual([
        ...Array.from({ length: 7 }, () => [200, true]),
        [201, undefined],
      ]);
      expect(new Set(results.map((r) => r.body.data.id)).size).toBe(1);
      expect(results[0].body.data.version).toBe(1);
      expect(
        await ws.rows('ext_fixed_assets', { name: 'Trailer' }),
      ).toHaveLength(1);
      expect(
        (await accounts()).filter((a) => a.name === 'Trailer'),
      ).toHaveLength(1);
      expect((await get('/ledger/fixed-assets')).body.pagination.total).toBe(2);
      expect(await own()).toEqual({ Truck: '30000.00', '3900': '-30000.00' });
    });

    it('refuses an account named twice, an unknown slug, an unknown account and an unknown asset', async () => {
      const both = await put(`/ledger/fixed-assets/${truck.id}`, {
        accumulated_account_id: id['1590'],
        accumulated_account_slug: 'accumulated-depreciation',
      });
      expect(both.status).toBe(400);
      expect(errorType(both)).toBe('ACCOUNT_NAMED_ONCE');

      const slug = await put(`/ledger/fixed-assets/${truck.id}`, {
        accumulated_account_slug: 'nothing',
      });
      expect(slug.status).toBe(400);

      const account = await put(`/ledger/fixed-assets/${truck.id}`, {
        accumulated_account_id: 99999999,
      });
      expect(account.status).toBe(404);
      expect(errorType(account)).toBe('account_not_found');

      const asset = await get('/ledger/fixed-assets/99999999');
      expect(asset.status).toBe(404);
      expect(errorType(asset)).toBe('fixed_asset_not_found');
    });
  });

  describe('a value update', () => {
    const body = (extra = {}) => ({
      external_id: 'vu-1',
      asset_id: truck.id,
      amount: '450.00',
      update_type: 'DEPRECIATION_AMORTIZATION',
      posted_on: '2031-01-31',
      note: 'January',
      counter_account_slug: 'depreciation',
      ...extra,
    });

    it('debits the counter account and credits the accumulated account', async () => {
      const res = await post('/ledger/fixed-assets/value-updates', body());
      expect(res.status).toBe(201);
      expect(res.body).not.toHaveProperty('replayed');
      u1 = res.body.data;
      expect(u1).toEqual({
        id: expect.any(Number),
        external_id: 'vu-1',
        asset_id: truck.id,
        amount: '450.00',
        update_type: 'DEPRECIATION_AMORTIZATION',
        posted_on: '2031-01-31',
        note: 'January',
        counter_account: {
          id: id['6500'],
          code: '6500',
          name: 'Depreciation',
          account_type: 'expense',
          metadata: null,
        },
        created_at: expect.any(String),
      });
      expect(await rowsOf('FixedAssetValueUpdate', u1.id)).toEqual([
        ['2031-01-31', 'both', '1590', '-450.00'],
        ['2031-01-31', 'both', '6500', '450.00'],
      ]);
    });

    it('is in the feed as a fixed asset entry, described by the asset and the note', async () => {
      const entry = (await feed()).find(
        (e: any) => e.source_type === 'fixed_asset',
      );
      expect(entry.source_id).toBe(u1.id);
      expect(entry.description).toBe('Depreciation - Truck 2 (Memo: January)');
      expect(
        entry.entries.map((l: any) => [l.account.code, l.debit, l.credit]),
      ).toEqual([
        ['6500', '450.00', '0.00'],
        ['1590', '0.00', '450.00'],
      ]);
    });

    it('a repeat of its external id is a retry with the same body, and refused with another', async () => {
      const retry = await post('/ledger/fixed-assets/value-updates', body());
      expect(retry.status).toBe(200);
      expect(retry.body).toEqual({ data: u1, replayed: true });

      const again = await post(
        '/ledger/fixed-assets/value-updates',
        body({ amount: '1.00' }),
      );
      expect(again.status).toBe(409);
      expect(errorType(again)).toBe('EXTERNAL_ID_IN_USE');
      // A value update is never edited, so it has no version to name.
      expect(error(again).payload).toEqual({
        kind: 'fixed_asset_value_update',
        externalId: 'vu-1',
        recordId: u1.id,
        state: 'live',
        version: null,
      });
      // The one 450.00, posted once.
      expect(await rowsOf('FixedAssetValueUpdate', u1.id)).toEqual([
        ['2031-01-31', 'both', '1590', '-450.00'],
        ['2031-01-31', 'both', '6500', '450.00'],
      ]);
      expect(
        (await get('/ledger/fixed-assets/value-updates')).body.pagination.total,
      ).toBe(1);
      expect((await own())['6500']).toBe('450.00');
    });

    it('is listed oldest dated first, and for one asset when one is named', async () => {
      u2 = (
        await post(
          '/ledger/fixed-assets/value-updates',
          body({
            external_id: 'vu-2',
            amount: '10.00',
            posted_on: '2031-01-15',
            note: null,
            counter_account_slug: null,
            counter_account_id: id['6500'],
          }),
        ).expect(201)
      ).body.data;

      const list = await get('/ledger/fixed-assets/value-updates').expect(200);
      expect(list.body.data.map((u: any) => u.id)).toEqual([u2.id, u1.id]);
      expect(list.body.pagination).toEqual({
        total: 2,
        page: 1,
        page_size: 50,
      });

      const none = await get('/ledger/fixed-assets/value-updates', {
        asset_id: 99999999,
      }).expect(200);
      expect(none.body.data).toEqual([]);
      const mine = await get('/ledger/fixed-assets/value-updates', {
        asset_id: truck.id,
        page_size: 1,
        page: 2,
      }).expect(200);
      expect(mine.body.data.map((u: any) => u.id)).toEqual([u1.id]);
    });

    it('is refused in a locked period, with no counter account, and for an unknown asset', async () => {
      await put('/ledger/settings', {
        locked_through: '2031-01-31',
      }).expect(200);
      try {
        const locked = await post(
          '/ledger/fixed-assets/value-updates',
          body({ external_id: 'vu-locked' }),
        );
        expect(locked.status).toBe(400);
        expect(errorType(locked)).toBe('TRANSACTIONS_DATE_LOCKED');
      } finally {
        await put('/ledger/settings', { locked_through: null }).expect(200);
      }
      const noCounter = await post(
        '/ledger/fixed-assets/value-updates',
        body({ external_id: 'vu-3', counter_account_slug: null }),
      );
      expect(noCounter.status).toBe(400);
      expect(errorType(noCounter)).toBe('ACCOUNT_NAMED_ONCE');

      const unknown = await post(
        '/ledger/fixed-assets/value-updates',
        body({ external_id: 'vu-4', asset_id: 99999999 }),
      );
      expect(unknown.status).toBe(404);
      expect(errorType(unknown)).toBe('fixed_asset_not_found');
      expect(
        (await get('/ledger/fixed-assets/value-updates')).body.pagination.total,
      ).toBe(2);
    });
  });

  describe('a loan', () => {
    const body = (extra = {}) => ({
      external_id: 'loan-1',
      name: 'Bank Note',
      loan_type: 'TERM_LOAN',
      origination_date: '2030-06-01',
      original_principal: '50000.00',
      loan_term_months: 60,
      funding: { amount: '42000.00', posted_on: OPENED, from: 'opening' },
      ...extra,
    });

    it('is made with an account of its own under the root of the liabilities', async () => {
      const res = await post('/ledger/loans', body());
      expect(res.status).toBe(201);
      note = res.body.data;
      expect(note).toEqual({
        id: expect.any(Number),
        external_id: 'loan-1',
        name: 'Bank Note',
        loan_type: 'TERM_LOAN',
        origination_date: '2030-06-01',
        original_principal: '50000.00',
        credit_limit: null,
        loan_term_months: 60,
        metadata: null,
        account: {
          id: expect.any(Number),
          code: null,
          name: 'Bank Note',
          account_type: 'long-term-liability',
          metadata: null,
        },
        balance: '42000.00',
        funding: {
          amount: '42000.00',
          posted_on: OPENED,
          from: 'opening',
          account_id: null,
        },
        created_at: expect.any(String),
      });
      const account = (await accounts()).find((a) => a.id === note.account.id);
      expect(account.parent_id).toBe(id['2000']);
    });

    it('posts what is owed as an opening entry: equity debited, the loan credited', async () => {
      const opening = (await feed()).find(
        (e: any) => e.description === 'Opening balance for Bank Note',
      );
      expect(opening.source_type).toBe('opening_balance');
      expect(await rowsOf('OpeningBalance', opening.source_id)).toEqual([
        ['2031-01-02', 'both', '3900', '42000.00'],
        ['2031-01-02', 'both', 'Bank Note', '-42000.00'],
      ]);
    });

    it('a repeat of its external id is a retry with the same body, and refused with another; it is read and listed', async () => {
      const retry = await post('/ledger/loans', body());
      expect(retry.status).toBe(200);
      expect(retry.body).toEqual({ data: note, replayed: true });

      const again = await post('/ledger/loans', body({ name: 'Other' }));
      expect(again.status).toBe(409);
      expect(errorType(again)).toBe('EXTERNAL_ID_IN_USE');
      // A loan is never edited, so it has no version to name.
      expect(error(again).payload).toEqual({
        kind: 'loan',
        externalId: 'loan-1',
        recordId: note.id,
        state: 'live',
        version: null,
      });
      // Still the one 42,000.00 owed on the one account.
      expect(
        (await accounts()).filter((a) => a.name === 'Bank Note'),
      ).toHaveLength(1);
      expect((await own())['Bank Note']).toBe('-42000.00');
      expect((await get(`/ledger/loans/${note.id}`)).body.data).toEqual(note);

      const list = await get('/ledger/loans').expect(200);
      expect(list.body.data).toEqual([note]);
      expect(list.body.pagination.total).toBe(1);

      const unknown = await get('/ledger/loans/99999999');
      expect(unknown.status).toBe(404);
      expect(errorType(unknown)).toBe('loan_not_found');
    });
  });

  describe('opening balances', () => {
    const balances = () => [
      {
        code: '1010',
        name: 'Cash - Checking',
        debit: '1000.50',
        credit: '0.00',
      },
      { name: 'deposits', debit: '200.00', credit: '0' },
      { code: '2300', debit: '0', credit: '300.25' },
      { code: '3900', debit: '0.00', credit: '900.25' },
    ];

    it('are refused whole when a row names no account of the chart', async () => {
      const res = await post('/ledger/opening-balances', {
        posted_on: IMPORT_AT,
        balances: [...balances(), { code: '7777', debit: '1.00', credit: '0' }],
      });
      expect(res.status).toBe(400);
      expect(errorType(res)).toBe('OPENING_ACCOUNT_NOT_FOUND');
      expect((await own())['1010']).toBeUndefined();

      const twice = await post('/ledger/opening-balances', {
        posted_on: IMPORT_AT,
        balances: [
          { code: '1010', debit: '1.00', credit: '0' },
          { name: 'Operating', debit: '1.00', credit: '0' },
        ],
      });
      expect(twice.status).toBe(400);
      expect(errorType(twice)).toBe('OPENING_ACCOUNT_NAMED_TWICE');
    });

    it('are refused whole when a row is on the receivable or the payable account', async () => {
      const rows = (await ws.rows('accounts_transactions')).length;
      const withRow = (row: Record<string, unknown>) =>
        post('/ledger/opening-balances', {
          posted_on: IMPORT_AT,
          balances: [{ code: '1010', debit: '200.00', credit: '0' }, row],
        });

      const receivable = await withRow({
        name: 'receivables',
        debit: '0',
        credit: '200.00',
      });
      expect(receivable.status).toBe(400);
      expect(errorType(receivable)).toBe('OPENING_CONTROL_ACCOUNT_ROW');
      expect(error(receivable).payload).toEqual({
        index: 1,
        accountId: id['1200'],
      });

      const payable = await withRow({
        code: '2010',
        debit: '0',
        credit: '200.00',
      });
      expect(payable.status).toBe(400);
      expect(errorType(payable)).toBe('OPENING_CONTROL_ACCOUNT_ROW');
      expect(error(payable).payload).toEqual({
        index: 1,
        accountId: id['2010'],
      });

      expect((await own())['1010']).toBeUndefined();
      expect(await ws.rows('accounts_transactions')).toHaveLength(rows);
      expect((await get('/ledger/opening-balances')).body.data).toEqual({
        balances: [],
      });
    });

    it('are imported one entry an account, and answered in each account own direction', async () => {
      const res = await post('/ledger/opening-balances', {
        posted_on: IMPORT_AT,
        balances: balances(),
      });
      expect(res.status).toBe(201);
      expect(
        res.body.data.balances.map((b: any) => [
          b.account.code,
          b.amount,
          b.posted_on,
        ]),
      ).toEqual([
        ['1010', '1000.50', IMPORT_AT],
        ['1300', '200.00', IMPORT_AT],
        ['2300', '300.25', IMPORT_AT],
        ['3900', '900.25', IMPORT_AT],
      ]);
      expect((await get('/ledger/opening-balances')).body.data).toEqual(
        res.body.data,
      );
    });

    it('give the hand-worked books', async () => {
      expect(await own()).toEqual({
        '1010': '1000.50',
        '1300': '200.00',
        '1590': '-460.00',
        '2300': '-300.25',
        '3900': '11099.75',
        '6500': '460.00',
        Truck: '30000.00',
        'Bank Note': '-42000.00',
      });
    });

    it('post on the Central day of the instant, with no contact on any row', async () => {
      const entries = (await feed()).filter(
        (e: any) => e.posted_on === IMPORT_AT,
      );
      expect(entries.map((e: any) => [e.source_type, e.description])).toEqual([
        ['opening_balance', 'Opening balance for Operating'],
        ['opening_balance', 'Opening balance for Deposits'],
        ['opening_balance', 'Opening balance for Accrued'],
        ['opening_balance', 'Opening balance for Opening Equity'],
      ]);
      expect(await rowsOf('OpeningBalance', entries[0].source_id)).toEqual([
        ['2030-12-31', 'both', '1010', '1000.50'],
        ['2030-12-31', 'both', '3900', '-1000.50'],
      ]);
      // The equity account's own row: an entry of the account against itself.
      expect(await rowsOf('OpeningBalance', entries[3].source_id)).toEqual([
        ['2030-12-31', 'both', '3900', '-900.25'],
        ['2030-12-31', 'both', '3900', '900.25'],
      ]);
      const rows = await ws.rows('accounts_transactions', {
        referenceType: 'OpeningBalance',
      });
      // The asset's opening, the loan's, and two rows for each of the four
      // imported: twelve rows, and none names a contact.
      expect(rows).toHaveLength(12);
      expect(rows.filter((row) => row.contactId !== null)).toEqual([]);
    });

    it('are refused a second time, until the first are deleted', async () => {
      const res = await post('/ledger/opening-balances', {
        posted_on: IMPORT_AT,
        balances: balances(),
      });
      expect(res.status).toBe(400);
      expect(errorType(res)).toBe('OPENING_BALANCES_ALREADY_IMPORTED');
    });

    it('are held by the lock, on import and on delete', async () => {
      await put('/ledger/settings', {
        locked_through: '2030-12-31',
      }).expect(200);
      try {
        const res = await del('/ledger/opening-balances');
        expect(res.status).toBe(400);
        expect(errorType(res)).toBe('TRANSACTIONS_DATE_LOCKED');
      } finally {
        await put('/ledger/settings', { locked_through: null }).expect(200);
      }
    });

    it('are deleted, leaving the openings of the asset and the loan, and deleting again changes nothing', async () => {
      const res = await del('/ledger/opening-balances');
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ balances: [] });

      const after = {
        '1590': '-460.00',
        '3900': '12000.00',
        '6500': '460.00',
        Truck: '30000.00',
        'Bank Note': '-42000.00',
      };
      expect(await own()).toEqual(after);
      await del('/ledger/opening-balances').expect(200);
      expect(await own()).toEqual(after);
      expect((await get('/ledger/opening-balances')).body.data).toEqual({
        balances: [],
      });
    });

    it('can be imported again once deleted', async () => {
      const res = await post('/ledger/opening-balances', {
        posted_on: IMPORT_AT,
        balances: [
          { code: '1010', debit: '5.00', credit: '0' },
          { code: '3900', debit: '0', credit: '5.00' },
        ],
      });
      expect(res.status).toBe(201);
      expect((await own())['1010']).toBe('5.00');
      expect((await own())['3900']).toBe('11995.00');
    });
  });
});
