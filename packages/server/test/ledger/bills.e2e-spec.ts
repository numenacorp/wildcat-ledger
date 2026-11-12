import request = require('supertest');
import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import {
  createTestApp,
  createTestWorkspace,
  dropOrganizations,
  TestWorkspace,
} from './harness';

/**
 * Vendors, bills and bill payments, on a workspace in America/Chicago.
 *
 * The main case, worked by hand:
 *
 *   B1  10 Mar   700.00 to 6000 Rent, 100.00 to 6100 Supplies,
 *                2 at 100.00 to 1500 Equipment          total 1,000.00
 *   P1  5 Apr    400.00 from 1010 Operating, all of it on B1
 *   P2  20 May   600.05 from no account named, 600.00 of it on B1
 *
 * Accrual. The bill posts on its day. Each payment's entry against
 * payables is dated on the BILL's day, so all of it lands in March:
 *   March   6000 +700  6100 +100  1500 +200  2010 -1,000 +400 +600 = 0
 *           1010 -400  2100 (clearing) -600
 *   April   nothing
 *   May     6900 (uncategorized) +0.05   2100 -0.05   (the 0.05 beyond B1)
 *
 * Cash. Nothing until money moves; then the bill's lines in proportion to
 * what was paid, on the day it was paid:
 *   April   P1 is 40% of the bill: 6000 +280  6100 +40  1500 +80  1010 -400
 *   May     P2 is 60%:             6000 +420  6100 +60  1500 +120 2100 -600
 *           and the 0.05:          6900 +0.05 2100 -0.05
 */
const chart = () => [
  { code: '1010', name: 'Operating', account_type: 'bank' },
  { code: '1200', name: 'Receivables', account_type: 'accounts-receivable' },
  {
    code: '1300',
    name: 'Clearing In',
    account_type: 'other-current-asset',
    slug: 'payments-in-clearing',
  },
  { code: '1500', name: 'Equipment', account_type: 'fixed-asset' },
  { code: '2010', name: 'Payables', account_type: 'accounts-payable' },
  {
    code: '2100',
    name: 'Clearing Out',
    account_type: 'other-current-liability',
    slug: 'payments-out-clearing',
    metadata: { label: 'OUT' },
  },
  { code: '2200', name: 'Card', account_type: 'credit-card' },
  { code: '3000', name: 'Equity', account_type: 'equity' },
  { code: '4000', name: 'Sales', account_type: 'income', slug: 'sales' },
  { code: '6000', name: 'Rent', account_type: 'expense' },
  { code: '6100', name: 'Supplies', account_type: 'expense' },
  {
    code: '6900',
    name: 'Uncategorized',
    account_type: 'other-expense',
    slug: 'uncategorized-expense',
  },
];

const MAR = { from: '2031-03-01T06:00:00Z', to: '2031-04-01T05:00:00Z' };
const APR = { from: '2031-04-01T05:00:00Z', to: '2031-05-01T05:00:00Z' };
const MAY = { from: '2031-05-01T05:00:00Z', to: '2031-06-01T05:00:00Z' };

describe('Ledger extension: vendors, bills and bill payments', () => {
  let app: INestApplication;
  let ws: TestWorkspace;
  let bare: TestWorkspace;
  let id: Record<string, number>;
  let codeOf: Record<number, string>;
  let b1: any;
  let p1: any;
  let p2: any;

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

  const entry = (code: string, rate: string, extra = {}) => ({
    account_id: id[code],
    rate,
    ...extra,
  });
  const bill = (postedAt: string, entries: unknown[], extra = {}) => ({
    external_id: `b:${randomUUID()}`,
    vendor_external_id: 'v-acme',
    posted_at: postedAt,
    entries,
    ...extra,
  });
  const payment = (
    paidAt: string,
    amount: string,
    allocations: Array<[number, string]>,
    extra = {},
  ) => ({
    external_id: `p:${randomUUID()}`,
    paid_at: paidAt,
    amount,
    allocations: allocations.map(([billId, a]) => ({
      bill_id: billId,
      amount: a,
    })),
    ...extra,
  });
  const balances = async (query: Record<string, unknown> = {}) =>
    Object.fromEntries(
      (await get('/ledger/accounts', query).expect(200)).body.data
        .filter((a: any) => a.code && a.balance !== '0.00')
        .map((a: any) => [a.code, a.balance]),
    );
  /**
   * The ledger rows of one document: day, basis, account and net, sorted.
   */
  const rowsOf = async (referenceType: string, referenceId: number) =>
    (await ws.rows('accounts_transactions', { referenceType, referenceId }))
      .map((row) => [
        row.date,
        row.basis ?? 'both',
        codeOf[row.accountId],
        (Number(row.debit) - Number(row.credit)).toFixed(2),
      ])
      .sort((a, b) => a.join('|').localeCompare(b.join('|')));

  beforeAll(async () => {
    app = await createTestApp();
    ws = await createTestWorkspace(app, { accounts: chart() });
    bare = await createTestWorkspace(app, {
      accounts: [
        { code: '1010', name: 'Operating', account_type: 'bank' },
        { code: '6000', name: 'Rent', account_type: 'expense' },
      ],
    });
    const accounts = (await get('/ledger/accounts').expect(200)).body.data;

    id = Object.fromEntries(accounts.map((a: any) => [a.code, a.id]));
    codeOf = Object.fromEntries(accounts.map((a: any) => [a.id, a.code]));
  });

  afterAll(async () => {
    await dropOrganizations(
      app,
      [ws, bare].filter(Boolean).map((w) => w.workspace.organization_id),
    );
    await app.close();
  });

  describe('the chart', () => {
    it('makes no account of its own, and keeps the marked ones from deletion', async () => {
      const accounts = (await get('/ledger/accounts')).body.data;

      expect(accounts.map((a: any) => a.code)).toEqual([
        '1010',
        '1200',
        '1300',
        '1500',
        '2010',
        '2100',
        '2200',
        '3000',
        '4000',
        '6000',
        '6100',
        '6900',
      ]);
      const clearing = accounts.find((a: any) => a.code === '2100');
      expect(clearing.deletable).toBe(false);

      const res = await del(`/ledger/accounts/${id['2100']}`);
      expect(res.status).toBe(400);
      expect(errorType(res)).toBe('account_predefined');
    });
  });

  describe('a vendor', () => {
    it('is created, then replaced whole by a repeat of its external id', async () => {
      const first = await post('/ledger/vendors', {
        external_id: 'v-1',
        company_name: 'Acme Supply',
        email: 'ap@acme.test',
        notes: 'net 30',
      });
      expect(first.status).toBe(201);
      expect(first.body.data).toEqual({
        id: expect.any(Number),
        external_id: 'v-1',
        company_name: 'Acme Supply',
        individual_name: null,
        email: 'ap@acme.test',
        mobile_phone: null,
        office_phone: null,
        address_string: null,
        notes: 'net 30',
        active: true,
      });

      const again = await post('/ledger/vendors', {
        external_id: 'v-1',
        individual_name: 'Pat Doe',
      });
      expect(again.status).toBe(200);
      expect(again.body.data).toEqual({
        ...first.body.data,
        company_name: null,
        individual_name: 'Pat Doe',
        email: null,
        notes: null,
      });

      const read = await get(`/ledger/vendors/${first.body.data.id}`);
      expect(read.body.data).toEqual(again.body.data);
    });

    it('needs no name, and is not found when it does not exist', async () => {
      const res = await post('/ledger/vendors', { external_id: 'v-noname' });
      expect(res.status).toBe(201);
      expect(res.body.data.company_name).toBeNull();

      const missing = await get('/ledger/vendors/99999999');
      expect(missing.status).toBe(404);
      expect(errorType(missing)).toBe('vendor_not_found');

      await post('/ledger/vendors', { name: 'x' }).expect(400);
    });
  });

  describe('a bill', () => {
    beforeAll(async () => {
      const res = await post(
        '/ledger/bills',
        bill(
          '2031-03-10T18:00:00Z',
          [
            entry('6000', '700.00', {
              external_id: 'b1-rent',
              item: 'Office rent',
              description: 'March',
              metadata: { camelKey: 1 },
              tracking: [{ category: 'Location', option: 'North' }],
            }),
            entry('6100', '100.00', { external_id: 'b1-supplies' }),
            entry('1500', '100.00', { quantity: '2' }),
          ],
          {
            due_at: '2031-04-09T18:00:00Z',
            reference: 'INV-77',
            note: 'First bill',
            metadata: { sourceDoc: 'scan-1' },
          },
        ),
      );
      expect(res.status).toBe(201);
      b1 = res.body.data;
    });

    it('is answered whole: priced lines, total, balance, status and its vendor', () => {
      expect(b1).toMatchObject({
        id: expect.any(Number),
        status: 'open',
        posted_at: '2031-03-10T18:00:00.000Z',
        due_at: '2031-04-09T18:00:00.000Z',
        terms: null,
        paid_at: null,
        voided_at: null,
        reference: 'INV-77',
        note: 'First bill',
        metadata: { sourceDoc: 'scan-1' },
        amount: '1000.00',
        balance: '1000.00',
        payments: [],
      });
      // A vendor external id not seen before is made, with no name.
      expect(b1.vendor).toMatchObject({
        external_id: 'v-acme',
        company_name: null,
        individual_name: null,
      });
      expect(b1.entries).toEqual([
        {
          id: expect.any(Number),
          external_id: 'b1-rent',
          account_id: id['6000'],
          account: {
            id: id['6000'],
            code: '6000',
            name: 'Rent',
            account_type: 'expense',
            metadata: null,
          },
          item: 'Office rent',
          description: 'March',
          rate: '700.00',
          quantity: '1',
          amount: '700.00',
          metadata: { camelKey: 1 },
          tracking: [
            {
              id: expect.any(Number),
              category: 'Location',
              option: 'North',
              option_name: 'North',
            },
          ],
        },
        expect.objectContaining({
          external_id: 'b1-supplies',
          amount: '100.00',
          tracking: [],
        }),
        expect.objectContaining({
          external_id: null,
          rate: '100.00',
          quantity: '2',
          amount: '200.00',
        }),
      ]);
    });

    it('debits each line and credits payables its total, on its Central day, accrual only', async () => {
      expect(await rowsOf('Bill', b1.id)).toEqual([
        ['2031-03-10', 'accrual', '1500', '200.00'],
        ['2031-03-10', 'accrual', '2010', '-1000.00'],
        ['2031-03-10', 'accrual', '6000', '700.00'],
        ['2031-03-10', 'accrual', '6100', '100.00'],
      ]);
      expect(await balances({ basis: 'accrual' })).toEqual({
        '1500': '200.00',
        '2010': '-1000.00',
        '6000': '700.00',
        '6100': '100.00',
      });
      // On the cash basis a bill posts nothing until it is paid.
      expect(await balances({ basis: 'cash' })).toEqual({});
    });

    it('is read back and listed', async () => {
      const read = await get(`/ledger/bills/${b1.id}`).expect(200);
      expect(read.body.data).toEqual(b1);

      const list = await get('/ledger/bills').expect(200);
      expect(list.body.pagination).toEqual({
        total: 1,
        page: 1,
        page_size: 50,
      });
      expect(list.body.data).toEqual([b1]);

      const missing = await get('/ledger/bills/99999999');
      expect(missing.status).toBe(404);
      expect(errorType(missing)).toBe('bill_not_found');
    });

    it('puts its tag on the ledger line of the account, with the line id', async () => {
      const lines = await get(`/ledger/accounts/${id['6000']}/lines`, {
        basis: 'accrual',
      }).expect(200);

      expect(lines.body.data).toEqual([
        {
          id: expect.any(Number),
          line_id: b1.entries[0].id,
          source_type: 'bill',
          source_id: b1.id,
          account: { id: id['6000'], code: '6000', name: 'Rent' },
          debit: '700.00',
          credit: '0.00',
          posted_at: '2031-03-10T18:00:00.000Z',
          tracking: [
            { category: 'Location', option: 'North', option_name: 'North' },
          ],
        },
      ]);
    });

    it('marks the accounts it posts to as used', async () => {
      const rent = (await get('/ledger/accounts')).body.data.find(
        (a: any) => a.code === '6000',
      );
      expect(rent.deletable).toBe(false);
    });
  });

  describe('bill payments', () => {
    beforeAll(async () => {
      const first = await post(
        '/ledger/bill-payments',
        payment('2031-04-05T18:00:00Z', '400.00', [[b1.id, '400.00']], {
          account_id: id['1010'],
          method: 'ACH',
          processor: 'CHECKBOOK',
          reference: 'PAY-1',
          note: 'Part',
          metadata: { runId: 'r1' },
        }),
      );
      expect(first.status).toBe(201);
      p1 = first.body.data;

      const second = await post(
        '/ledger/bill-payments',
        payment('2031-05-20T18:00:00Z', '600.05', [[b1.id, '600.00']], {
          method: 'CHECK',
        }),
      );
      expect(second.status).toBe(201);
      p2 = second.body.data;
    });

    it('are answered whole', () => {
      expect(p1).toEqual({
        id: expect.any(Number),
        external_id: expect.stringMatching(/^p:/),
        paid_at: '2031-04-05T18:00:00.000Z',
        method: 'ACH',
        processor: 'CHECKBOOK',
        amount: '400.00',
        account: {
          id: id['1010'],
          code: '1010',
          name: 'Operating',
          account_type: 'bank',
          metadata: null,
        },
        reference: 'PAY-1',
        note: 'Part',
        metadata: { runId: 'r1' },
        allocations: [
          { id: expect.any(Number), bill_id: b1.id, amount: '400.00' },
        ],
        created_at: expect.any(String),
      });
      // No account named: the answer says none, though the money went to
      // the clearing account.
      expect(p2.account).toBeNull();
      expect(p2.amount).toBe('600.05');
    });

    it('post against payables on the BILL day, and recognise the lines on the day paid', async () => {
      expect(await rowsOf('BillPayment', p1.id)).toEqual([
        ['2031-03-10', 'accrual', '1010', '-400.00'],
        ['2031-03-10', 'accrual', '2010', '400.00'],
        ['2031-04-05', 'cash', '1010', '-400.00'],
        ['2031-04-05', 'cash', '1500', '80.00'],
        ['2031-04-05', 'cash', '6000', '280.00'],
        ['2031-04-05', 'cash', '6100', '40.00'],
      ]);
      expect(await rowsOf('BillPayment', p2.id)).toEqual([
        ['2031-03-10', 'accrual', '2010', '600.00'],
        ['2031-03-10', 'accrual', '2100', '-600.00'],
        ['2031-05-20', 'both', '2100', '-0.05'],
        ['2031-05-20', 'both', '6900', '0.05'],
        ['2031-05-20', 'cash', '1500', '120.00'],
        ['2031-05-20', 'cash', '2100', '-600.00'],
        ['2031-05-20', 'cash', '6000', '420.00'],
        ['2031-05-20', 'cash', '6100', '60.00'],
      ]);
    });

    it('give the hand-worked accrual books, month by month', async () => {
      expect(await balances({ basis: 'accrual', ...MAR })).toEqual({
        '1010': '-400.00',
        '1500': '200.00',
        '2100': '-600.00',
        '6000': '700.00',
        '6100': '100.00',
      });
      expect(await balances({ basis: 'accrual', ...APR })).toEqual({});
      expect(await balances({ basis: 'accrual', ...MAY })).toEqual({
        '2100': '-0.05',
        '6900': '0.05',
      });
      expect(await balances({ basis: 'accrual' })).toEqual({
        '1010': '-400.00',
        '1500': '200.00',
        '2100': '-600.05',
        '6000': '700.00',
        '6100': '100.00',
        '6900': '0.05',
      });
    });

    it('give the hand-worked cash books, month by month', async () => {
      expect(await balances({ basis: 'cash', ...MAR })).toEqual({});
      expect(await balances({ basis: 'cash', ...APR })).toEqual({
        '1010': '-400.00',
        '1500': '80.00',
        '6000': '280.00',
        '6100': '40.00',
      });
      expect(await balances({ basis: 'cash', ...MAY })).toEqual({
        '1500': '120.00',
        '2100': '-600.05',
        '6000': '420.00',
        '6100': '60.00',
        '6900': '0.05',
      });
      // Paid in full, both bases agree to date.
      expect(await balances({ basis: 'cash' })).toEqual(
        await balances({ basis: 'accrual' }),
      );
    });

    it('settle the bill: paid, nothing owed, paid at the latest payment', async () => {
      const read = (await get(`/ledger/bills/${b1.id}`)).body.data;

      expect(read.status).toBe('paid');
      expect(read.amount).toBe('1000.00');
      expect(read.balance).toBe('0.00');
      expect(read.paid_at).toBe('2031-05-20T18:00:00.000Z');
      expect(
        read.payments.map((p: any) => [p.payment_id, p.amount, p.payment.id]),
      ).toEqual([
        [p1.id, '400.00', p1.id],
        [p2.id, '600.00', p2.id],
      ]);
      expect(read.payments[0].payment).toEqual(p1);
    });

    it('carry the line tag onto the cash rows', async () => {
      const lines = await get(`/ledger/accounts/${id['6000']}/lines`, {
        basis: 'cash',
      }).expect(200);

      expect(
        lines.body.data.map((l: any) => [
          l.source_type,
          l.posted_at,
          l.debit,
          l.tracking.map((t: any) => t.option),
        ]),
      ).toEqual([
        ['bill_payment', '2031-05-20T18:00:00.000Z', '420.00', ['North']],
        ['bill_payment', '2031-04-05T18:00:00.000Z', '280.00', ['North']],
      ]);
    });

    it('are read back, and not found when they do not exist', async () => {
      expect((await get(`/ledger/bill-payments/${p1.id}`)).body.data).toEqual(
        p1,
      );
      const missing = await get('/ledger/bill-payments/99999999');
      expect(missing.status).toBe(404);
      expect(errorType(missing)).toBe('bill_payment_not_found');
    });

    it('show in the feed as one entry on each day they post', async () => {
      const feed = await get('/ledger/entries', {
        basis: 'accrual',
        order: 'asc',
      }).expect(200);

      expect(
        feed.body.data.map((e: any) => [
          e.source_type,
          e.source_id,
          e.posted_at,
          e.entries.length,
        ]),
      ).toEqual([
        // The bill, and each payment's entry against payables, on the
        // bill's instant.
        ['bill', b1.id, '2031-03-10T18:00:00.000Z', 4],
        ['bill_payment', p1.id, '2031-03-10T18:00:00.000Z', 2],
        ['bill_payment', p2.id, '2031-03-10T18:00:00.000Z', 2],
        // The 0.05 beyond the bill, on the day it was paid.
        ['bill_payment', p2.id, '2031-05-20T18:00:00.000Z', 2],
      ]);
      expect(feed.body.data[0].description).toBe('First bill');
      expect(feed.body.data[0].reference).toBe('INV-77');
      expect(feed.body.data[1].reference).toBe('PAY-1');
    });
  });

  describe('refused payments', () => {
    const refused = async (body: unknown, type: string, status = 400) => {
      const before = (await ws.rows('ext_payments')).length;
      const res = await post('/ledger/bill-payments', body);

      expect(res.status).toBe(status);
      expect(errorType(res)).toBe(type);
      expect(await ws.rows('ext_payments')).toHaveLength(before);
    };

    it('more allocated to a bill than it owes', async () => {
      await refused(
        payment('2031-05-21T18:00:00Z', '0.01', [[b1.id, '0.01']]),
        'BILL_ALLOCATION_EXCEEDS_BALANCE',
      );
    });

    it('an amount below what it allocates', async () => {
      await refused(
        payment('2031-05-21T18:00:00Z', '5.00', [[b1.id, '6.00']]),
        'PAYMENT_AMOUNT_BELOW_ALLOCATIONS',
      );
    });

    it('a bill or an account that does not exist', async () => {
      await refused(
        payment('2031-05-21T18:00:00Z', '5.00', [[99999999, '5.00']]),
        'PAYMENT_BILL_NOT_FOUND',
      );
      await refused(
        payment('2031-05-21T18:00:00Z', '5.00', [], { account_id: 99999999 }),
        'account_not_found',
        404,
      );
    });

    it('a malformed body', async () => {
      const good = payment('2031-05-21T18:00:00Z', '5.00', []);

      await post('/ledger/bill-payments', { ...good, amount: '-5.00' }).expect(
        400,
      );
      await post('/ledger/bill-payments', { ...good, amount: '5.001' }).expect(
        400,
      );
      await post('/ledger/bill-payments', { ...good, paid_at: 'May' }).expect(
        400,
      );
      await post('/ledger/bill-payments', { ...good, vendor: 1 }).expect(400);
    });
  });

  describe('a payment that does not divide evenly', () => {
    it('shares 0.05 over lines of 7.00, 1.00 and 2.00 as 0.03, 0.01 and 0.01', async () => {
      const small = (
        await post(
          '/ledger/bills',
          bill('2031-06-02T17:00:00Z', [
            entry('6000', '7.00'),
            entry('6100', '1.00'),
            entry('1500', '2.00'),
          ]),
        )
      ).body.data;
      const paid = (
        await post(
          '/ledger/bill-payments',
          payment('2031-06-03T17:00:00Z', '0.05', [[small.id, '0.05']], {
            account_id: id['2200'],
          }),
        )
      ).body.data;

      // 3.5, 0.5 and 1 cents round to 4, 1 and 1: one too many, taken off
      // the largest line. A card may pay.
      expect(await rowsOf('BillPayment', paid.id)).toEqual([
        ['2031-06-02', 'accrual', '2010', '0.05'],
        ['2031-06-02', 'accrual', '2200', '-0.05'],
        ['2031-06-03', 'cash', '1500', '0.01'],
        ['2031-06-03', 'cash', '2200', '-0.05'],
        ['2031-06-03', 'cash', '6000', '0.03'],
        ['2031-06-03', 'cash', '6100', '0.01'],
      ]);
      const read = (await get(`/ledger/bills/${small.id}`)).body.data;
      expect([read.status, read.balance, read.paid_at]).toEqual([
        'partially_paid',
        '9.95',
        null,
      ]);
    });
  });

  describe('editing a bill', () => {
    let edited: any;
    let paid: any;

    beforeAll(async () => {
      // 100.00 to rent on 10 June; 50.00 paid on 15 June.
      edited = (
        await post(
          '/ledger/bills',
          bill('2031-06-10T17:00:00Z', [
            entry('6000', '100.00', { external_id: 'keep' }),
          ]),
        )
      ).body.data;
      paid = (
        await post(
          '/ledger/bill-payments',
          payment('2031-06-15T17:00:00Z', '50.00', [[edited.id, '50.00']], {
            account_id: id['1010'],
          }),
        )
      ).body.data;
    });

    it('refuses a total below what is paid, and changes nothing', async () => {
      const res = await put(`/ledger/bills/${edited.id}`, {
        vendor_external_id: 'v-acme',
        posted_at: '2031-06-10T17:00:00Z',
        entries: [entry('6000', '49.99')],
      });
      expect(res.status).toBe(400);
      expect(errorType(res)).toBe('BILL_AMOUNT_BELOW_PAID');
      expect((await get(`/ledger/bills/${edited.id}`)).body.data.amount).toBe(
        '100.00',
      );
    });

    it('takes new lines, keeps a line id by its external id, and leaves the earlier payment split as it was', async () => {
      const res = await put(`/ledger/bills/${edited.id}`, {
        vendor_external_id: 'v-acme',
        posted_at: '2031-06-10T17:00:00Z',
        entries: [
          entry('6100', '100.00'),
          entry('6000', '100.00', { external_id: 'keep' }),
        ],
      });
      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(edited.id);
      expect(res.body.data.external_id).toBe(edited.external_id);
      expect(res.body.data.amount).toBe('200.00');
      expect(res.body.data.balance).toBe('150.00');
      expect(res.body.data.status).toBe('partially_paid');
      // The kept line moved to second place and kept its id.
      expect(res.body.data.entries[1].id).toBe(edited.entries[0].id);
      expect(res.body.data.entries[0].id).not.toBe(edited.entries[0].id);

      expect(await rowsOf('Bill', edited.id)).toEqual([
        ['2031-06-10', 'accrual', '2010', '-200.00'],
        ['2031-06-10', 'accrual', '6000', '100.00'],
        ['2031-06-10', 'accrual', '6100', '100.00'],
      ]);
      // The 50.00 was paid when the bill was all rent, and stays all rent.
      expect(await rowsOf('BillPayment', paid.id)).toEqual([
        ['2031-06-10', 'accrual', '1010', '-50.00'],
        ['2031-06-10', 'accrual', '2010', '50.00'],
        ['2031-06-15', 'cash', '1010', '-50.00'],
        ['2031-06-15', 'cash', '6000', '50.00'],
      ]);
    });

    it('moves a payment entry against payables with the bill day', async () => {
      await put(`/ledger/bills/${edited.id}`, {
        vendor_external_id: 'v-acme',
        posted_at: '2031-07-02T17:00:00Z',
        entries: [
          entry('6100', '100.00'),
          entry('6000', '100.00', { external_id: 'keep' }),
        ],
      }).expect(200);

      expect(await rowsOf('BillPayment', paid.id)).toEqual([
        ['2031-06-15', 'cash', '1010', '-50.00'],
        ['2031-06-15', 'cash', '6000', '50.00'],
        ['2031-07-02', 'accrual', '1010', '-50.00'],
        ['2031-07-02', 'accrual', '2010', '50.00'],
      ]);
    });

    it('a repeat of the external id replaces the bill under the same id', async () => {
      const res = await post(
        '/ledger/bills',
        bill('2031-07-02T17:00:00Z', [entry('6000', '75.00')], {
          external_id: edited.external_id,
          note: 'replaced',
        }),
      );
      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(edited.id);
      expect(res.body.data.note).toBe('replaced');
      expect(res.body.data.amount).toBe('75.00');
      expect(res.body.data.balance).toBe('25.00');
      expect(
        await ws.rows('ext_trade_documents', { id: edited.id }),
      ).toHaveLength(1);

      // The rules of an edit apply: below the 50.00 paid is refused.
      const below = await post(
        '/ledger/bills',
        bill('2031-07-02T17:00:00Z', [entry('6000', '10.00')], {
          external_id: edited.external_id,
        }),
      );
      expect(errorType(below)).toBe('BILL_AMOUNT_BELOW_PAID');
    });

    it('is not found for a bill that does not exist, and refused for an unknown account', async () => {
      const body = {
        vendor_external_id: 'v-acme',
        posted_at: '2031-07-02T17:00:00Z',
        entries: [entry('6000', '1.00')],
      };
      expect((await put('/ledger/bills/99999999', body)).status).toBe(404);

      const res = await put(`/ledger/bills/${edited.id}`, {
        ...body,
        entries: [{ account_id: 99999999, rate: '1.00' }],
      });
      expect(res.status).toBe(404);
      expect(errorType(res)).toBe('account_not_found');
    });
  });

  describe('totals', () => {
    it('a bill with no lines is paid from the start, with no paid day and no entry', async () => {
      const res = await post('/ledger/bills', bill('2031-08-01T17:00:00Z', []));
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({
        status: 'paid',
        amount: '0.00',
        balance: '0.00',
        paid_at: null,
        entries: [],
      });
      expect(await rowsOf('Bill', res.body.data.id)).toEqual([]);
    });

    it('a bill that totals zero is paid from the start, and posts its lines', async () => {
      const res = await post(
        '/ledger/bills',
        bill('2031-08-01T17:00:00Z', [
          entry('6000', '30.00'),
          entry('6100', '-30.00'),
        ]),
      );
      expect(res.body.data).toMatchObject({ status: 'paid', amount: '0.00' });
      expect(await rowsOf('Bill', res.body.data.id)).toEqual([
        ['2031-08-01', 'accrual', '6000', '30.00'],
        ['2031-08-01', 'accrual', '6100', '-30.00'],
      ]);
    });

    it('a bill that totals less than zero is open, owing a negative amount', async () => {
      const res = await post(
        '/ledger/bills',
        bill('2031-08-01T17:00:00Z', [
          entry('6000', '20.00'),
          entry('6100', '-70.00'),
        ]),
      );
      expect(res.body.data).toMatchObject({
        status: 'open',
        amount: '-50.00',
        balance: '-50.00',
      });
      expect(await rowsOf('Bill', res.body.data.id)).toEqual([
        ['2031-08-01', 'accrual', '2010', '50.00'],
        ['2031-08-01', 'accrual', '6000', '20.00'],
        ['2031-08-01', 'accrual', '6100', '-70.00'],
      ]);
    });

    it('prices a line to the cent, and is due on receipt when its terms say so', async () => {
      // 2.5 at 0.333 is 0.8325, which is 0.83.
      const res = await post(
        '/ledger/bills',
        bill(
          '2031-08-02T17:00:00Z',
          [entry('6000', '0.333', { quantity: '2.5' })],
          { terms: 'due_on_receipt', due_at: '2031-09-01T17:00:00Z' },
        ),
      );
      expect(res.body.data.entries[0].amount).toBe('0.83');
      expect(res.body.data.amount).toBe('0.83');
      expect(res.body.data.terms).toBe('due_on_receipt');
      expect(res.body.data.due_at).toBe('2031-08-02T17:00:00.000Z');
    });

    it('refuses a bill with no vendor, with two, with an unknown one, or malformed', async () => {
      const body = bill('2031-08-02T17:00:00Z', [entry('6000', '1.00')]);
      const { vendor_external_id: _v, ...noVendor } = body;

      expect(errorType(await post('/ledger/bills', noVendor))).toBe(
        'VENDOR_REQUIRED',
      );
      expect(
        errorType(await post('/ledger/bills', { ...body, vendor_id: 1 })),
      ).toBe('VENDOR_REQUIRED');

      const unknown = await post('/ledger/bills', {
        ...noVendor,
        vendor_id: 99999999,
      });
      expect(unknown.status).toBe(404);
      expect(errorType(unknown)).toBe('vendor_not_found');

      await post('/ledger/bills', {
        ...body,
        entries: [{ account_id: id['6000'], rate: 'ten' }],
      }).expect(400);
      await post('/ledger/bills', { ...body, total: '1.00' }).expect(400);
    });
  });

  describe('voiding a bill', () => {
    let voided: any;
    const body = () =>
      bill('2031-09-01T17:00:00Z', [
        entry('6000', '60.00'),
        entry('6100', '40.00'),
      ]);

    beforeAll(async () => {
      voided = (await post('/ledger/bills', body())).body.data;
    });

    it('takes its entry out of the books and leaves the bill, with its amount and balance', async () => {
      const res = await post(`/ledger/bills/${voided.id}/void`);

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        id: voided.id,
        status: 'voided',
        amount: '100.00',
        balance: '100.00',
        voided_at: expect.any(String),
      });
      expect(await rowsOf('Bill', voided.id)).toEqual([]);
      expect((await get(`/ledger/bills/${voided.id}`)).body.data.status).toBe(
        'voided',
      );
    });

    it('a second void changes nothing', async () => {
      const first = (await get(`/ledger/bills/${voided.id}`)).body.data;
      const again = await post(`/ledger/bills/${voided.id}/void`);

      expect(again.status).toBe(200);
      expect(again.body.data).toEqual(first);
    });

    it('can still be edited, and stays voided with no entry', async () => {
      const res = await put(`/ledger/bills/${voided.id}`, {
        vendor_external_id: 'v-acme',
        posted_at: '2031-09-02T17:00:00Z',
        entries: [entry('6000', '80.00')],
      });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        status: 'voided',
        amount: '80.00',
      });
      expect(await rowsOf('Bill', voided.id)).toEqual([]);
    });

    it('its external id takes a new body and stays voided', async () => {
      const res = await post(
        '/ledger/bills',
        bill('2031-09-02T17:00:00Z', [entry('6100', '90.00')], {
          external_id: voided.external_id,
        }),
      );
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        id: voided.id,
        status: 'voided',
        amount: '90.00',
      });
      expect(await rowsOf('Bill', voided.id)).toEqual([]);
    });

    it('can still be paid: the payment posts, the bill does not', async () => {
      const paid = await post(
        '/ledger/bill-payments',
        payment('2031-09-05T17:00:00Z', '30.00', [[voided.id, '30.00']], {
          account_id: id['1010'],
        }),
      );
      expect(paid.status).toBe(201);
      expect(await rowsOf('BillPayment', paid.body.data.id)).toEqual([
        ['2031-09-02', 'accrual', '1010', '-30.00'],
        ['2031-09-02', 'accrual', '2010', '30.00'],
        ['2031-09-05', 'cash', '1010', '-30.00'],
        ['2031-09-05', 'cash', '6100', '30.00'],
      ]);
      const read = (await get(`/ledger/bills/${voided.id}`)).body.data;
      expect([read.status, read.balance]).toEqual(['voided', '60.00']);

      await del(`/ledger/bill-payments/${paid.body.data.id}`).expect(200);
    });

    it('is refused while the bill has a payment', async () => {
      const res = await post(`/ledger/bills/${b1.id}/void`);

      expect(res.status).toBe(400);
      expect(errorType(res)).toBe('BILL_HAS_PAYMENTS');
      expect((await get(`/ledger/bills/${b1.id}`)).body.data.status).toBe(
        'paid',
      );
    });
  });

  describe('deleting and repeating a payment', () => {
    let owed: any;
    const pay = (amount: string, extra = {}) =>
      post(
        '/ledger/bill-payments',
        payment('2031-10-05T17:00:00Z', amount, [[owed.id, amount]], {
          account_id: id['1010'],
          ...extra,
        }),
      );

    beforeAll(async () => {
      owed = (
        await post(
          '/ledger/bills',
          bill('2031-10-01T17:00:00Z', [entry('6000', '100.00')]),
        )
      ).body.data;
    });

    it('a repeat of the external id replaces the payment under the same id', async () => {
      const first = await pay('40.00');
      const again = await pay('25.00', {
        external_id: first.body.data.external_id,
      });

      expect(again.status).toBe(200);
      expect(again.body.data.id).toBe(first.body.data.id);
      expect(again.body.data.amount).toBe('25.00');
      expect(await rowsOf('BillPayment', first.body.data.id)).toEqual([
        ['2031-10-01', 'accrual', '1010', '-25.00'],
        ['2031-10-01', 'accrual', '2010', '25.00'],
        ['2031-10-05', 'cash', '1010', '-25.00'],
        ['2031-10-05', 'cash', '6000', '25.00'],
      ]);
      expect((await get(`/ledger/bills/${owed.id}`)).body.data.balance).toBe(
        '75.00',
      );
      // It may grow to all the bill owes, its own 25.00 not counted against it.
      const whole = await pay('100.00', {
        external_id: first.body.data.external_id,
      });
      expect(whole.status).toBe(200);
      expect((await get(`/ledger/bills/${owed.id}`)).body.data.status).toBe(
        'paid',
      );
      await del(`/ledger/bill-payments/${first.body.data.id}`).expect(200);
    });

    it('deleting takes its entries out, and the bill owes again', async () => {
      const paid = (await pay('100.00')).body.data;
      expect((await get(`/ledger/bills/${owed.id}`)).body.data.status).toBe(
        'paid',
      );

      const res = await del(`/ledger/bill-payments/${paid.id}`);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ ...paid, allocations: [] });
      expect(await rowsOf('BillPayment', paid.id)).toEqual([]);

      const read = (await get(`/ledger/bills/${owed.id}`)).body.data;
      expect([read.status, read.balance, read.paid_at, read.payments]).toEqual([
        'open',
        '100.00',
        null,
        [],
      ]);

      // A second delete is answered the same; a read is not found.
      const again = await del(`/ledger/bill-payments/${paid.id}`);
      expect(again.status).toBe(200);
      expect(again.body.data).toEqual(res.body.data);
      expect((await get(`/ledger/bill-payments/${paid.id}`)).status).toBe(404);

      // Its external id makes a new payment.
      const fresh = await pay('10.00', { external_id: paid.external_id });
      expect(fresh.status).toBe(201);
      expect(fresh.body.data.id).not.toBe(paid.id);
      await del(`/ledger/bill-payments/${fresh.body.data.id}`).expect(200);
    });

    it('eight simultaneous payments of one external id make one payment', async () => {
      const body = payment('2031-10-06T17:00:00Z', '10.00', [
        [owed.id, '10.00'],
      ]);
      const results = await Promise.all(
        Array.from({ length: 8 }, () => post('/ledger/bill-payments', body)),
      );
      expect(results.map((r) => r.status).sort()).toEqual([
        200, 200, 200, 200, 200, 200, 200, 201,
      ]);
      const paymentId = results[0].body.data.id;
      expect(new Set(results.map((r) => r.body.data.id)).size).toBe(1);
      expect(await rowsOf('BillPayment', paymentId)).toHaveLength(4);
      expect((await get(`/ledger/bills/${owed.id}`)).body.data.balance).toBe(
        '90.00',
      );
      await del(`/ledger/bill-payments/${paymentId}`).expect(200);
    });

    it('simultaneous payments cannot overpay a bill between them', async () => {
      // Six payments of 30.00 on a bill that owes 100.00: three fit.
      const results = await Promise.all(
        Array.from({ length: 6 }, () => pay('30.00')),
      );
      expect(results.map((r) => r.status).sort()).toEqual([
        201, 201, 201, 400, 400, 400,
      ]);
      expect((await get(`/ledger/bills/${owed.id}`)).body.data.balance).toBe(
        '10.00',
      );
    });
  });

  describe('listing bills', () => {
    it('filters by status, in the words the bill itself answers', async () => {
      const all = (await get('/ledger/bills', { page_size: 200 })).body.data;
      const byStatus = (status: string) =>
        all
          .filter((b: any) => status.split(',').includes(b.status))
          .map((b: any) => b.id);

      for (const status of [
        'open',
        'partially_paid',
        'paid',
        'voided',
        'open,partially_paid',
      ]) {
        const listed = await get('/ledger/bills', { status, page_size: 200 });
        expect(listed.status).toBe(200);
        expect(listed.body.data.map((b: any) => b.id)).toEqual(
          byStatus(status),
        );
        expect(listed.body.pagination.total).toBe(byStatus(status).length);
      }
      expect(new Set(all.map((b: any) => b.status))).toEqual(
        new Set(['open', 'partially_paid', 'paid', 'voided']),
      );
      await get('/ledger/bills', { status: 'late' }).expect(400);
    });

    it('is ordered by the instant received, and takes a range that includes both ends', async () => {
      const all = (await get('/ledger/bills', { page_size: 200 })).body.data;
      const instants = all.map((b: any) => b.posted_at);
      expect(instants).toEqual([...instants].sort());

      const march = await get('/ledger/bills', {
        from: '2031-03-10T18:00:00Z',
        to: '2031-03-10T18:00:00Z',
      });
      expect(march.body.data.map((b: any) => b.id)).toEqual([b1.id]);

      const byExternalId = await get('/ledger/bills', {
        external_id: b1.external_id,
      });
      expect(byExternalId.body.data.map((b: any) => b.id)).toEqual([b1.id]);

      const paged = await get('/ledger/bills', { page: 2, page_size: 1 });
      expect(paged.body.data.map((b: any) => b.id)).toEqual([all[1].id]);
    });
  });

  describe('the lock', () => {
    // Everything before 1 April, Central, is closed: B1 is in March.
    const locked = (res: request.Response) => {
      expect(res.status).toBe(400);
      expect(errorType(res)).toBe('TRANSACTIONS_DATE_LOCKED');
    };

    beforeAll(() =>
      put('/ledger/settings', { closing_at: '2031-04-01T05:00:00Z' }).expect(
        200,
      ),
    );
    afterAll(() => put('/ledger/settings', { closing_at: null }).expect(200));

    it('refuses a bill in the closed period, and an edit into or out of it', async () => {
      locked(
        await post(
          '/ledger/bills',
          bill('2031-03-31T17:00:00Z', [entry('6000', '1.00')]),
        ),
      );
      const open = (
        await post(
          '/ledger/bills',
          bill('2031-11-01T17:00:00Z', [entry('6000', '1.00')]),
        )
      ).body.data;
      locked(
        await put(`/ledger/bills/${open.id}`, {
          vendor_external_id: 'v-acme',
          posted_at: '2031-03-31T17:00:00Z',
          entries: [entry('6000', '1.00')],
        }),
      );
      locked(
        await put(`/ledger/bills/${b1.id}`, {
          vendor_external_id: 'v-acme',
          posted_at: '2031-11-01T17:00:00Z',
          entries: [entry('6000', '1000.00')],
        }),
      );
      await post(`/ledger/bills/${open.id}/void`).expect(200);
    });

    it('refuses a payment on a bill in the closed period, whatever day it is paid', async () => {
      // A fresh March bill cannot be made now, so lift the lock to make one.
      await put('/ledger/settings', { closing_at: null }).expect(200);
      const march = (
        await post(
          '/ledger/bills',
          bill('2031-03-20T17:00:00Z', [entry('6000', '10.00')]),
        )
      ).body.data;
      const paid = (
        await post(
          '/ledger/bill-payments',
          payment('2031-11-02T17:00:00Z', '4.00', [[march.id, '4.00']], {
            account_id: id['1010'],
          }),
        )
      ).body.data;
      await put('/ledger/settings', {
        closing_at: '2031-04-01T05:00:00Z',
      }).expect(200);

      locked(
        await post(
          '/ledger/bill-payments',
          payment('2031-11-03T17:00:00Z', '1.00', [[march.id, '1.00']], {
            account_id: id['1010'],
          }),
        ),
      );
      // Deleting one is refused too, and so is voiding the bill.
      locked(await del(`/ledger/bill-payments/${paid.id}`));
      expect((await get(`/ledger/bill-payments/${paid.id}`)).status).toBe(200);
      await put('/ledger/settings', { closing_at: null }).expect(200);
      await del(`/ledger/bill-payments/${paid.id}`).expect(200);
      await put('/ledger/settings', {
        closing_at: '2031-04-01T05:00:00Z',
      }).expect(200);
      locked(await post(`/ledger/bills/${march.id}/void`));
    });
  });

  describe('a chart that marks no account', () => {
    it('refuses the payment that needs one, and takes the one that does not', async () => {
      const headers = bare.headers();
      const accounts = (
        await http().get('/ledger/accounts').set(headers).expect(200)
      ).body.data;
      const account = (code: string) =>
        accounts.find((a: any) => a.code === code).id;
      const created = await http()
        .post('/ledger/bills')
        .set(headers)
        .send({
          vendor_external_id: 'v',
          posted_at: '2031-03-10T18:00:00Z',
          entries: [{ account_id: account('6000'), rate: '10.00' }],
        });
      expect(created.status).toBe(201);

      const pay = (body: Record<string, unknown>) =>
        http()
          .post('/ledger/bill-payments')
          .set(headers)
          .send({
            paid_at: '2031-03-11T18:00:00Z',
            allocations: [{ bill_id: created.body.data.id, amount: '5.00' }],
            ...body,
          });
      // No account named: there is no clearing account to hold the money.
      const noAccount = await pay({ amount: '5.00' });
      expect(noAccount.status).toBe(400);
      expect(errorType(noAccount)).toBe('LEDGER_ACCOUNT_NOT_MARKED');
      expect(noAccount.body.errors[0].payload).toEqual({
        slug: 'payments-out-clearing',
      });

      // More than its bills: there is no account for the rest.
      const excess = await pay({ amount: '6.00', account_id: account('1010') });
      expect(errorType(excess)).toBe('LEDGER_ACCOUNT_NOT_MARKED');
      expect(excess.body.errors[0].payload).toEqual({
        slug: 'uncategorized-expense',
      });

      const fine = await pay({ amount: '5.00', account_id: account('1010') });
      expect(fine.status).toBe(201);
    });
  });
});
