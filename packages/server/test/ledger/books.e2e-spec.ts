import request = require('supertest');
import { INestApplication } from '@nestjs/common';
import {
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
 *                1200 Receivables  debit    200.00   against 3900
 *                2010 Payables     credit   300.25   against 3900
 *                3900 itself       credit   900.25   against itself: nothing
 *
 * So, each account's own balance, with everything in:
 *   1010 +1,000.50   1200 +200.00   2010 -300.25
 *   1590 -460.00     6500 +460.00
 *   3900 = -30,000 + 42,000 - 1,000.50 - 200 + 300.25 = +11,099.75
 * and once the import is deleted: 3900 = +12,000.00, and 1010, 1200 and
 * 2010 hold nothing.
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

const OPENED = '2031-01-02T18:00:00.000Z';
const IMPORT_AT = '2031-01-01T04:59:59.999Z';

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
    http()
      .post(path)
      .set(ws.headers())
      .send(body as any);
  const put = (path: string, body: unknown) =>
    http()
      .put(path)
      .set(ws.headers())
      .send(body as any);
  const del = (path: string) => http().delete(path).set(ws.headers());
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
      opening: { amount: '30000.00', posted_at: '2031-01-02T12:00:00-06:00' },
      ...extra,
    });

    it('is made with an account of its own under the marked account, and its opening entry', async () => {
      const res = await post('/ledger/fixed-assets', body());
      expect(res.status).toBe(201);
      truck = res.body.data;
      expect(truck).toEqual({
        id: expect.any(Number),
        external_id: 'fa-1',
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
        opening: { amount: '30000.00', posted_at: OPENED },
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
      expect(opening.posted_at).toBe(OPENED);
      expect(await rowsOf('OpeningBalance', opening.source_id)).toEqual([
        ['2031-01-02', 'both', '3900', '-30000.00'],
        ['2031-01-02', 'both', 'Truck', '30000.00'],
      ]);
    });

    it('answers the first asset unchanged when its external id is sent again', async () => {
      const again = await post(
        '/ledger/fixed-assets',
        body({ name: 'Another', cost: '1.00', opening: null }),
      );
      expect(again.status).toBe(201);
      expect(again.body.data).toEqual(truck);
      expect(
        (await get('/ledger/fixed-assets').expect(200)).body.pagination.total,
      ).toBe(1);
    });

    it('refuses a value update while it has no accumulated account', async () => {
      const res = await post('/ledger/fixed-assets/value-updates', {
        asset_id: truck.id,
        amount: '450.00',
        update_type: 'DEPRECIATION_AMORTIZATION',
        posted_at: '2031-01-31T18:00:00Z',
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
      posted_at: '2031-01-31T18:00:00Z',
      note: 'January',
      counter_account_slug: 'depreciation',
      ...extra,
    });

    it('debits the counter account and credits the accumulated account', async () => {
      const res = await post('/ledger/fixed-assets/value-updates', body());
      expect(res.status).toBe(201);
      u1 = res.body.data;
      expect(u1).toEqual({
        id: expect.any(Number),
        external_id: 'vu-1',
        asset_id: truck.id,
        amount: '450.00',
        update_type: 'DEPRECIATION_AMORTIZATION',
        posted_at: '2031-01-31T18:00:00.000Z',
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

    it('answers the first update unchanged when its external id is sent again', async () => {
      const again = await post(
        '/ledger/fixed-assets/value-updates',
        body({ amount: '1.00' }),
      );
      expect(again.status).toBe(201);
      expect(again.body.data).toEqual(u1);
    });

    it('is listed oldest dated first, and for one asset when one is named', async () => {
      u2 = (
        await post(
          '/ledger/fixed-assets/value-updates',
          body({
            external_id: 'vu-2',
            amount: '10.00',
            posted_at: '2031-01-15T18:00:00Z',
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
        closing_at: '2031-02-01T00:00:00-06:00',
      }).expect(200);
      try {
        const locked = await post(
          '/ledger/fixed-assets/value-updates',
          body({ external_id: 'vu-locked' }),
        );
        expect(locked.status).toBe(400);
        expect(errorType(locked)).toBe('TRANSACTIONS_DATE_LOCKED');
      } finally {
        await put('/ledger/settings', { closing_at: null }).expect(200);
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
      opening: { amount: '42000.00', posted_at: OPENED },
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
        opening: { amount: '42000.00', posted_at: OPENED },
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

    it('answers the first loan unchanged when its external id is sent again, and is read and listed', async () => {
      const again = await post('/ledger/loans', body({ name: 'Other' }));
      expect(again.status).toBe(201);
      expect(again.body.data).toEqual(note);
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
      { name: 'receivables', debit: '200.00', credit: '0' },
      { code: '2010', debit: '0', credit: '300.25' },
      { code: '3900', debit: '0.00', credit: '900.25' },
    ];

    it('are refused whole when a row names no account of the chart', async () => {
      const res = await post('/ledger/opening-balances', {
        posted_at: IMPORT_AT,
        balances: [...balances(), { code: '7777', debit: '1.00', credit: '0' }],
      });
      expect(res.status).toBe(400);
      expect(errorType(res)).toBe('OPENING_ACCOUNT_NOT_FOUND');
      expect((await own())['1010']).toBeUndefined();

      const twice = await post('/ledger/opening-balances', {
        posted_at: IMPORT_AT,
        balances: [
          { code: '1010', debit: '1.00', credit: '0' },
          { name: 'Operating', debit: '1.00', credit: '0' },
        ],
      });
      expect(twice.status).toBe(400);
      expect(errorType(twice)).toBe('OPENING_ACCOUNT_NAMED_TWICE');
    });

    it('are imported one entry an account, and answered in each account own direction', async () => {
      const res = await post('/ledger/opening-balances', {
        posted_at: IMPORT_AT,
        balances: balances(),
      });
      expect(res.status).toBe(201);
      expect(
        res.body.data.balances.map((b: any) => [
          b.account.code,
          b.amount,
          b.posted_at,
        ]),
      ).toEqual([
        ['1010', '1000.50', IMPORT_AT],
        ['1200', '200.00', IMPORT_AT],
        ['2010', '300.25', IMPORT_AT],
        ['3900', '900.25', IMPORT_AT],
      ]);
      expect((await get('/ledger/opening-balances')).body.data).toEqual(
        res.body.data,
      );
    });

    it('give the hand-worked books', async () => {
      expect(await own()).toEqual({
        '1010': '1000.50',
        '1200': '200.00',
        '1590': '-460.00',
        '2010': '-300.25',
        '3900': '11099.75',
        '6500': '460.00',
        Truck: '30000.00',
        'Bank Note': '-42000.00',
      });
    });

    it('post on the Central day of the instant, with a contact on the receivable and the payable', async () => {
      const entries = (await feed()).filter(
        (e: any) => e.posted_at === IMPORT_AT,
      );
      expect(entries.map((e: any) => [e.source_type, e.description])).toEqual([
        ['opening_balance', 'Opening balance for Operating'],
        ['opening_balance', 'Opening balance for Receivables'],
        ['opening_balance', 'Opening balance for Payables'],
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
      const contactOn = (code: string) =>
        rows
          .filter((row) => row.accountId === id[code])
          .map((row) => row.contactId);
      expect(contactOn('1200')).toEqual([expect.any(Number)]);
      expect(contactOn('2010')).toEqual([expect.any(Number)]);
      expect(contactOn('1010')).toEqual([null]);
    });

    it('are refused a second time, until the first are deleted', async () => {
      const res = await post('/ledger/opening-balances', {
        posted_at: IMPORT_AT,
        balances: balances(),
      });
      expect(res.status).toBe(400);
      expect(errorType(res)).toBe('OPENING_BALANCES_ALREADY_IMPORTED');
    });

    it('are held by the lock, on import and on delete', async () => {
      await put('/ledger/settings', {
        closing_at: '2031-01-01T00:00:00-06:00',
      }).expect(200);
      try {
        const res = await del('/ledger/opening-balances');
        expect(res.status).toBe(400);
        expect(errorType(res)).toBe('TRANSACTIONS_DATE_LOCKED');
      } finally {
        await put('/ledger/settings', { closing_at: null }).expect(200);
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
        posted_at: IMPORT_AT,
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
