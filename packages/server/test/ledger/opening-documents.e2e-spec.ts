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
 * Opening documents: bills and invoices still open when the books began,
 * brought in one by one so that each can be aged and paid.
 *
 * The books start on 31 December 2030: the day opening balances land on,
 * and the last day of the books they came from. Worked by hand, as debits
 * less credits.
 *
 *   An opening bill of 100.00 to Rent, dated 20 November 2030. Its entry
 *   lands on 31 December 2030: Payables -100.00, Opening Equity +100.00.
 *   Rent is not touched: the old books took that expense.
 *     accrual, through January   Payables -100   Opening Equity +100
 *     cash                       nothing
 *
 *   Paid from Bank on 10 February 2031.
 *     accrual, through December  Bank -100   Opening Equity +100
 *     cash                       Bank -100   Rent +100, on 10 February
 *
 *   An opening invoice of 250.00 to Sales, dated 15 December 2030.
 *     accrual                    Receivables +250   Opening Equity -250
 *   With the bill paid: Bank -100, Receivables +250, Opening Equity -150.
 */
const chart = () => [
  { code: '1010', name: 'Bank', account_type: 'bank' },
  { code: '1200', name: 'Receivables', account_type: 'accounts-receivable' },
  { code: '2010', name: 'Payables', account_type: 'accounts-payable' },
  {
    code: '3900',
    name: 'Opening Equity',
    account_type: 'equity',
    slug: 'opening-balance-equity',
  },
  { code: '4000', name: 'Sales', account_type: 'income' },
  { code: '6000', name: 'Rent', account_type: 'expense' },
];

describe('Ledger extension: opening documents', () => {
  let app: INestApplication;
  let ws: TestWorkspace;
  let undated: TestWorkspace;
  let id: Record<string, number>;
  let codeOf: Record<number, string>;
  let bill: any;

  const http = () => request(app.getHttpServer());
  const get = (path: string, query: Record<string, unknown> = {}) =>
    http().get(path).query(query).set(ws.headers());
  const post = (path: string, body: unknown = {}) =>
    change(app, 'post', path, ws.headers(), body);
  const put = (path: string, body: unknown = {}) =>
    change(app, 'put', path, ws.headers(), body);
  const errorOf = (res: request.Response) => res.body?.errors?.[0];
  const balances = async (basis: string, to: string) =>
    Object.fromEntries(
      (
        await get('/ledger/accounts', {
          basis,
          to,
          include_before_start: 'true',
        }).expect(200)
      ).body.data
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
  const aBill = (day: string, extra: Record<string, unknown> = {}) => ({
    vendor_external_id: 'v-1',
    posted_on: day,
    entries: [{ account_id: id['6000'], rate: '100.00' }],
    ...extra,
  });

  beforeAll(async () => {
    app = await createTestApp();
    ws = await createTestWorkspace(app, {
      accounts: chart(),
      books_start_on: '2030-12-31',
    });
    undated = await createTestWorkspace(app, { accounts: chart() });
    const accounts = (await get('/ledger/accounts').expect(200)).body.data;
    id = Object.fromEntries(accounts.map((a: any) => [a.code, a.id]));
    codeOf = Object.fromEntries(accounts.map((a: any) => [a.id, a.code]));
  });

  afterAll(async () => {
    await dropOrganizations(app, [
      ws.workspace.organization_id,
      undated.workspace.organization_id,
    ]);
    await app.close();
  });

  it('an opening bill keeps its own day and stands against opening equity on the day the books start', async () => {
    const res = await post(
      '/ledger/bills',
      aBill('2030-11-20', { opening: true, due_on: '2030-12-20' }),
    );
    expect(res.status).toBe(201);
    bill = res.body.data;
    expect(bill).toMatchObject({
      opening: true,
      posted_on: '2030-11-20',
      due_on: '2030-12-20',
      status: 'open',
      amount: '100.00',
      balance: '100.00',
    });
    expect(await rowsOf('Bill', bill.id)).toEqual([
      ['2030-12-31', 'accrual', '2010', '-100.00'],
      ['2030-12-31', 'accrual', '3900', '100.00'],
    ]);
    expect(await balances('accrual', '2031-01-31')).toEqual({
      '2010': '-100.00',
      '3900': '100.00',
    });
    expect(await balances('cash', '2031-01-31')).toEqual({});
  });

  it('is listed with the bills by its own day, and stays an opening bill through an edit', async () => {
    const listed = (
      await get('/ledger/bills', { to: '2030-12-31' }).expect(200)
    ).body.data;
    expect(listed.map((b: any) => [b.id, b.opening])).toEqual([
      [bill.id, true],
    ]);

    const edited = await put(`/ledger/bills/${bill.id}`, {
      ...aBill('2030-11-20', { due_on: '2030-12-20' }),
      reference: 'OLD-77',
    });
    expect(edited.status).toBe(200);
    expect(edited.body.data).toMatchObject({
      opening: true,
      reference: 'OLD-77',
    });
    expect(await rowsOf('Bill', bill.id)).toEqual([
      ['2030-12-31', 'accrual', '2010', '-100.00'],
      ['2030-12-31', 'accrual', '3900', '100.00'],
    ]);
  });

  it('is paid like any other: the expense is taken on the cash basis alone, on the day paid', async () => {
    await post('/ledger/bill-payments', {
      paid_on: '2031-02-10',
      amount: '100.00',
      account_id: id['1010'],
      allocations: [{ bill_id: bill.id, amount: '100.00' }],
    }).expect(201);

    expect((await get(`/ledger/bills/${bill.id}`)).body.data.status).toBe(
      'paid',
    );
    expect(await balances('accrual', '2031-12-31')).toEqual({
      '1010': '-100.00',
      '3900': '100.00',
    });
    expect(await balances('cash', '2031-12-31')).toEqual({
      '1010': '-100.00',
      '6000': '100.00',
    });
    expect(await balances('cash', '2031-01-31')).toEqual({});
  });

  it('an opening invoice does the same on the other side', async () => {
    const customer = (await post('/ledger/customers', { external_id: 'c-1' }))
      .body.data;
    const res = await post('/ledger/invoices', {
      customer_id: customer.id,
      posted_on: '2030-12-15',
      opening: true,
      entries: [{ account_id: id['4000'], rate: '250.00' }],
    });
    expect(res.status).toBe(201);
    expect(res.body.data.opening).toBe(true);
    expect(await rowsOf('SaleInvoice', res.body.data.id)).toEqual([
      ['2030-12-31', 'accrual', '1200', '250.00'],
      ['2030-12-31', 'accrual', '3900', '-250.00'],
    ]);
    expect(await balances('accrual', '2031-12-31')).toEqual({
      '1010': '-100.00',
      '1200': '250.00',
      '3900': '-150.00',
    });
  });

  it('an opening document is dated on or before the day the books start, and every other document after it', async () => {
    const late = await post(
      '/ledger/bills',
      aBill('2031-01-01', { opening: true }),
    );
    expect(late.status).toBe(400);
    expect(errorOf(late).type).toBe('OPENING_DOCUMENT_AFTER_START');
    expect(errorOf(late).payload).toEqual({
      postedOn: '2031-01-01',
      booksStartOn: '2030-12-31',
    });

    const early = await post('/ledger/bills', aBill('2030-12-31'));
    expect(early.status).toBe(400);
    expect(errorOf(early).type).toBe('DOCUMENT_BEFORE_BOOKS_START');
    expect(errorOf(early).payload).toEqual({
      postedOn: '2030-12-31',
      booksStartOn: '2030-12-31',
    });

    // The day after takes an ordinary bill.
    const first = await post('/ledger/bills', aBill('2031-01-01'));
    expect(first.status).toBe(201);
    expect(first.body.data.opening).toBe(false);
    await post(`/ledger/bills/${first.body.data.id}/void`).expect(200);
  });

  it('books with no start day take no opening document', async () => {
    const accounts = (
      await http().get('/ledger/accounts').set(undated.headers()).expect(200)
    ).body.data;
    const rent = accounts.find((a: any) => a.code === '6000').id;
    const res = await http()
      .post('/ledger/bills')
      .set(undated.headers())
      .send({
        vendor_external_id: 'v-1',
        posted_on: '2030-11-20',
        opening: true,
        entries: [{ account_id: rent, rate: '100.00' }],
      });
    expect(res.status).toBe(400);
    expect(errorOf(res).type).toBe('OPENING_DOCUMENT_AFTER_START');
    expect(errorOf(res).payload).toEqual({
      postedOn: '2030-11-20',
      booksStartOn: null,
    });
  });

  it('the opening balances import takes no row on payables or receivables', async () => {
    const res = await post('/ledger/opening-balances', {
      posted_on: '2030-12-31',
      balances: [
        { code: '1010', debit: '500.00', credit: '0.00' },
        { code: '2010', debit: '0.00', credit: '100.00' },
      ],
    });
    expect(res.status).toBe(400);
    expect(errorOf(res).type).toBe('OPENING_CONTROL_ACCOUNT_ROW');
    expect(errorOf(res).payload).toEqual({ index: 1, accountId: id['2010'] });
    // Nothing of the import was written.
    expect(await balances('accrual', '2031-12-31')).toEqual({
      '1010': '-100.00',
      '1200': '250.00',
      '3900': '-150.00',
    });
  });
});
