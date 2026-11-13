import request = require('supertest');
import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import {
  change,
  createTestApp,
  createTestTags,
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
 * Accrual. The bill posts on its day, and each payment on the day paid:
 *   March   6000 +700  6100 +100  1500 +200  2010 -1,000
 *   April   2010 +400  1010 -400
 *   May     2010 +600  2100 (clearing) -600
 *           2010 +0.05   2100 -0.05   (the 0.05 beyond B1: a credit with
 *           the vendor, on payables)
 *
 * Cash. Nothing until money moves; then each line its share of what was
 * paid, which is the payment shared over what is unpaid on each line:
 *   April   P1, on 700, 100 and 200:  6000 +280  6100 +40  1500 +80  1010 -400
 *   May     P2, on 420, 60 and 120:   6000 +420  6100 +60  1500 +120 2100 -600
 *           and the 0.05:             6900 +0.05 2100 -0.05
 *           (unapplied cash: this chart marks no account for it, so the
 *           uncategorized account stands in)
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

const MAR = { from: '2031-03-01', to: '2031-03-31' };
const APR = { from: '2031-04-01', to: '2031-04-30' };
const MAY = { from: '2031-05-01', to: '2031-05-31' };

describe('Ledger extension: vendors, bills and bill payments', () => {
  let app: INestApplication;
  let ws: TestWorkspace;
  let bare: TestWorkspace;
  let id: Record<string, number>;
  let codeOf: Record<number, string>;
  let b1: any;
  let b1Body: any;
  let p1: any;
  let p2: any;

  const http = () => request(app.getHttpServer());
  const get = (path: string, query: Record<string, unknown> = {}) =>
    http().get(path).query(query).set(ws.headers());
  const post = (path: string, body: unknown = {}) =>
    change(app, 'post', path, ws.headers(), body);
  const put = (path: string, body: unknown) =>
    change(app, 'put', path, ws.headers(), body);
  const del = (path: string) => change(app, 'delete', path, ws.headers());
  /** A change sent exactly as written: no version is read and added for it. */
  const bareCall = (method: 'post' | 'put' | 'delete', path: string) =>
    http()[method](path).set(ws.headers());
  const error = (res: request.Response) => res.body?.errors?.[0];
  const errorType = (res: request.Response) => res.body?.errors?.[0]?.type;

  const entry = (code: string, rate: string, extra = {}) => ({
    account_id: id[code],
    rate,
    ...extra,
  });
  const bill = (postedOn: string, entries: unknown[], extra = {}) => ({
    external_id: `b:${randomUUID()}`,
    vendor_external_id: 'v-acme',
    posted_on: postedOn,
    entries,
    ...extra,
  });
  const payment = (
    paidOn: string,
    amount: string,
    allocations: Array<[number, string]>,
    extra = {},
  ) => ({
    external_id: `p:${randomUUID()}`,
    paid_on: paidOn,
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
    // A line names tags that exist: the ones the bills below carry are made
    // first.
    await createTestTags(app, ws.headers(), 'Location', ['North', 'South']);
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
    let vendor: any;
    const fields = {
      external_id: 'v-1',
      company_name: 'Acme Supply',
      email: 'ap@acme.test',
      notes: 'net 30',
    };

    it('is created at version 1, and a repeat with the same fields answers it again', async () => {
      const first = await post('/ledger/vendors', fields);
      expect(first.status).toBe(201);
      expect(first.body).toEqual({
        data: {
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
          version: 1,
        },
      });
      vendor = first.body.data;

      const again = await post('/ledger/vendors', fields);
      expect(again.status).toBe(200);
      expect(again.body).toEqual({ data: vendor, replayed: true });
      expect(
        await ws.rows('ext_external_ids', { externalId: 'v-1' }),
      ).toHaveLength(1);
    });

    it('is not changed by a repeat with other fields, which is refused', async () => {
      const other = await post('/ledger/vendors', {
        external_id: 'v-1',
        individual_name: 'Pat Doe',
      });
      expect(other.status).toBe(409);
      expect(errorType(other)).toBe('EXTERNAL_ID_IN_USE');
      expect(error(other).payload).toEqual({
        kind: 'vendor',
        externalId: 'v-1',
        recordId: vendor.id,
        state: 'live',
        version: 1,
      });
      // One field more than it was made with is another body too.
      const more = await post('/ledger/vendors', {
        ...fields,
        office_phone: '555-0100',
      });
      expect(more.status).toBe(409);
      expect(errorType(more)).toBe('EXTERNAL_ID_IN_USE');

      const read = await get(`/ledger/vendors/${vendor.id}`);
      expect(read.body.data).toEqual(vendor);
    });

    it('has its fields replaced whole by an update made from its version', async () => {
      const res = await put(`/ledger/vendors/${vendor.id}`, {
        individual_name: 'Pat Doe',
        version: 1,
      });
      expect(res.status).toBe(200);
      // Version 1 as made, and 2 after this one change. The fields not sent
      // are emptied; the external id is the vendor's still.
      expect(res.body.data).toEqual({
        ...vendor,
        company_name: null,
        individual_name: 'Pat Doe',
        email: null,
        notes: null,
        version: 2,
      });
      const read = await get(`/ledger/vendors/${vendor.id}`);
      expect(read.body.data).toEqual(res.body.data);
    });

    it('after an update, a repeat with the fields it now holds is a retry, and the create it was made with is a conflict', async () => {
      const current = (await get(`/ledger/vendors/${vendor.id}`)).body.data;
      // Made at 1, updated once: 2. Neither repeat below changes that.
      expect(current.version).toBe(2);

      // The update's own fields, under the vendor's external id.
      const retry = await post('/ledger/vendors', {
        external_id: 'v-1',
        individual_name: 'Pat Doe',
      });
      expect(retry.status).toBe(200);
      expect(retry.body).toEqual({ data: current, replayed: true });

      // The vendor has moved on from the fields it was made with.
      const original = await post('/ledger/vendors', fields);
      expect(original.status).toBe(409);
      expect(errorType(original)).toBe('EXTERNAL_ID_IN_USE');
      expect(error(original).payload).toEqual({
        kind: 'vendor',
        externalId: 'v-1',
        recordId: vendor.id,
        state: 'live',
        version: 2,
      });
      expect((await get(`/ledger/vendors/${vendor.id}`)).body.data).toEqual(
        current,
      );
    });

    it('refuses an update made from an old version, or from none, and writes nothing', async () => {
      const current = (await get(`/ledger/vendors/${vendor.id}`)).body.data;
      expect(current.version).toBe(2);

      const stale = await put(`/ledger/vendors/${vendor.id}`, {
        company_name: 'Late Edit',
        version: 1,
      });
      expect(stale.status).toBe(409);
      expect(errorType(stale)).toBe('STALE_VERSION');
      expect(error(stale).payload).toEqual({ current });

      const none = await bareCall('put', `/ledger/vendors/${vendor.id}`).send({
        company_name: 'No Version',
      });
      expect(none.status).toBe(400);
      expect(errorType(none)).toBe('VERSION_REQUIRED');

      expect((await get(`/ledger/vendors/${vendor.id}`)).body.data).toEqual(
        current,
      );
      // Not found is answered before the version is looked at.
      const missing = await bareCall('put', '/ledger/vendors/99999999').send({
        company_name: 'Nobody',
      });
      expect(missing.status).toBe(404);
      expect(errorType(missing)).toBe('vendor_not_found');
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
      b1Body = bill(
        '2031-03-10',
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
          due_on: '2031-04-09',
          reference: 'INV-77',
          note: 'First bill',
          metadata: { sourceDoc: 'scan-1' },
        },
      );
      const res = await post('/ledger/bills', b1Body);
      expect(res.status).toBe(201);
      // A first create is no retry, and says nothing of one.
      expect(res.body).not.toHaveProperty('replayed');
      b1 = res.body.data;
    });

    it('is answered whole: priced lines, total, balance, status and its vendor', () => {
      expect(b1).toMatchObject({
        id: expect.any(Number),
        status: 'open',
        posted_on: '2031-03-10',
        due_on: '2031-04-09',
        terms: null,
        paid_on: null,
        voided_at: null,
        reference: 'INV-77',
        note: 'First bill',
        metadata: { sourceDoc: 'scan-1' },
        amount: '1000.00',
        balance: '1000.00',
        payments: [],
        version: 1,
      });
      // A vendor external id not seen before is made, with no name.
      expect(b1.vendor).toMatchObject({
        external_id: 'v-acme',
        company_name: null,
        individual_name: null,
        version: 1,
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
          posted_on: '2031-03-10',
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
        payment('2031-04-05', '400.00', [[b1.id, '400.00']], {
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
        payment('2031-05-20', '600.05', [[b1.id, '600.00']], {
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
        version: 1,
        paid_on: '2031-04-05',
        method: 'ACH',
        processor: 'CHECKBOOK',
        amount: '400.00',
        unapplied: '0.00',
        // It named no vendor and left nothing over.
        vendor_id: null,
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
        applications: [],
        created_at: expect.any(String),
      });
      // The 0.05 over is a credit with the vendor of the bill it paid.
      expect(p2.unapplied).toBe('0.05');
      expect(p2.vendor_id).toBe(b1.vendor.id);
      // No account named: the answer says none, though the money went to
      // the clearing account.
      expect(p2.account).toBeNull();
      expect(p2.amount).toBe('600.05');
    });

    it('post against payables, and recognise the lines, on the day paid', async () => {
      // 400.00 of 1,000.00: four tenths of 700.00, 100.00 and 200.00.
      expect(await rowsOf('BillPayment', p1.id)).toEqual([
        ['2031-04-05', 'accrual', '1010', '-400.00'],
        ['2031-04-05', 'accrual', '2010', '400.00'],
        ['2031-04-05', 'cash', '1010', '-400.00'],
        ['2031-04-05', 'cash', '1500', '80.00'],
        ['2031-04-05', 'cash', '6000', '280.00'],
        ['2031-04-05', 'cash', '6100', '40.00'],
      ]);
      // The 600.00 left: what is unpaid on each line, 420.00, 60.00, 120.00.
      expect(await rowsOf('BillPayment', p2.id)).toEqual([
        ['2031-05-20', 'accrual', '2010', '0.05'],
        ['2031-05-20', 'accrual', '2010', '600.00'],
        ['2031-05-20', 'accrual', '2100', '-0.05'],
        ['2031-05-20', 'accrual', '2100', '-600.00'],
        ['2031-05-20', 'cash', '1500', '120.00'],
        ['2031-05-20', 'cash', '2100', '-0.05'],
        ['2031-05-20', 'cash', '2100', '-600.00'],
        ['2031-05-20', 'cash', '6000', '420.00'],
        ['2031-05-20', 'cash', '6100', '60.00'],
        ['2031-05-20', 'cash', '6900', '0.05'],
      ]);
    });

    it('give the hand-worked accrual books, month by month', async () => {
      // March: the bill alone, 1,000.00 owed.
      expect(await balances({ basis: 'accrual', ...MAR })).toEqual({
        '1500': '200.00',
        '2010': '-1000.00',
        '6000': '700.00',
        '6100': '100.00',
      });
      // April: 400.00 leaves the bank and comes off payables.
      expect(await balances({ basis: 'accrual', ...APR })).toEqual({
        '1010': '-400.00',
        '2010': '400.00',
      });
      // May: 600.00 off payables, and the 0.05 beyond the bill is a credit
      // with the vendor, on payables too.
      expect(await balances({ basis: 'accrual', ...MAY })).toEqual({
        '2010': '600.05',
        '2100': '-600.05',
      });
      // Payables: -1,000.00 + 400.00 + 600.05 = +0.05, the vendor's credit.
      expect(await balances({ basis: 'accrual' })).toEqual({
        '1010': '-400.00',
        '1500': '200.00',
        '2010': '0.05',
        '2100': '-600.05',
        '6000': '700.00',
        '6100': '100.00',
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
      // Paid in full. The bases differ to date by the 0.05 alone: a credit
      // on payables on the accrual basis, an expense on the cash basis.
      expect(await balances({ basis: 'cash' })).toEqual({
        '1010': '-400.00',
        '1500': '200.00',
        '2100': '-600.05',
        '6000': '700.00',
        '6100': '100.00',
        '6900': '0.05',
      });
    });

    it('settle the bill: paid, nothing owed, paid at the latest payment', async () => {
      const read = (await get(`/ledger/bills/${b1.id}`)).body.data;

      expect(read.status).toBe('paid');
      expect(read.amount).toBe('1000.00');
      expect(read.balance).toBe('0.00');
      expect(read.paid_on).toBe('2031-05-20');
      expect(
        read.payments.map((p: any) => [p.payment_id, p.amount, p.payment.id]),
      ).toEqual([
        [p1.id, '400.00', p1.id],
        [p2.id, '600.00', p2.id],
      ]);
      expect(read.payments[0].payment).toEqual(p1);
      // Version 1 as made, and one more for each of the two payments on it.
      expect(read.version).toBe(3);
    });

    it('carry the line tag onto the cash rows', async () => {
      const lines = await get(`/ledger/accounts/${id['6000']}/lines`, {
        basis: 'cash',
      }).expect(200);

      expect(
        lines.body.data.map((l: any) => [
          l.source_type,
          l.posted_on,
          l.debit,
          l.tracking.map((t: any) => t.option),
        ]),
      ).toEqual([
        ['bill_payment', '2031-05-20', '420.00', ['North']],
        ['bill_payment', '2031-04-05', '280.00', ['North']],
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
          e.posted_on,
          e.entries.length,
        ]),
      ).toEqual([
        // The bill on its instant, and each payment on the instant paid:
        // the second with the 0.05 beyond the bill.
        ['bill', b1.id, '2031-03-10', 4],
        ['bill_payment', p1.id, '2031-04-05', 2],
        ['bill_payment', p2.id, '2031-05-20', 4],
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
        payment('2031-05-21', '0.01', [[b1.id, '0.01']]),
        'BILL_ALLOCATION_EXCEEDS_BALANCE',
      );
    });

    it('an amount below what it allocates', async () => {
      await refused(
        payment('2031-05-21', '5.00', [[b1.id, '6.00']]),
        'PAYMENT_AMOUNT_BELOW_ALLOCATIONS',
      );
    });

    it('a bill or an account that does not exist', async () => {
      await refused(
        payment('2031-05-21', '5.00', [[99999999, '5.00']]),
        'PAYMENT_BILL_NOT_FOUND',
      );
      await refused(
        payment('2031-05-21', '5.00', [], { account_id: 99999999 }),
        'account_not_found',
        404,
      );
    });

    it('a malformed body', async () => {
      const good = payment('2031-05-21', '5.00', []);

      await post('/ledger/bill-payments', { ...good, amount: '-5.00' }).expect(
        400,
      );
      await post('/ledger/bill-payments', { ...good, amount: '5.001' }).expect(
        400,
      );
      await post('/ledger/bill-payments', { ...good, paid_on: 'May' }).expect(
        400,
      );
      await post('/ledger/bill-payments', { ...good, vendor: 1 }).expect(400);
    });
  });

  describe('a payment that does not divide evenly', () => {
    it('shares 0.05 over lines of 7.00, 1.00 and 2.00 as 0.04, 0.00 and 0.01', async () => {
      const small = (
        await post(
          '/ledger/bills',
          bill('2031-06-02', [
            entry('6000', '7.00'),
            entry('6100', '1.00'),
            entry('1500', '2.00'),
          ]),
        )
      ).body.data;
      const paid = (
        await post(
          '/ledger/bill-payments',
          payment('2031-06-03', '0.05', [[small.id, '0.05']], {
            account_id: id['2200'],
          }),
        )
      ).body.data;

      // 3.5, 0.5 and 1 cents round down to 3, 0 and 1: one cent left, to
      // the earlier of the two lines that lost a half. A card may pay.
      expect(await rowsOf('BillPayment', paid.id)).toEqual([
        ['2031-06-03', 'accrual', '2010', '0.05'],
        ['2031-06-03', 'accrual', '2200', '-0.05'],
        ['2031-06-03', 'cash', '1500', '0.01'],
        ['2031-06-03', 'cash', '2200', '-0.05'],
        ['2031-06-03', 'cash', '6000', '0.04'],
      ]);
      const read = (await get(`/ledger/bills/${small.id}`)).body.data;
      expect([read.status, read.balance, read.paid_on]).toEqual([
        'partially_paid',
        '9.95',
        null,
      ]);
    });

    it('shares a later payment over what is unpaid on each line, and the last one settles every line', async () => {
      // 33.33 to rent, 33.33 to supplies, 33.34 to equipment: 100.00.
      const thirds = (
        await post(
          '/ledger/bills',
          bill('2031-06-04', [
            entry('6000', '33.33'),
            entry('6100', '33.33'),
            entry('1500', '33.34'),
          ]),
        )
      ).body.data;
      const cashOf = async (paymentId: number) =>
        (await rowsOf('BillPayment', paymentId))
          .filter((row) => row[1] === 'cash' && row[2] !== '1010')
          .map((row) => [row[2], row[3]]);
      const pay = async (paidOn: string, amount: string) =>
        (
          await post(
            '/ledger/bill-payments',
            payment(paidOn, amount, [[thirds.id, amount]], {
              account_id: id['1010'],
            }),
          )
        ).body.data;

      // 10.00 is a tenth: 333.3, 333.3 and 333.4 cents round down to 333
      // each, and the cent left goes to the line that lost the most.
      const first = await pay('2031-06-05', '10.00');
      expect(await cashOf(first.id)).toEqual([
        ['1500', '3.34'],
        ['6000', '3.33'],
        ['6100', '3.33'],
      ]);
      // Unpaid now: 30.00 on every line. 50.00 over three equal parts is
      // 1,666 cents and two thirds each: 1,666 each, and the two cents left
      // go to the two earlier lines. Shared over the lines' own amounts, the
      // odd one out would have been supplies.
      const second = await pay('2031-06-06', '50.00');
      expect(await cashOf(second.id)).toEqual([
        ['1500', '16.66'],
        ['6000', '16.67'],
        ['6100', '16.67'],
      ]);
      // The 40.00 left is what is left on each line: 13.33, 13.33 and
      // 13.34. So each line was paid its own amount:
      //   rent       3.33 + 16.67 + 13.33 = 33.33
      //   supplies   3.33 + 16.67 + 13.33 = 33.33
      //   equipment  3.34 + 16.66 + 13.34 = 33.34
      const last = await pay('2031-06-07', '40.00');
      expect(await cashOf(last.id)).toEqual([
        ['1500', '13.34'],
        ['6000', '13.33'],
        ['6100', '13.33'],
      ]);
      const read = (await get(`/ledger/bills/${thirds.id}`)).body.data;
      expect([read.status, read.balance, read.paid_on]).toEqual([
        'paid',
        '0.00',
        '2031-06-07',
      ]);
      // The earlier payments are as they were.
      expect(await cashOf(first.id)).toEqual([
        ['1500', '3.34'],
        ['6000', '3.33'],
        ['6100', '3.33'],
      ]);
    });
  });

  describe('editing a bill', () => {
    let edited: any;
    let editedBody: any;
    // The bill as its two edits leave it.
    const twoLines = () => ({
      vendor_external_id: 'v-acme',
      posted_on: '2031-07-02',
      entries: [
        entry('6100', '100.00'),
        entry('6000', '100.00', { external_id: 'keep' }),
      ],
    });

    beforeAll(async () => {
      // 100.00 to rent on 10 June, and nothing paid on it yet.
      editedBody = bill('2031-06-10', [
        entry('6000', '100.00', { external_id: 'keep' }),
      ]);
      edited = (await post('/ledger/bills', editedBody)).body.data;
    });

    it('with nothing paid, takes new lines and a new day, and keeps a line id by its external id', async () => {
      const res = await put(`/ledger/bills/${edited.id}`, {
        ...twoLines(),
        posted_on: '2031-06-10',
      });
      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(edited.id);
      expect(res.body.data.external_id).toBe(edited.external_id);
      expect(res.body.data.amount).toBe('200.00');
      expect(res.body.data.balance).toBe('200.00');
      expect(res.body.data.status).toBe('open');
      // The kept line moved to second place and kept its id.
      expect(res.body.data.entries[1].id).toBe(edited.entries[0].id);
      expect(res.body.data.entries[0].id).not.toBe(edited.entries[0].id);

      expect(await rowsOf('Bill', edited.id)).toEqual([
        ['2031-06-10', 'accrual', '2010', '-200.00'],
        ['2031-06-10', 'accrual', '6000', '100.00'],
        ['2031-06-10', 'accrual', '6100', '100.00'],
      ]);

      // Its day moves to 2 July, and its entry with it.
      const moved = await put(`/ledger/bills/${edited.id}`, twoLines());
      expect(moved.status).toBe(200);
      expect(moved.body.data.posted_on).toBe('2031-07-02');
      // The line with an external id keeps its id again.
      expect(moved.body.data.entries[1].id).toBe(edited.entries[0].id);
      expect(await rowsOf('Bill', edited.id)).toEqual([
        ['2031-07-02', 'accrual', '2010', '-200.00'],
        ['2031-07-02', 'accrual', '6000', '100.00'],
        ['2031-07-02', 'accrual', '6100', '100.00'],
      ]);
    });

    it('a repeat of the external id with another body is refused, and the bill is as the edits left it', async () => {
      const before = (await get(`/ledger/bills/${edited.id}`)).body.data;
      // Made at 1; then the edit to two lines and the edit of the day.
      expect(before.version).toBe(3);

      const res = await post(
        '/ledger/bills',
        bill('2031-07-02', [entry('6000', '75.00')], {
          external_id: edited.external_id,
          note: 'replaced',
        }),
      );
      expect(res.status).toBe(409);
      expect(errorType(res)).toBe('EXTERNAL_ID_IN_USE');
      expect(error(res).payload).toEqual({
        kind: 'bill',
        externalId: edited.external_id,
        recordId: edited.id,
        state: 'live',
        version: 3,
      });
      // Still 200.00 over two lines on 2 July, all of it owed.
      expect((await get(`/ledger/bills/${edited.id}`)).body.data).toEqual(
        before,
      );
      expect([before.amount, before.balance, before.note]).toEqual([
        '200.00',
        '200.00',
        null,
      ]);
      expect(await rowsOf('Bill', edited.id)).toEqual([
        ['2031-07-02', 'accrual', '2010', '-200.00'],
        ['2031-07-02', 'accrual', '6000', '100.00'],
        ['2031-07-02', 'accrual', '6100', '100.00'],
      ]);
      expect(
        await ws.rows('ext_trade_documents', { id: edited.id }),
      ).toHaveLength(1);
    });

    it('after an edit, a repeat with the body it now holds is a retry, and the create it was made with is a conflict', async () => {
      const before = (await get(`/ledger/bills/${edited.id}`)).body.data;
      expect(before.version).toBe(3);

      // The body of its last edit, the one that moved its day, under its
      // external id: answered with the bill, and nothing written.
      const retry = await post('/ledger/bills', {
        external_id: edited.external_id,
        ...twoLines(),
      });
      expect(retry.status).toBe(200);
      expect(retry.body).toEqual({ data: before, replayed: true });

      // The 100.00 of rent on 10 June it was made with is no longer the bill.
      const original = await post('/ledger/bills', editedBody);
      expect(original.status).toBe(409);
      expect(errorType(original)).toBe('EXTERNAL_ID_IN_USE');
      expect(error(original).payload).toEqual({
        kind: 'bill',
        externalId: edited.external_id,
        recordId: edited.id,
        state: 'live',
        version: 3,
      });

      // Still 200.00 over two lines on 2 July, at version 3.
      expect((await get(`/ledger/bills/${edited.id}`)).body.data).toEqual(
        before,
      );
      expect(await rowsOf('Bill', edited.id)).toEqual([
        ['2031-07-02', 'accrual', '2010', '-200.00'],
        ['2031-07-02', 'accrual', '6000', '100.00'],
        ['2031-07-02', 'accrual', '6100', '100.00'],
      ]);
    });

    it('an edit may not change or remove the external id, and keeps it when it names none', async () => {
      const body = twoLines();
      for (const externalId of [`b:${randomUUID()}`, null]) {
        const res = await put(`/ledger/bills/${edited.id}`, {
          ...body,
          external_id: externalId,
        });
        expect(res.status).toBe(400);
        expect(errorType(res)).toBe('EXTERNAL_ID_FIXED');
        expect(error(res).payload).toEqual({
          externalId: edited.external_id,
        });
      }
      // Neither refused edit wrote anything: the version is the 3 it was.
      const read = (await get(`/ledger/bills/${edited.id}`)).body.data;
      expect([read.external_id, read.version]).toEqual([edited.external_id, 3]);

      // Its own id sent back, or none at all: the edit lands and the id stays.
      const same = await put(`/ledger/bills/${edited.id}`, {
        ...body,
        external_id: edited.external_id,
      });
      expect([same.status, same.body.data.version]).toEqual([200, 4]);
      const none = await put(`/ledger/bills/${edited.id}`, body);
      expect([
        none.status,
        none.body.data.external_id,
        none.body.data.version,
      ]).toEqual([200, edited.external_id, 5]);
    });

    it('an edit gives an external id to a bill that has none, once', async () => {
      const body = {
        vendor_external_id: 'v-acme',
        posted_on: '2031-07-03',
        entries: [entry('6000', '5.00')],
      };
      const made = await post('/ledger/bills', body);
      expect(made.status).toBe(201);
      expect(made.body.data.external_id).toBeNull();

      const given = `b:${randomUUID()}`;
      const named = await put(`/ledger/bills/${made.body.data.id}`, {
        ...body,
        external_id: given,
      });
      expect(named.status).toBe(200);
      expect(named.body.data.external_id).toBe(given);

      const changed = await put(`/ledger/bills/${made.body.data.id}`, {
        ...body,
        external_id: `b:${randomUUID()}`,
      });
      expect(changed.status).toBe(400);
      expect(errorType(changed)).toBe('EXTERNAL_ID_FIXED');
      // An id another bill holds cannot be given either.
      const other = await post('/ledger/bills', body);
      const taken = await put(`/ledger/bills/${other.body.data.id}`, {
        ...body,
        external_id: given,
      });
      expect(errorType(taken)).toBe('EXTERNAL_ID_IN_USE');
      expect(
        (await get(`/ledger/bills/${other.body.data.id}`)).body.data
          .external_id,
      ).toBeNull();
    });

    it('is not found for a bill that does not exist, and refused for an unknown account', async () => {
      const body = {
        vendor_external_id: 'v-acme',
        posted_on: '2031-07-02',
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

    describe('once something is paid on it', () => {
      // The bill is 100.00 to supplies and 100.00 to rent on 2 July, at
      // version 5. 50.00 is paid on 5 July from 1010: a quarter of the
      // 200.00, so 25.00 of each line.
      let paid: any;
      let before: any;
      const paidRows = [
        ['2031-07-05', 'accrual', '1010', '-50.00'],
        ['2031-07-05', 'accrual', '2010', '50.00'],
        ['2031-07-05', 'cash', '1010', '-50.00'],
        ['2031-07-05', 'cash', '6000', '25.00'],
        ['2031-07-05', 'cash', '6100', '25.00'],
      ];
      const billRows = [
        ['2031-07-02', 'accrual', '2010', '-200.00'],
        ['2031-07-02', 'accrual', '6000', '100.00'],
        ['2031-07-02', 'accrual', '6100', '100.00'],
      ];
      const refused = async (body: unknown, changed: string[]) => {
        const res = await put(`/ledger/bills/${edited.id}`, body);
        expect(res.status).toBe(400);
        expect(errorType(res)).toBe('BILL_EDIT_HAS_PAYMENTS');
        expect(error(res).payload).toEqual({
          billId: edited.id,
          paid: '50.00',
          changed,
        });
      };
      /** The tags on the cash rows the payment wrote to an account. */
      const cashTags = async (code: string) =>
        (
          await get(`/ledger/accounts/${id[code]}/lines`, {
            basis: 'cash',
            page_size: 200,
          }).expect(200)
        ).body.data
          .filter(
            (l: any) =>
              l.source_type === 'bill_payment' && l.source_id === paid.id,
          )
          .map((l: any) => [l.debit, l.tracking.map((t: any) => t.option)]);

      beforeAll(async () => {
        paid = (
          await post(
            '/ledger/bill-payments',
            payment('2031-07-05', '50.00', [[edited.id, '50.00']], {
              account_id: id['1010'],
            }),
          )
        ).body.data;
        before = (await get(`/ledger/bills/${edited.id}`)).body.data;
        // Version 5 after its edits, and one more for the payment.
        expect([before.version, before.balance]).toEqual([6, '150.00']);
        expect(await rowsOf('BillPayment', paid.id)).toEqual(paidRows);
      });

      it('refuses a new total, below what is paid or above it, a new line or another account, and changes nothing', async () => {
        const body = twoLines();

        // 49.99 on one line is below the 50.00 paid. It is refused for its
        // lines, as any other total is.
        await refused({ ...body, entries: [entry('6000', '49.99')] }, [
          'entries',
        ]);
        await refused(
          {
            ...body,
            entries: [
              entry('6100', '100.00'),
              entry('6000', '100.01', { external_id: 'keep' }),
            ],
          },
          ['entries'],
        );
        // One line more, at nothing: the total is the same 200.00.
        await refused(
          { ...body, entries: [...body.entries, entry('1500', '0.00')] },
          ['entries'],
        );
        // The same two lines the other way round: each place has another
        // account.
        await refused({ ...body, entries: [...body.entries].reverse() }, [
          'entries',
        ]);
        // Another vendor, one that exists. And everything at once, named in
        // order.
        await refused({ ...body, vendor_external_id: 'v-1' }, ['vendor']);
        await refused(
          {
            vendor_external_id: 'v-1',
            posted_on: '2031-07-03',
            entries: [entry('6000', '49.99')],
          },
          ['posted_on', 'vendor', 'entries'],
        );

        expect((await get(`/ledger/bills/${edited.id}`)).body.data).toEqual(
          before,
        );
        expect(await rowsOf('Bill', edited.id)).toEqual(billRows);
        expect(await rowsOf('BillPayment', paid.id)).toEqual(paidRows);
      });

      it('refuses to move its day, and the bill and its payment stay on their days', async () => {
        await refused({ ...twoLines(), posted_on: '2031-07-03' }, [
          'posted_on',
        ]);

        expect((await get(`/ledger/bills/${edited.id}`)).body.data).toEqual(
          before,
        );
        expect(await rowsOf('Bill', edited.id)).toEqual(billRows);
        expect(await rowsOf('BillPayment', paid.id)).toEqual(paidRows);
      });

      it('takes an edit of what is still open, keeps each line id by its place, and leaves the payment split as it was, with the new tags', async () => {
        expect(await cashTags('6100')).toEqual([['25.00', []]]);

        // The supplies line is now 4 at 25.00, still 100.00, and carries
        // the external id the rent line had. By its external id the rent
        // line's id would move to first place.
        const res = await put(`/ledger/bills/${edited.id}`, {
          vendor_external_id: 'v-acme',
          posted_on: '2031-07-02',
          due_on: '2031-08-01',
          reference: 'INV-90',
          note: 'Relabelled',
          entries: [
            entry('6100', '25.00', {
              quantity: '4',
              external_id: 'keep',
              description: 'Paper',
              tracking: [{ category: 'Location', option: 'South' }],
            }),
            entry('6000', '100.00', { item: 'Office rent' }),
          ],
        });
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({
          id: edited.id,
          external_id: edited.external_id,
          posted_on: '2031-07-02',
          due_on: '2031-08-01',
          reference: 'INV-90',
          note: 'Relabelled',
          amount: '200.00',
          balance: '150.00',
          status: 'partially_paid',
          // 6 with the payment on it, and this edit.
          version: 7,
        });
        expect(
          res.body.data.entries.map((e: any) => [
            e.id,
            e.external_id,
            e.account.code,
            e.item,
            e.description,
            e.rate,
            e.quantity,
            e.amount,
            e.tracking.map((t: any) => t.option),
          ]),
        ).toEqual([
          [
            before.entries[0].id,
            'keep',
            '6100',
            null,
            'Paper',
            '25.00',
            '4',
            '100.00',
            ['South'],
          ],
          [
            before.entries[1].id,
            null,
            '6000',
            'Office rent',
            null,
            '100.00',
            '1',
            '100.00',
            [],
          ],
        ]);

        // The books hold what they held: 25.00 of each line paid.
        expect(await rowsOf('Bill', edited.id)).toEqual(billRows);
        expect(await rowsOf('BillPayment', paid.id)).toEqual(paidRows);
        expect(await cashTags('6100')).toEqual([['25.00', ['South']]]);
        expect(await cashTags('6000')).toEqual([['25.00', []]]);
      });
    });
  });

  describe('totals', () => {
    it('a bill with no lines is paid from the start, with no paid day and no entry', async () => {
      const res = await post('/ledger/bills', bill('2031-08-01', []));
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({
        status: 'paid',
        amount: '0.00',
        balance: '0.00',
        paid_on: null,
        entries: [],
      });
      expect(await rowsOf('Bill', res.body.data.id)).toEqual([]);
    });

    it('a bill that totals zero is paid from the start, and posts its lines', async () => {
      const res = await post(
        '/ledger/bills',
        bill('2031-08-01', [entry('6000', '30.00'), entry('6100', '-30.00')]),
      );
      expect(res.body.data).toMatchObject({ status: 'paid', amount: '0.00' });
      expect(await rowsOf('Bill', res.body.data.id)).toEqual([
        ['2031-08-01', 'accrual', '6000', '30.00'],
        ['2031-08-01', 'accrual', '6100', '-30.00'],
      ]);
    });

    it('a bill that totals less than zero is stored as a vendor credit, its signs turned', async () => {
      const res = await post(
        '/ledger/bills',
        bill('2031-08-01', [entry('6000', '20.00'), entry('6100', '-70.00')]),
      );
      expect(res.body.data).toMatchObject({
        kind: 'vendor_credit',
        status: 'open',
        amount: '50.00',
        unapplied: '50.00',
      });
      expect(res.body.data.entries.map((e: any) => e.rate)).toEqual([
        '-20.00',
        '70.00',
      ]);
      // The same rows a bill of -50.00 would post.
      expect(await rowsOf('VendorCredit', res.body.data.id)).toEqual([
        ['2031-08-01', 'accrual', '2010', '50.00'],
        ['2031-08-01', 'accrual', '6000', '20.00'],
        ['2031-08-01', 'accrual', '6100', '-70.00'],
      ]);
    });

    it('prices a line to the cent, and is due on receipt when its terms say so', async () => {
      // 2.5 at 0.333 is 0.8325, which is 0.83.
      const res = await post(
        '/ledger/bills',
        bill('2031-08-02', [entry('6000', '0.333', { quantity: '2.5' })], {
          terms: 'due_on_receipt',
          due_on: '2031-09-01',
        }),
      );
      expect(res.body.data.entries[0].amount).toBe('0.83');
      expect(res.body.data.amount).toBe('0.83');
      expect(res.body.data.terms).toBe('due_on_receipt');
      expect(res.body.data.due_on).toBe('2031-08-02');
    });

    it('refuses a bill with no vendor, with two, with an unknown one, or malformed', async () => {
      const body = bill('2031-08-02', [entry('6000', '1.00')]);
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
    let voidedBody: any;

    beforeAll(async () => {
      voidedBody = bill('2031-09-01', [
        entry('6000', '60.00'),
        entry('6100', '40.00'),
      ]);
      voided = (await post('/ledger/bills', voidedBody)).body.data;
    });

    it('takes its entry out of the books and leaves the bill, with its amount and a balance of zero', async () => {
      const res = await post(`/ledger/bills/${voided.id}/void`);

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        id: voided.id,
        status: 'voided',
        amount: '100.00',
        balance: '0.00',
        voided_at: expect.any(String),
        // Made at 1; the void is its one change.
        version: 2,
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

      // It needs no version, and takes any: there is nothing to change.
      for (const sent of [{}, { version: 1 }, { version: 7 }]) {
        const res = await bareCall(
          'post',
          `/ledger/bills/${voided.id}/void`,
        ).send(sent);
        expect(res.status).toBe(200);
        expect(res.body.data).toEqual(first);
      }
      expect(first.version).toBe(2);
    });

    it('cannot then be edited, and its external id is never used again', async () => {
      const before = (await get(`/ledger/bills/${voided.id}`)).body.data;
      const edit = await put(`/ledger/bills/${voided.id}`, {
        vendor_external_id: 'v-acme',
        posted_on: '2031-09-02',
        entries: [entry('6000', '80.00')],
      });
      expect(edit.status).toBe(400);
      expect(errorType(edit)).toBe('BILL_VOIDED');

      const repeat = await post(
        '/ledger/bills',
        bill('2031-09-02', [entry('6100', '90.00')], {
          external_id: voided.external_id,
        }),
      );
      // Another body, or the very body it was made with: the id is spent.
      for (const res of [repeat, await post('/ledger/bills', voidedBody)]) {
        expect(res.status).toBe(409);
        expect(errorType(res)).toBe('EXTERNAL_ID_IN_USE');
        expect(error(res).payload).toEqual({
          kind: 'bill',
          externalId: voided.external_id,
          recordId: voided.id,
          state: 'voided',
          version: 2,
        });
      }
      expect((await get(`/ledger/bills/${voided.id}`)).body.data).toEqual(
        before,
      );
      // No second bill was made under the id, and nothing came back to the books.
      const held = await get('/ledger/bills', {
        external_id: voided.external_id,
      });
      expect(held.body.data.map((b: any) => b.id)).toEqual([voided.id]);
      expect(await rowsOf('Bill', voided.id)).toEqual([]);
    });

    it('cannot be paid, and no entry is written', async () => {
      const rowCount = async () =>
        (
          await ws.rows('accounts_transactions', {
            referenceType: 'BillPayment',
          })
        ).length;
      const before = await rowCount();
      const paid = await post(
        '/ledger/bill-payments',
        payment('2031-09-05', '30.00', [[voided.id, '30.00']], {
          account_id: id['1010'],
        }),
      );
      expect(paid.status).toBe(400);
      expect(errorType(paid)).toBe('BILL_VOIDED');
      expect(await rowCount()).toBe(before);
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
        payment('2031-10-05', amount, [[owed.id, amount]], {
          account_id: id['1010'],
          ...extra,
        }),
      );

    beforeAll(async () => {
      owed = (
        await post(
          '/ledger/bills',
          bill('2031-10-01', [entry('6000', '100.00')]),
        )
      ).body.data;
    });

    it('a repeat of the external id is a retry with the same body, and refused with another', async () => {
      const externalId = `p:${randomUUID()}`;
      const first = await pay('40.00', { external_id: externalId });
      expect(first.status).toBe(201);
      expect(first.body).not.toHaveProperty('replayed');
      // 40.00 of the 100.00 rent, from the bank.
      const rows = [
        ['2031-10-05', 'accrual', '1010', '-40.00'],
        ['2031-10-05', 'accrual', '2010', '40.00'],
        ['2031-10-05', 'cash', '1010', '-40.00'],
        ['2031-10-05', 'cash', '6000', '40.00'],
      ];
      expect(await rowsOf('BillPayment', first.body.data.id)).toEqual(rows);

      const retry = await pay('40.00', { external_id: externalId });
      expect(retry.status).toBe(200);
      expect(retry.body).toEqual({ data: first.body.data, replayed: true });

      // A payment is not edited by sending it again with another amount.
      const again = await pay('25.00', { external_id: externalId });
      expect(again.status).toBe(409);
      expect(errorType(again)).toBe('EXTERNAL_ID_IN_USE');
      expect(error(again).payload).toEqual({
        kind: 'bill_payment',
        externalId,
        recordId: first.body.data.id,
        state: 'live',
        version: 1,
      });
      const [row] = await ws.rows('ext_payments', { id: first.body.data.id });
      expect([Number(row.amount), row.deletedAt]).toEqual([40, null]);
      expect(await rowsOf('BillPayment', first.body.data.id)).toEqual(rows);
      // 100.00 less the one 40.00: neither repeat paid anything.
      const read = (await get(`/ledger/bills/${owed.id}`)).body.data;
      expect([read.balance, read.payments.length]).toEqual(['60.00', 1]);
      // The bill was made at 1 and has moved once, for the one payment.
      expect(read.version).toBe(2);
    });

    it('is changed by deleting it and making another', async () => {
      const first = (await get(`/ledger/bills/${owed.id}`)).body.data
        .payments[0].payment;
      await del(`/ledger/bill-payments/${first.id}`).expect(200);

      // 25.00 in place of the 40.00: the bill owes 75.00.
      const other = await pay('25.00');
      expect(other.status).toBe(201);
      expect(other.body.data.id).not.toBe(first.id);
      expect(await rowsOf('BillPayment', first.id)).toEqual([]);
      expect(await rowsOf('BillPayment', other.body.data.id)).toEqual([
        ['2031-10-05', 'accrual', '1010', '-25.00'],
        ['2031-10-05', 'accrual', '2010', '25.00'],
        ['2031-10-05', 'cash', '1010', '-25.00'],
        ['2031-10-05', 'cash', '6000', '25.00'],
      ]);
      const read = (await get(`/ledger/bills/${owed.id}`)).body.data;
      // 2 after the first payment; its delete and the new payment make 4.
      expect([read.balance, read.version]).toEqual(['75.00', 4]);

      await del(`/ledger/bill-payments/${other.body.data.id}`).expect(200);
    });

    it('deleting takes its entries out, and the bill owes again', async () => {
      const paid = (await pay('100.00')).body.data;
      expect((await get(`/ledger/bills/${owed.id}`)).body.data.status).toBe(
        'paid',
      );

      const res = await del(`/ledger/bill-payments/${paid.id}`);
      expect(res.status).toBe(200);
      // The delete is the payment's one change: version 2.
      expect(res.body.data).toEqual({ ...paid, version: 2, allocations: [] });
      expect(await rowsOf('BillPayment', paid.id)).toEqual([]);

      const read = (await get(`/ledger/bills/${owed.id}`)).body.data;
      expect([read.status, read.balance, read.paid_on, read.payments]).toEqual([
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

      // A second delete needs no version, and takes any.
      for (const query of ['', '?version=1', '?version=9']) {
        const repeat = await bareCall(
          'delete',
          `/ledger/bill-payments/${paid.id}${query}`,
        );
        expect(repeat.status).toBe(200);
        expect(repeat.body.data).toEqual(res.body.data);
      }

      // Its external id is spent: it makes no new payment and brings none
      // back, with another body or with the body it was made with.
      const count = (await ws.rows('ext_payments')).length;
      for (const amount of ['10.00', '100.00']) {
        const fresh = await pay(amount, { external_id: paid.external_id });
        expect(fresh.status).toBe(409);
        expect(errorType(fresh)).toBe('EXTERNAL_ID_IN_USE');
        expect(error(fresh).payload).toEqual({
          kind: 'bill_payment',
          externalId: paid.external_id,
          recordId: paid.id,
          state: 'deleted',
          version: null,
        });
      }
      expect(await ws.rows('ext_payments')).toHaveLength(count);
      expect((await get(`/ledger/bill-payments/${paid.id}`)).status).toBe(404);
      expect(await rowsOf('BillPayment', paid.id)).toEqual([]);
      expect((await get(`/ledger/bills/${owed.id}`)).body.data.balance).toBe(
        '100.00',
      );
    });

    it('is not deleted from an old version, or from none', async () => {
      const paid = (await pay('15.00')).body.data;
      expect(paid.version).toBe(1);
      const billBefore = (await get(`/ledger/bills/${owed.id}`)).body.data;

      const stale = await del(`/ledger/bill-payments/${paid.id}?version=2`);
      expect(stale.status).toBe(409);
      expect(errorType(stale)).toBe('STALE_VERSION');
      expect(error(stale).payload).toEqual({ current: paid });

      const none = await bareCall('delete', `/ledger/bill-payments/${paid.id}`);
      expect(none.status).toBe(400);
      expect(errorType(none)).toBe('VERSION_REQUIRED');

      // Still there: read as it was, its four rows in the books, and the
      // bill owing 100.00 less its 15.00, at the version it had.
      expect((await get(`/ledger/bill-payments/${paid.id}`)).body.data).toEqual(
        paid,
      );
      expect(await rowsOf('BillPayment', paid.id)).toEqual([
        ['2031-10-05', 'accrual', '1010', '-15.00'],
        ['2031-10-05', 'accrual', '2010', '15.00'],
        ['2031-10-05', 'cash', '1010', '-15.00'],
        ['2031-10-05', 'cash', '6000', '15.00'],
      ]);
      const billAfter = (await get(`/ledger/bills/${owed.id}`)).body.data;
      expect(billAfter).toEqual(billBefore);
      expect(billAfter.balance).toBe('85.00');

      // Not found is answered before the version is looked at.
      const missing = await bareCall(
        'delete',
        '/ledger/bill-payments/99999999',
      );
      expect(missing.status).toBe(404);
      expect(errorType(missing)).toBe('bill_payment_not_found');

      // From the version it has, it goes, and the bill moves on by one.
      const gone = await del(`/ledger/bill-payments/${paid.id}?version=1`);
      expect(gone.status).toBe(200);
      expect(gone.body.data.version).toBe(2);
      const billGone = (await get(`/ledger/bills/${owed.id}`)).body.data;
      expect([billGone.balance, billGone.version]).toEqual([
        '100.00',
        billBefore.version + 1,
      ]);
    });

    it('eight simultaneous payments of one external id make one payment', async () => {
      const body = payment('2031-10-06', '10.00', [[owed.id, '10.00']]);
      const results = await Promise.all(
        Array.from({ length: 8 }, () => post('/ledger/bill-payments', body)),
      );
      expect(results.map((r) => r.status).sort()).toEqual([
        200, 200, 200, 200, 200, 200, 200, 201,
      ]);
      // The seven that made nothing say so; the one that made it does not.
      expect(results.map((r) => [r.status, r.body.replayed]).sort()).toEqual([
        ...Array.from({ length: 7 }, () => [200, true]),
        [201, undefined],
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

  describe('a repeated create of a bill', () => {
    // December holds nothing else, so its figures are this story alone:
    //   80.00 to 6000 Rent and 20.00 to 6100 Supplies on 1 December,
    //   total 100.00 to 2010 Payables.
    const DEC = { from: '2031-12-01', to: '2031-12-09' };
    const december = () => balances({ basis: 'accrual', ...DEC });
    let body: any;
    let made: any;

    beforeAll(async () => {
      body = bill(
        '2031-12-01',
        [entry('6000', '80.00'), entry('6100', '20.00')],
        { note: 'December', metadata: { sourceDoc: 'scan-12' } },
      );
      const res = await post('/ledger/bills', body);
      expect(res.status).toBe(201);
      expect(res.body).not.toHaveProperty('replayed');
      made = res.body.data;
    });

    it('with the same body is a retry: one bill, answered again, and the books unmoved', async () => {
      const books = {
        '2010': '-100.00',
        '6000': '80.00',
        '6100': '20.00',
      };
      expect(await december()).toEqual(books);

      const again = await post('/ledger/bills', body);
      expect(again.status).toBe(200);
      expect(again.body).toEqual({ data: made, replayed: true });
      expect(made.version).toBe(1);

      const listed = await get('/ledger/bills', {
        external_id: body.external_id,
      });
      expect(listed.body.data.map((b: any) => b.id)).toEqual([made.id]);
      expect(await rowsOf('Bill', made.id)).toEqual([
        ['2031-12-01', 'accrual', '2010', '-100.00'],
        ['2031-12-01', 'accrual', '6000', '80.00'],
        ['2031-12-01', 'accrual', '6100', '20.00'],
      ]);
      expect(await december()).toEqual(books);
    });

    it('with any field changed is refused, naming the bill and its version, and changes nothing', async () => {
      const count = (await ws.rows('ext_trade_documents')).length;
      const changed = [
        { ...body, note: 'December, again' },
        { ...body, posted_on: '2031-12-02' },
        {
          ...body,
          entries: [entry('6000', '80.01'), entry('6100', '20.00')],
        },
        { ...body, metadata: { sourceDoc: 'scan-13' } },
        { ...body, reference: 'NEW' },
      ];
      for (const other of changed) {
        const res = await post('/ledger/bills', other);
        expect(res.status).toBe(409);
        expect(errorType(res)).toBe('EXTERNAL_ID_IN_USE');
        expect(error(res).payload).toEqual({
          kind: 'bill',
          externalId: body.external_id,
          recordId: made.id,
          state: 'live',
          version: 1,
        });
      }
      expect(await ws.rows('ext_trade_documents')).toHaveLength(count);
      expect((await get(`/ledger/bills/${made.id}`)).body.data).toEqual(made);
      expect(await december()).toEqual({
        '2010': '-100.00',
        '6000': '80.00',
        '6100': '20.00',
      });
    });

    it('eight simultaneous creates of one external id and body make one bill', async () => {
      // 8.00 to rent on 2 December, once: December is then 88.00 of rent,
      // 20.00 of supplies and 108.00 owed. Eight bills would be 144.00 of rent.
      const once = bill('2031-12-02', [entry('6000', '8.00')]);
      const results = await Promise.all(
        Array.from({ length: 8 }, () => post('/ledger/bills', once)),
      );
      expect(results.map((r) => [r.status, r.body.replayed]).sort()).toEqual([
        ...Array.from({ length: 7 }, () => [200, true]),
        [201, undefined],
      ]);
      expect(new Set(results.map((r) => r.body.data.id)).size).toBe(1);
      const billId = results[0].body.data.id;

      expect(
        await ws.rows('ext_external_ids', { externalId: once.external_id }),
      ).toHaveLength(1);
      expect(await rowsOf('Bill', billId)).toEqual([
        ['2031-12-02', 'accrual', '2010', '-8.00'],
        ['2031-12-02', 'accrual', '6000', '8.00'],
      ]);
      expect(await december()).toEqual({
        '2010': '-108.00',
        '6000': '88.00',
        '6100': '20.00',
      });
      expect((await get(`/ledger/bills/${billId}`)).body.data.version).toBe(1);
    });
  });

  describe('the version of a bill', () => {
    // One bill of 40.00 to rent on 10 December, edited to 50.00, then paid
    // 20.00 on 11 December from 1010, and given a note while it is paid.
    let doc: any;
    let paid: any;
    const edit = (rate: string, extra = {}) => ({
      vendor_external_id: 'v-acme',
      posted_on: '2031-12-10',
      entries: [entry('6000', rate)],
      metadata: { sourceDoc: 'scan-v' },
      ...extra,
    });
    const read = async () => (await get(`/ledger/bills/${doc.id}`)).body.data;

    beforeAll(async () => {
      const res = await post(
        '/ledger/bills',
        bill('2031-12-10', [entry('6000', '40.00')], {
          metadata: { sourceDoc: 'scan-v' },
        }),
      );
      expect(res.status).toBe(201);
      doc = res.body.data;
    });

    it('starts at 1, and an edit made from it lands and raises it by one', async () => {
      expect(doc.version).toBe(1);

      const res = await put(
        `/ledger/bills/${doc.id}`,
        edit('50.00', { version: 1 }),
      );
      expect(res.status).toBe(200);
      expect([res.body.data.amount, res.body.data.version]).toEqual([
        '50.00',
        2,
      ]);
      expect(await read()).toEqual(res.body.data);
    });

    it('an edit made from an old version is refused with the bill as it stands, and writes nothing', async () => {
      const current = await read();
      const res = await put(
        `/ledger/bills/${doc.id}`,
        edit('60.00', { version: 1 }),
      );
      expect(res.status).toBe(409);
      expect(errorType(res)).toBe('STALE_VERSION');
      expect(error(res).payload).toEqual({ current });

      // A version it has not reached yet is not its version either.
      const ahead = await put(
        `/ledger/bills/${doc.id}`,
        edit('60.00', { version: 3 }),
      );
      expect(ahead.status).toBe(409);
      expect(errorType(ahead)).toBe('STALE_VERSION');

      // Still the 50.00 of the edit that landed, at version 2.
      expect(await read()).toEqual(current);
      expect([current.amount, current.version]).toEqual(['50.00', 2]);
      expect(await rowsOf('Bill', doc.id)).toEqual([
        ['2031-12-10', 'accrual', '2010', '-50.00'],
        ['2031-12-10', 'accrual', '6000', '50.00'],
      ]);
    });

    it('an edit or a void that names no version is refused', async () => {
      const current = await read();

      const edited = await bareCall('put', `/ledger/bills/${doc.id}`).send(
        edit('60.00'),
      );
      expect(edited.status).toBe(400);
      expect(errorType(edited)).toBe('VERSION_REQUIRED');

      const voided = await bareCall('post', `/ledger/bills/${doc.id}/void`);
      expect(voided.status).toBe(400);
      expect(errorType(voided)).toBe('VERSION_REQUIRED');

      await bareCall('put', `/ledger/bills/${doc.id}`)
        .send(edit('60.00', { version: 0 }))
        .expect(400);
      expect(await read()).toEqual(current);

      // Not found is answered before the version is looked at.
      const missing = await bareCall('put', '/ledger/bills/99999999').send(
        edit('60.00'),
      );
      expect(missing.status).toBe(404);
      expect(errorType(missing)).toBe('bill_not_found');
      const missingVoid = await bareCall('post', '/ledger/bills/99999999/void');
      expect(missingVoid.status).toBe(404);
    });

    it('an edit built before a payment and sent after it is refused', async () => {
      const builtFrom = (await read()).version;
      expect(builtFrom).toBe(2);

      paid = (
        await post(
          '/ledger/bill-payments',
          payment('2031-12-11', '20.00', [[doc.id, '20.00']], {
            account_id: id['1010'],
          }),
        )
      ).body.data;

      // The edit changes the note alone, which a payment leaves open.
      const res = await put(
        `/ledger/bills/${doc.id}`,
        edit('50.00', { note: 'Checked', version: builtFrom }),
      );
      expect(res.status).toBe(409);
      expect(errorType(res)).toBe('STALE_VERSION');
      // The payment moved the bill on to 3: 50.00, of which 30.00 is owed.
      const current = await read();
      expect(error(res).payload).toEqual({ current });
      expect([
        current.version,
        current.amount,
        current.balance,
        current.note,
      ]).toEqual([3, '50.00', '30.00', null]);

      // Built again on what it is now, the edit lands.
      const again = await put(
        `/ledger/bills/${doc.id}`,
        edit('50.00', { note: 'Checked', version: 3 }),
      );
      expect(again.status).toBe(200);
      expect([
        again.body.data.version,
        again.body.data.amount,
        again.body.data.balance,
        again.body.data.note,
      ]).toEqual([4, '50.00', '30.00', 'Checked']);
    });

    it('a void made from an old version is refused, and from the current one lands', async () => {
      // The payment goes first: a paid bill is not voided. Its delete moves
      // the bill from 4 to 5.
      await del(`/ledger/bill-payments/${paid.id}`).expect(200);
      const current = await read();
      expect([current.version, current.balance]).toEqual([5, '50.00']);

      const stale = await post(`/ledger/bills/${doc.id}/void`, { version: 4 });
      expect(stale.status).toBe(409);
      expect(errorType(stale)).toBe('STALE_VERSION');
      expect(error(stale).payload).toEqual({ current });
      expect((await read()).status).toBe('open');
      expect(await rowsOf('Bill', doc.id)).toHaveLength(2);

      const res = await post(`/ledger/bills/${doc.id}/void`, { version: 5 });
      expect(res.status).toBe(200);
      expect([res.body.data.status, res.body.data.version]).toEqual([
        'voided',
        6,
      ]);
      expect(await rowsOf('Bill', doc.id)).toEqual([]);
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
      const instants = all.map((b: any) => b.posted_on);
      expect(instants).toEqual([...instants].sort());

      const march = await get('/ledger/bills', {
        from: '2031-03-10',
        to: '2031-03-10',
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
      put('/ledger/settings', { locked_through: '2031-03-31' }).expect(200),
    );
    afterAll(() =>
      put('/ledger/settings', { locked_through: null }).expect(200),
    );

    it('refuses a bill in the closed period, and an edit into or out of it', async () => {
      locked(
        await post(
          '/ledger/bills',
          bill('2031-03-31', [entry('6000', '1.00')]),
        ),
      );
      const open = (
        await post('/ledger/bills', bill('2031-11-01', [entry('6000', '1.00')]))
      ).body.data;
      locked(
        await put(`/ledger/bills/${open.id}`, {
          vendor_external_id: 'v-acme',
          posted_on: '2031-03-31',
          entries: [entry('6000', '1.00')],
        }),
      );
      // A March bill with nothing paid on it cannot be made now, so lift
      // the lock to make it.
      await put('/ledger/settings', { locked_through: null }).expect(200);
      const march = (
        await post('/ledger/bills', bill('2031-03-20', [entry('6000', '1.00')]))
      ).body.data;
      await put('/ledger/settings', {
        locked_through: '2031-03-31',
      }).expect(200);
      locked(
        await put(`/ledger/bills/${march.id}`, {
          vendor_external_id: 'v-acme',
          posted_on: '2031-11-01',
          entries: [entry('6000', '1.00')],
        }),
      );
      expect((await get(`/ledger/bills/${march.id}`)).body.data).toEqual(march);

      // B1 is paid in full, so its day is fixed whatever the lock says: the
      // move is refused for its payments. An edit of its reference alone
      // changes nothing the payments fix, and is refused for the lock.
      const moved = await put(`/ledger/bills/${b1.id}`, {
        ...b1Body,
        posted_on: '2031-11-01',
      });
      expect(moved.status).toBe(400);
      expect(errorType(moved)).toBe('BILL_EDIT_HAS_PAYMENTS');
      expect(error(moved).payload).toEqual({
        billId: b1.id,
        paid: '1000.00',
        changed: ['posted_on'],
      });
      locked(
        await put(`/ledger/bills/${b1.id}`, { ...b1Body, reference: 'INV-78' }),
      );
      expect((await get(`/ledger/bills/${b1.id}`)).body.data.reference).toBe(
        'INV-77',
      );

      await post(`/ledger/bills/${open.id}/void`).expect(200);
      await put('/ledger/settings', { locked_through: null }).expect(200);
      await post(`/ledger/bills/${march.id}/void`).expect(200);
      await put('/ledger/settings', {
        locked_through: '2031-03-31',
      }).expect(200);
    });

    it('looks at the day a payment is paid, not the day of the bill it pays', async () => {
      // A March bill and a March payment cannot be made now, so lift the
      // lock to make them.
      await put('/ledger/settings', { locked_through: null }).expect(200);
      const march = (
        await post(
          '/ledger/bills',
          bill('2031-03-20', [entry('6000', '10.00')]),
        )
      ).body.data;
      const later = (
        await post('/ledger/bills', bill('2031-11-01', [entry('6000', '5.00')]))
      ).body.data;
      const inMarch = (
        await post(
          '/ledger/bill-payments',
          payment('2031-03-25', '4.00', [[march.id, '4.00']], {
            account_id: id['1010'],
          }),
        )
      ).body.data;
      await put('/ledger/settings', {
        locked_through: '2031-03-31',
      }).expect(200);

      // Paid in November, on the March bill: every entry lands in November.
      const inNovember = await post(
        '/ledger/bill-payments',
        payment('2031-11-03', '1.00', [[march.id, '1.00']], {
          account_id: id['1010'],
        }),
      );
      expect(inNovember.status).toBe(201);
      expect(
        (await rowsOf('BillPayment', inNovember.body.data.id)).map(
          (row) => row[0],
        ),
      ).toEqual(['2031-11-03', '2031-11-03', '2031-11-03', '2031-11-03']);
      // Paid in March, on the November bill: refused.
      locked(
        await post(
          '/ledger/bill-payments',
          payment('2031-03-26', '1.00', [[later.id, '1.00']], {
            account_id: id['1010'],
          }),
        ),
      );
      // The March payment cannot be deleted; the November one can.
      locked(await del(`/ledger/bill-payments/${inMarch.id}`));
      expect((await get(`/ledger/bill-payments/${inMarch.id}`)).status).toBe(
        200,
      );
      await del(`/ledger/bill-payments/${inNovember.body.data.id}`).expect(200);

      await put('/ledger/settings', { locked_through: null }).expect(200);
      await del(`/ledger/bill-payments/${inMarch.id}`).expect(200);
      await put('/ledger/settings', {
        locked_through: '2031-03-31',
      }).expect(200);
      // The March bill itself is in the closed period.
      locked(await post(`/ledger/bills/${march.id}/void`));
      await post(`/ledger/bills/${later.id}/void`).expect(200);
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
          posted_on: '2031-03-10',
          entries: [{ account_id: account('6000'), rate: '10.00' }],
        });
      expect(created.status).toBe(201);

      const pay = (body: Record<string, unknown>) =>
        http()
          .post('/ledger/bill-payments')
          .set(headers)
          .send({
            paid_on: '2031-03-11',
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
