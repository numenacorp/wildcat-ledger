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
 * Customers, invoices and invoice payments, on a workspace in
 * America/Chicago. Where an invoice behaves as a bill does, the bills tests
 * cover it; these cover the invoice's own side and where the two differ.
 *
 * The main case, worked by hand:
 *
 *   I1  12 Mar   600.00 to 4000 Sales, 300.00 to 4100 Services   total 900.00
 *   Q1  8 Apr    300.00 into 1010 Operating, all of it on I1
 *   Q2  2 Jun    600.25 into no account named, 600.00 of it on I1
 *
 * Accrual. The invoice posts on its day; each payment on the day it was
 * paid, not on the invoice's day:
 *   March   1200 +900   4000 -600   4100 -300
 *   April   1010 +300   1200 -300
 *   June    1300 (clearing) +600.25   1200 -600   4900 (uncategorized) -0.25
 *
 * Cash. Nothing until money moves; then the invoice's lines in proportion:
 *   April   Q1 is a third: 1010 +300   4000 -200   4100 -100
 *   June    Q2 is two thirds: 1300 +600  4000 -400  4100 -200
 *           and the 0.25:  1300 +0.25   4900 -0.25
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
  { code: '2010', name: 'Payables', account_type: 'accounts-payable' },
  {
    code: '2200',
    name: 'Deposits Held',
    account_type: 'other-current-liability',
  },
  {
    code: '2400',
    name: 'Unearned',
    account_type: 'other-current-liability',
    slug: 'unearned-revenue',
  },
  { code: '4000', name: 'Sales', account_type: 'income', slug: 'sales' },
  { code: '4100', name: 'Services', account_type: 'income' },
  {
    code: '4900',
    name: 'Uncategorized',
    account_type: 'other-income',
    slug: 'uncategorized-income',
  },
];

const MAR = { from: '2031-03-01T06:00:00Z', to: '2031-04-01T05:00:00Z' };
const APR = { from: '2031-04-01T05:00:00Z', to: '2031-05-01T05:00:00Z' };
const JUN = { from: '2031-06-01T05:00:00Z', to: '2031-07-01T05:00:00Z' };

describe('Ledger extension: customers, invoices and invoice payments', () => {
  let app: INestApplication;
  let ws: TestWorkspace;
  let id: Record<string, number>;
  let codeOf: Record<number, string>;
  let customer: any;
  let other: any;
  let i1: any;
  let q1: any;
  let q2: any;

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
  const invoice = (postedAt: string, entries: unknown[], extra = {}) => ({
    external_id: `i:${randomUUID()}`,
    customer_id: customer.id,
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
    external_id: `q:${randomUUID()}`,
    customer_id: customer.id,
    paid_at: paidAt,
    amount,
    allocations: allocations.map(([invoiceId, a]) => ({
      invoice_id: invoiceId,
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

    const accounts = (await get('/ledger/accounts').expect(200)).body.data;
    id = Object.fromEntries(accounts.map((a: any) => [a.code, a.id]));
    codeOf = Object.fromEntries(accounts.map((a: any) => [a.id, a.code]));

    customer = (
      await post('/ledger/customers', {
        external_id: 'c-1',
        company_name: 'Buyer Co',
      })
    ).body.data;
    other = (await post('/ledger/customers', { external_id: 'c-2' })).body.data;
  });

  afterAll(async () => {
    await dropOrganizations(app, [ws.workspace.organization_id]);
    await app.close();
  });

  describe('a customer', () => {
    it('is created, replaced whole by a repeat, read and listed', async () => {
      expect(customer).toEqual({
        id: expect.any(Number),
        external_id: 'c-1',
        company_name: 'Buyer Co',
        individual_name: null,
        email: null,
        mobile_phone: null,
        office_phone: null,
        address_string: null,
        notes: null,
        active: true,
      });
      const again = await post('/ledger/customers', {
        external_id: 'c-1',
        company_name: 'Buyer Company',
        email: 'ar@buyer.test',
      });
      expect(again.status).toBe(200);
      expect(again.body.data).toEqual({
        ...customer,
        company_name: 'Buyer Company',
        email: 'ar@buyer.test',
      });
      customer = again.body.data;

      expect((await get(`/ledger/customers/${customer.id}`)).body.data).toEqual(
        customer,
      );
      const list = await get('/ledger/customers').expect(200);
      expect(list.body.pagination).toEqual({
        total: 2,
        page: 1,
        page_size: 50,
      });
      expect(list.body.data.map((c: any) => c.external_id)).toEqual([
        'c-1',
        'c-2',
      ]);
      // A customer is not a vendor.
      expect((await get(`/ledger/vendors/${customer.id}`)).status).toBe(404);
      const missing = await get('/ledger/customers/99999999');
      expect(errorType(missing)).toBe('customer_not_found');
    });
  });

  describe('an invoice', () => {
    beforeAll(async () => {
      const res = await post(
        '/ledger/invoices',
        invoice(
          '2031-03-12T18:00:00Z',
          [
            entry('4000', '600.00', {
              external_id: 'i1-sales',
              item: 'Widgets',
              tracking: [{ category: 'Location', option: 'North' }],
            }),
            entry('4100', '300.00'),
          ],
          {
            invoice_number: 'A-17',
            reference: 'PO-9',
            note: 'First invoice',
            due_at: '2031-04-11T18:00:00Z',
            metadata: { sourceDoc: 'x' },
          },
        ),
      );
      expect(res.status).toBe(201);
      i1 = res.body.data;
    });

    it('is answered whole, in an invoice words', () => {
      expect(i1).toMatchObject({
        id: expect.any(Number),
        status: 'open',
        posted_at: '2031-03-12T18:00:00.000Z',
        due_at: '2031-04-11T18:00:00.000Z',
        paid_at: null,
        voided_at: null,
        invoice_number: 'A-17',
        reference: 'PO-9',
        note: 'First invoice',
        metadata: { sourceDoc: 'x' },
        amount: '900.00',
        balance: '900.00',
        customer,
        payments: [],
      });
      expect(i1).not.toHaveProperty('vendor');
      expect(i1.entries[0]).toMatchObject({
        external_id: 'i1-sales',
        item: 'Widgets',
        rate: '600.00',
        quantity: '1',
        amount: '600.00',
        account: { code: '4000', name: 'Sales', account_type: 'income' },
        tracking: [
          {
            id: expect.any(Number),
            category: 'Location',
            option: 'North',
            option_name: 'North',
          },
        ],
      });
    });

    it('debits receivables its total and credits each line, on its Central day, accrual only', async () => {
      expect(await rowsOf('SaleInvoice', i1.id)).toEqual([
        ['2031-03-12', 'accrual', '1200', '900.00'],
        ['2031-03-12', 'accrual', '4000', '-600.00'],
        ['2031-03-12', 'accrual', '4100', '-300.00'],
      ]);
      expect(await balances({ basis: 'cash' })).toEqual({});
    });

    it('is issued a number when it is sent none, and keeps its number through an edit', async () => {
      const body = invoice('2031-03-13T18:00:00Z', [entry('4100', '1.00')]);
      const made = await post('/ledger/invoices', body);

      expect(made.body.data.invoice_number).toMatch(/^INV-\d{6}$/);

      const edited = await put(`/ledger/invoices/${made.body.data.id}`, {
        customer_id: customer.id,
        posted_at: '2031-03-13T18:00:00Z',
        entries: [entry('4100', '2.00')],
      });
      expect(edited.status).toBe(200);
      expect(edited.body.data.invoice_number).toBe(
        made.body.data.invoice_number,
      );
      await post(`/ledger/invoices/${made.body.data.id}/void`).expect(200);
    });

    it('needs a customer that exists: one not seen before is not made', async () => {
      const { customer_id: _c, ...body } = invoice('2031-03-13T18:00:00Z', [
        entry('4100', '1.00'),
      ]);
      const before = (await get('/ledger/customers')).body.pagination.total;
      const unknown = await post('/ledger/invoices', {
        ...body,
        customer_external_id: 'c-nobody',
      });
      expect(unknown.status).toBe(404);
      expect(errorType(unknown)).toBe('customer_not_found');
      expect((await get('/ledger/customers')).body.pagination.total).toBe(
        before,
      );

      const byExternalId = await post('/ledger/invoices', {
        ...body,
        customer_external_id: 'c-2',
      });
      expect(byExternalId.status).toBe(201);
      expect(byExternalId.body.data.customer.id).toBe(other.id);
      await post(`/ledger/invoices/${byExternalId.body.data.id}/void`).expect(
        200,
      );

      expect(errorType(await post('/ledger/invoices', body))).toBe(
        'CUSTOMER_REQUIRED',
      );
    });
  });

  describe('invoice payments', () => {
    beforeAll(async () => {
      const first = await post(
        '/ledger/invoice-payments',
        payment('2031-04-08T18:00:00Z', '300.00', [[i1.id, '300.00']], {
          account_id: id['1010'],
          method: 'ACH',
          reference: 'DEP-1',
        }),
      );
      expect(first.status).toBe(201);
      q1 = first.body.data;

      const second = await post(
        '/ledger/invoice-payments',
        payment('2031-06-02T18:00:00Z', '600.25', [[i1.id, '600.00']]),
      );
      expect(second.status).toBe(201);
      q2 = second.body.data;
    });

    it('are answered whole', () => {
      expect(q1).toEqual({
        id: expect.any(Number),
        external_id: expect.stringMatching(/^q:/),
        paid_at: '2031-04-08T18:00:00.000Z',
        method: 'ACH',
        processor: null,
        amount: '300.00',
        customer_id: customer.id,
        customer,
        account_id: id['1010'],
        account: {
          id: id['1010'],
          code: '1010',
          name: 'Operating',
          account_type: 'bank',
          metadata: null,
        },
        redemption_account_id: null,
        redemption_account: null,
        reference: 'DEP-1',
        note: null,
        metadata: null,
        allocations: [
          { id: expect.any(Number), invoice_id: i1.id, amount: '300.00' },
        ],
        created_at: expect.any(String),
      });
      expect(q2.account).toBeNull();
    });

    it('post on the day paid on both bases, not on the invoice day', async () => {
      expect(await rowsOf('PaymentReceive', q1.id)).toEqual([
        ['2031-04-08', 'accrual', '1010', '300.00'],
        ['2031-04-08', 'accrual', '1200', '-300.00'],
        ['2031-04-08', 'cash', '1010', '300.00'],
        ['2031-04-08', 'cash', '4000', '-200.00'],
        ['2031-04-08', 'cash', '4100', '-100.00'],
      ]);
      expect(await rowsOf('PaymentReceive', q2.id)).toEqual([
        ['2031-06-02', 'accrual', '1200', '-600.00'],
        ['2031-06-02', 'accrual', '1300', '600.00'],
        ['2031-06-02', 'both', '1300', '0.25'],
        ['2031-06-02', 'both', '4900', '-0.25'],
        ['2031-06-02', 'cash', '1300', '600.00'],
        ['2031-06-02', 'cash', '4000', '-400.00'],
        ['2031-06-02', 'cash', '4100', '-200.00'],
      ]);
    });

    it('give the hand-worked books on both bases, month by month', async () => {
      expect(await balances({ basis: 'accrual', ...MAR })).toEqual({
        '1200': '900.00',
        '4000': '-600.00',
        '4100': '-300.00',
      });
      expect(await balances({ basis: 'accrual', ...APR })).toEqual({
        '1010': '300.00',
        '1200': '-300.00',
      });
      expect(await balances({ basis: 'accrual', ...JUN })).toEqual({
        '1200': '-600.00',
        '1300': '600.25',
        '4900': '-0.25',
      });
      expect(await balances({ basis: 'cash', ...MAR })).toEqual({});
      expect(await balances({ basis: 'cash', ...APR })).toEqual({
        '1010': '300.00',
        '4000': '-200.00',
        '4100': '-100.00',
      });
      expect(await balances({ basis: 'cash', ...JUN })).toEqual({
        '1300': '600.25',
        '4000': '-400.00',
        '4100': '-200.00',
        '4900': '-0.25',
      });
      // Paid in full, both bases agree to date.
      expect(await balances({ basis: 'cash' })).toEqual(
        await balances({ basis: 'accrual' }),
      );
    });

    it('settle the invoice', async () => {
      const read = (await get(`/ledger/invoices/${i1.id}`)).body.data;

      expect([read.status, read.balance, read.paid_at]).toEqual([
        'paid',
        '0.00',
        '2031-06-02T18:00:00.000Z',
      ]);
      expect(read.payments.map((p: any) => [p.payment_id, p.amount])).toEqual([
        [q1.id, '300.00'],
        [q2.id, '600.00'],
      ]);
      expect(read.payments[0].payment).toEqual(q1);
    });

    it('show in the feed under their own names', async () => {
      const feed = await get('/ledger/entries', {
        basis: 'accrual',
        order: 'asc',
      }).expect(200);

      expect(
        feed.body.data.map((e: any) => [
          e.source_type,
          e.source_id,
          e.number,
          e.posted_at,
        ]),
      ).toEqual([
        ['sale_invoice', i1.id, 'A-17', '2031-03-12T18:00:00.000Z'],
        ['payment_received', q1.id, null, '2031-04-08T18:00:00.000Z'],
        ['payment_received', q2.id, null, '2031-06-02T18:00:00.000Z'],
      ]);
      // Its lines in the order sent, then receivables.
      expect(
        feed.body.data[0].entries.map((e: any) => [e.account.code, e.line_id]),
      ).toEqual([
        ['4000', i1.entries[0].id],
        ['4100', i1.entries[1].id],
        ['1200', null],
      ]);
    });

    it('are refused when they overpay, underfund, or pay another customer invoice', async () => {
      const refused = async (body: unknown, type: string) => {
        const res = await post('/ledger/invoice-payments', body);
        expect(res.status).toBe(400);
        expect(errorType(res)).toBe(type);
      };
      await refused(
        payment('2031-06-03T18:00:00Z', '0.01', [[i1.id, '0.01']]),
        'INVOICE_ALLOCATION_EXCEEDS_BALANCE',
      );
      await refused(
        payment('2031-06-03T18:00:00Z', '1.00', [[i1.id, '2.00']]),
        'PAYMENT_AMOUNT_BELOW_ALLOCATIONS',
      );
      await refused(
        payment('2031-06-03T18:00:00Z', '1.00', [[99999999, '1.00']]),
        'PAYMENT_INVOICE_NOT_FOUND',
      );
      await refused(
        payment('2031-06-03T18:00:00Z', '1.00', [[i1.id, '1.00']], {
          customer_id: other.id,
        }),
        'PAYMENT_INVOICE_OF_ANOTHER_CUSTOMER',
      );
      const { customer_id: _c, ...noCustomer } = payment(
        '2031-06-03T18:00:00Z',
        '1.00',
        [],
      );
      await post('/ledger/invoice-payments', noCustomer).expect(400);

      const unknown = await post(
        '/ledger/invoice-payments',
        payment('2031-06-03T18:00:00Z', '1.00', [], { customer_id: 99999999 }),
      );
      expect(unknown.status).toBe(404);
      expect(errorType(unknown)).toBe('customer_not_found');
    });
  });

  describe('editing an invoice after a payment', () => {
    let edited: any;
    let paid: any;

    beforeAll(async () => {
      // 100.00 of sales on 1 July; 50.00 paid on 5 July.
      edited = (
        await post(
          '/ledger/invoices',
          invoice('2031-07-01T17:00:00Z', [
            entry('4000', '100.00', { external_id: 'keep' }),
          ]),
        )
      ).body.data;
      paid = (
        await post(
          '/ledger/invoice-payments',
          payment('2031-07-05T17:00:00Z', '50.00', [[edited.id, '50.00']], {
            account_id: id['1010'],
          }),
        )
      ).body.data;
      expect(await rowsOf('PaymentReceive', paid.id)).toEqual([
        ['2031-07-05', 'accrual', '1010', '50.00'],
        ['2031-07-05', 'accrual', '1200', '-50.00'],
        ['2031-07-05', 'cash', '1010', '50.00'],
        ['2031-07-05', 'cash', '4000', '-50.00'],
      ]);
    });

    it('shares the earlier payment again over the new lines, where a bill keeps its split', async () => {
      const res = await put(`/ledger/invoices/${edited.id}`, {
        customer_id: customer.id,
        posted_at: '2031-07-01T17:00:00Z',
        entries: [
          entry('4000', '100.00', { external_id: 'keep' }),
          entry('4100', '100.00'),
        ],
      });
      expect(res.status).toBe(200);
      expect(res.body.data.amount).toBe('200.00');
      expect(res.body.data.balance).toBe('150.00');
      expect(res.body.data.entries[0].id).toBe(edited.entries[0].id);

      // The 50.00 is now a quarter of an invoice that is half sales and
      // half services: 25.00 to each.
      expect(await rowsOf('PaymentReceive', paid.id)).toEqual([
        ['2031-07-05', 'accrual', '1010', '50.00'],
        ['2031-07-05', 'accrual', '1200', '-50.00'],
        ['2031-07-05', 'cash', '1010', '50.00'],
        ['2031-07-05', 'cash', '4000', '-25.00'],
        ['2031-07-05', 'cash', '4100', '-25.00'],
      ]);
    });

    it('leaves the payment on its own day when the invoice day moves', async () => {
      await put(`/ledger/invoices/${edited.id}`, {
        customer_id: customer.id,
        posted_at: '2031-07-20T17:00:00Z',
        entries: [
          entry('4000', '100.00', { external_id: 'keep' }),
          entry('4100', '100.00'),
        ],
      }).expect(200);

      expect(
        (await rowsOf('PaymentReceive', paid.id)).map((row) => row[0]),
      ).toEqual(Array(5).fill('2031-07-05'));
      expect((await rowsOf('SaleInvoice', edited.id))[0][0]).toBe('2031-07-20');
    });

    it('refuses a total below what is paid', async () => {
      const res = await put(`/ledger/invoices/${edited.id}`, {
        customer_id: customer.id,
        posted_at: '2031-07-20T17:00:00Z',
        entries: [entry('4000', '49.99')],
      });
      expect(res.status).toBe(400);
      expect(errorType(res)).toBe('INVOICE_AMOUNT_BELOW_PAID');
    });
  });

  describe('totals', () => {
    it('refuses a total below zero, and takes a negative line while the total is not', async () => {
      const negative = await post(
        '/ledger/invoices',
        invoice('2031-08-01T17:00:00Z', [
          entry('4000', '20.00'),
          entry('4100', '-70.00'),
        ]),
      );
      expect(negative.status).toBe(400);
      expect(errorType(negative)).toBe('INVOICE_AMOUNT_NEGATIVE');

      const mixed = await post(
        '/ledger/invoices',
        invoice('2031-08-01T17:00:00Z', [
          entry('4000', '70.00'),
          entry('4100', '-20.00'),
        ]),
      );
      expect(mixed.status).toBe(201);
      expect(mixed.body.data.amount).toBe('50.00');
      // The negative line debits its account.
      expect(await rowsOf('SaleInvoice', mixed.body.data.id)).toEqual([
        ['2031-08-01', 'accrual', '1200', '50.00'],
        ['2031-08-01', 'accrual', '4000', '-70.00'],
        ['2031-08-01', 'accrual', '4100', '20.00'],
      ]);
    });

    it('an invoice of zero, or of no lines, is paid from the start', async () => {
      const zero = await post(
        '/ledger/invoices',
        invoice('2031-08-01T17:00:00Z', [
          entry('4000', '5.00'),
          entry('4100', '-5.00'),
        ]),
      );
      expect(zero.body.data).toMatchObject({ status: 'paid', amount: '0.00' });

      const empty = await post(
        '/ledger/invoices',
        invoice('2031-08-01T17:00:00Z', []),
      );
      expect(empty.body.data).toMatchObject({
        status: 'paid',
        amount: '0.00',
        paid_at: null,
        entries: [],
      });
    });
  });

  describe('a credit balance redeemed', () => {
    let owed: any;

    beforeAll(async () => {
      owed = (
        await post(
          '/ledger/invoices',
          invoice('2031-08-10T17:00:00Z', [entry('4100', '80.00')]),
        )
      ).body.data;
    });

    it('moves no cash: unearned revenue is debited, and on the cash basis the sales account', async () => {
      const res = await post(
        '/ledger/invoice-payments',
        payment('2031-08-12T17:00:00Z', '30.00', [[owed.id, '30.00']], {
          method: 'CREDIT_BALANCE',
        }),
      );
      expect(res.status).toBe(201);
      expect(res.body.data.redemption_account).toBeNull();
      expect(await rowsOf('PaymentReceive', res.body.data.id)).toEqual([
        ['2031-08-12', 'accrual', '1200', '-30.00'],
        ['2031-08-12', 'accrual', '2400', '30.00'],
        ['2031-08-12', 'cash', '4000', '30.00'],
        ['2031-08-12', 'cash', '4100', '-30.00'],
      ]);
    });

    it('takes the balance from the account named', async () => {
      const res = await post(
        '/ledger/invoice-payments',
        payment('2031-08-13T17:00:00Z', '20.00', [[owed.id, '20.00']], {
          method: 'CREDIT_BALANCE',
          redemption_account_id: id['2200'],
        }),
      );
      expect(res.status).toBe(201);
      expect(res.body.data.redemption_account_id).toBe(id['2200']);
      expect(res.body.data.redemption_account.code).toBe('2200');
      expect(await rowsOf('PaymentReceive', res.body.data.id)).toEqual([
        ['2031-08-13', 'accrual', '1200', '-20.00'],
        ['2031-08-13', 'accrual', '2200', '20.00'],
        ['2031-08-13', 'cash', '4000', '20.00'],
        ['2031-08-13', 'cash', '4100', '-20.00'],
      ]);
      expect((await get(`/ledger/invoices/${owed.id}`)).body.data.balance).toBe(
        '30.00',
      );
    });
  });

  describe('voiding an invoice', () => {
    let voided: any;

    beforeAll(async () => {
      voided = (
        await post(
          '/ledger/invoices',
          invoice('2031-09-01T17:00:00Z', [entry('4000', '100.00')]),
        )
      ).body.data;
    });

    it('takes its entry out, leaves the invoice, and a second void changes nothing', async () => {
      const res = await post(`/ledger/invoices/${voided.id}/void`);

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        status: 'voided',
        amount: '100.00',
        balance: '100.00',
      });
      expect(await rowsOf('SaleInvoice', voided.id)).toEqual([]);

      const again = await post(`/ledger/invoices/${voided.id}/void`);
      expect(again.status).toBe(200);
      expect(again.body.data).toEqual(res.body.data);
    });

    it('cannot then be edited or paid, where a voided bill can', async () => {
      const edit = await put(`/ledger/invoices/${voided.id}`, {
        customer_id: customer.id,
        posted_at: '2031-09-02T17:00:00Z',
        entries: [entry('4000', '80.00')],
      });
      expect(edit.status).toBe(400);
      expect(errorType(edit)).toBe('INVOICE_VOIDED');

      const pay = await post(
        '/ledger/invoice-payments',
        payment('2031-09-05T17:00:00Z', '10.00', [[voided.id, '10.00']]),
      );
      expect(pay.status).toBe(400);
      expect(errorType(pay)).toBe('INVOICE_VOIDED');
    });

    it('its external id takes a new body and stays voided', async () => {
      const res = await post(
        '/ledger/invoices',
        invoice('2031-09-02T17:00:00Z', [entry('4100', '90.00')], {
          external_id: voided.external_id,
        }),
      );
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        id: voided.id,
        status: 'voided',
        amount: '90.00',
      });
      expect(await rowsOf('SaleInvoice', voided.id)).toEqual([]);
    });

    it('is refused while the invoice has a payment', async () => {
      const res = await post(`/ledger/invoices/${i1.id}/void`);

      expect(res.status).toBe(400);
      expect(errorType(res)).toBe('INVOICE_HAS_PAYMENTS');
    });
  });

  describe('deleting and repeating a payment', () => {
    let owed: any;
    const pay = (amount: string, extra = {}) =>
      post(
        '/ledger/invoice-payments',
        payment('2031-10-05T17:00:00Z', amount, [[owed.id, amount]], {
          account_id: id['1010'],
          ...extra,
        }),
      );

    beforeAll(async () => {
      owed = (
        await post(
          '/ledger/invoices',
          invoice('2031-10-01T17:00:00Z', [entry('4000', '100.00')]),
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
      expect((await get(`/ledger/invoices/${owed.id}`)).body.data.balance).toBe(
        '75.00',
      );
      await del(`/ledger/invoice-payments/${first.body.data.id}`).expect(200);
    });

    it('deleting takes its entries out; a second delete is not found, where a bill payment answers', async () => {
      const paid = (await pay('100.00')).body.data;
      const res = await del(`/ledger/invoice-payments/${paid.id}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ ...paid, allocations: [] });
      expect(await rowsOf('PaymentReceive', paid.id)).toEqual([]);
      expect((await get(`/ledger/invoices/${owed.id}`)).body.data.status).toBe(
        'open',
      );

      const again = await del(`/ledger/invoice-payments/${paid.id}`);
      expect(again.status).toBe(404);
      expect(errorType(again)).toBe('invoice_payment_not_found');
      expect((await get(`/ledger/invoice-payments/${paid.id}`)).status).toBe(
        404,
      );

      const fresh = await pay('10.00', { external_id: paid.external_id });
      expect(fresh.status).toBe(201);
      expect(fresh.body.data.id).not.toBe(paid.id);
      await del(`/ledger/invoice-payments/${fresh.body.data.id}`).expect(200);
    });
  });

  /**
   * A check for more than the invoice it pays, the rest kept in an account.
   * By hand, on 20 Aug into 1010 Operating:
   *
   *   150.00 = 100.00 on an invoice of 100.00 to 4100 Services
   *          +  40.00 to 2200 Deposits Held
   *          +  10.00 that no part names, to 4900 Uncategorized
   *
   *   accrual   1010 +100   1200 -100
   *   cash      1010 +100   4100 -100
   *   both      1010 +40    2200 -40
   *   both      1010 +10    4900 -10
   */
  describe('a part of a payment paid to an account', () => {
    let owed: any;
    let paid: any;

    beforeAll(async () => {
      owed = (
        await post(
          '/ledger/invoices',
          invoice('2031-08-13T18:00:00Z', [entry('4100', '100.00')]),
        )
      ).body.data;
    });

    it('is taken beside the parts that pay invoices, and listed after them', async () => {
      const res = await post('/ledger/invoice-payments', {
        external_id: `q:${randomUUID()}`,
        customer_id: customer.id,
        paid_at: '2031-08-20T18:00:00Z',
        amount: '150.00',
        account_id: id['1010'],
        allocations: [
          { account_id: id['2200'], amount: '40.00', memo: 'Kept as credit' },
          { invoice_id: owed.id, amount: '100.00' },
        ],
      });
      expect(res.status).toBe(201);
      paid = res.body.data;
      expect(paid.allocations).toEqual([
        { id: expect.any(Number), invoice_id: owed.id, amount: '100.00' },
        {
          id: expect.any(Number),
          invoice_id: null,
          account_id: id['2200'],
          amount: '40.00',
          memo: 'Kept as credit',
        },
      ]);
      expect(
        (await get(`/ledger/invoice-payments/${paid.id}`)).body.data,
      ).toEqual(paid);
    });

    it('credits the account on both bases, and counts toward what is allocated', async () => {
      expect(await rowsOf('PaymentReceive', paid.id)).toEqual([
        ['2031-08-20', 'accrual', '1010', '100.00'],
        ['2031-08-20', 'accrual', '1200', '-100.00'],
        ['2031-08-20', 'both', '1010', '10.00'],
        ['2031-08-20', 'both', '1010', '40.00'],
        ['2031-08-20', 'both', '2200', '-40.00'],
        ['2031-08-20', 'both', '4900', '-10.00'],
        ['2031-08-20', 'cash', '1010', '100.00'],
        ['2031-08-20', 'cash', '4100', '-100.00'],
      ]);
      const read = (await get(`/ledger/invoices/${owed.id}`)).body.data;
      expect(read.balance).toBe('0.00');
      expect(read.status).toBe('paid');
    });

    it('is refused when it names no target, both targets, or an account that is not there', async () => {
      const send = (allocation: Record<string, unknown>) =>
        post('/ledger/invoice-payments', {
          customer_id: customer.id,
          paid_at: '2031-08-21T18:00:00Z',
          amount: '5.00',
          allocations: [allocation],
        });
      const neither = await send({ amount: '5.00' });
      expect(neither.status).toBe(400);
      expect(errorType(neither)).toBe('ALLOCATION_NAMES_ONE_TARGET');

      const both = await send({
        invoice_id: owed.id,
        account_id: id['2200'],
        amount: '5.00',
      });
      expect(both.status).toBe(400);
      expect(errorType(both)).toBe('ALLOCATION_NAMES_ONE_TARGET');

      const unknown = await send({ account_id: 99999999, amount: '5.00' });
      expect(unknown.status).toBe(404);

      const over = await send({ account_id: id['2200'], amount: '5.01' });
      expect(over.status).toBe(400);
    });

    it('is taken back when the payment is deleted', async () => {
      await del(`/ledger/invoice-payments/${paid.id}`).expect(200);
      expect(await rowsOf('PaymentReceive', paid.id)).toEqual([]);
      expect((await get(`/ledger/invoices/${owed.id}`)).body.data.balance).toBe(
        '100.00',
      );
    });
  });

  describe('listing invoices', () => {
    it('filters by customer and by status, oldest first', async () => {
      const all = (await get('/ledger/invoices', { page_size: 200 })).body.data;
      const instants = all.map((i: any) => i.posted_at);
      expect(instants).toEqual([...instants].sort());

      const theirs = await get('/ledger/invoices', {
        customer_id: other.id,
        page_size: 200,
      });
      expect(theirs.body.data.map((i: any) => i.id)).toEqual(
        all
          .filter((i: any) => i.customer.id === other.id)
          .map((i: any) => i.id),
      );
      expect(theirs.body.data.length).toBeGreaterThan(0);

      for (const status of ['open', 'partially_paid', 'paid', 'voided']) {
        const listed = await get('/ledger/invoices', {
          status,
          page_size: 200,
        });
        expect(listed.body.data.map((i: any) => i.id)).toEqual(
          all.filter((i: any) => i.status === status).map((i: any) => i.id),
        );
      }
      const march = await get('/ledger/invoices', {
        from: '2031-03-12T18:00:00Z',
        to: '2031-03-12T18:00:00Z',
      });
      expect(march.body.data.map((i: any) => i.id)).toEqual([i1.id]);
    });
  });

  describe('the lock', () => {
    // Everything before 1 April, Central, is closed: I1 is in March.
    const locked = (res: request.Response) => {
      expect(res.status).toBe(400);
      expect(errorType(res)).toBe('TRANSACTIONS_DATE_LOCKED');
    };
    let march: any;

    beforeAll(async () => {
      march = (
        await post(
          '/ledger/invoices',
          invoice('2031-03-20T17:00:00Z', [entry('4000', '10.00')]),
        )
      ).body.data;
      await put('/ledger/settings', {
        closing_at: '2031-04-01T05:00:00Z',
      }).expect(200);
    });
    afterAll(() => put('/ledger/settings', { closing_at: null }).expect(200));

    it('refuses an invoice in the closed period, and voiding one', async () => {
      locked(
        await post(
          '/ledger/invoices',
          invoice('2031-03-31T17:00:00Z', [entry('4000', '1.00')]),
        ),
      );
      locked(await post(`/ledger/invoices/${march.id}/void`));
    });

    it('takes a payment on an invoice in the closed period: only the day paid is looked at', async () => {
      const paid = await post(
        '/ledger/invoice-payments',
        payment('2031-11-02T17:00:00Z', '4.00', [[march.id, '4.00']], {
          account_id: id['1010'],
        }),
      );
      expect(paid.status).toBe(201);

      locked(
        await post(
          '/ledger/invoice-payments',
          payment('2031-03-25T17:00:00Z', '1.00', [[march.id, '1.00']], {
            account_id: id['1010'],
          }),
        ),
      );
      // It can be deleted too, being dated in the open period.
      await del(`/ledger/invoice-payments/${paid.body.data.id}`).expect(200);
    });
  });
});
