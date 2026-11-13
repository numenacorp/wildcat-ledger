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
 * Rules the books keep whatever a caller sends: type roots take no postings,
 * an archived account takes no new line, a line on the receivable or the
 * payable account names its party, and a fixed asset or a loan says where
 * its other side goes.
 *
 * The books start on 1 January 2031, Central time. Every figure below is
 * worked by hand, as debits less credits of the account alone.
 *
 *   Journal, 10 Mar   Dr 6000 Rent 100.00        Cr 2010 Payables 100.00
 *                     (the payable line names the vendor)
 *   Bill, 11 Mar      Dr 6100 Supplies 100.00    Cr 2010 Payables 100.00
 *                     then 6100 is archived: it still reports its 100.00
 *   Asset, 10 Mar     a truck of 1,200.00 bought from the bank
 *                     Dr the truck's account 1,200.00   Cr 1010 Bank 1,200.00
 *   Loan, 10 Mar      5,000.00 received into the bank
 *                     Dr 1010 Bank 5,000.00   Cr the loan's account 5,000.00
 *   Asset, 31 Dec 2030  a rig of 800.00 held as the books began
 *                     Dr the rig's account 800.00   Cr 3900 Opening Equity 800.00
 *
 * So:  1010 = -1,200.00 + 5,000.00 = 3,800.00     2010 = -200.00
 *      6000 = 100.00   6100 = 100.00   Truck = 1,200.00   Rig = 800.00
 *      the loan = -5,000.00   3900 = -800.00
 * and nothing on any of the five roots.
 */
const chart = () => [
  {
    code: '1',
    name: 'Assets',
    account_type: 'other-current-asset',
    type_root: true,
  },
  {
    code: '2',
    name: 'Liabilities',
    account_type: 'other-current-liability',
    type_root: true,
  },
  { code: '3', name: 'Equity', account_type: 'equity', type_root: true },
  { code: '4', name: 'Income', account_type: 'income', type_root: true },
  { code: '5', name: 'Expenses', account_type: 'expense', type_root: true },
  { code: '1010', name: 'Bank', account_type: 'bank', parent_code: '1' },
  {
    code: '1200',
    name: 'Receivables',
    account_type: 'accounts-receivable',
    slug: 'accounts-receivable',
    parent_code: '1',
  },
  {
    code: '1500',
    name: 'Equipment',
    account_type: 'fixed-asset',
    slug: 'fixed-assets',
    parent_code: '1',
  },
  {
    code: '2010',
    name: 'Payables',
    account_type: 'accounts-payable',
    slug: 'accounts-payable',
    parent_code: '2',
  },
  {
    code: '3900',
    name: 'Opening Equity',
    account_type: 'equity',
    slug: 'opening-balance-equity',
    parent_code: '3',
  },
  { code: '4000', name: 'Sales', account_type: 'income', parent_code: '4' },
  { code: '6000', name: 'Rent', account_type: 'expense', parent_code: '5' },
  { code: '6100', name: 'Supplies', account_type: 'expense', parent_code: '5' },
  { code: '6200', name: 'Field', account_type: 'expense', parent_code: '5' },
  {
    code: '6210',
    name: 'Hauling',
    account_type: 'expense',
    parent_code: '6200',
  },
];

const BOOKS_START = '2031-01-01';
const MAR_10 = '2031-03-10';
const MAR_11 = '2031-03-11';

describe('Ledger extension: type roots, archived accounts, parties on journals, funding', () => {
  let app: INestApplication;
  let ws: TestWorkspace;
  let id: Record<string, number>;
  let vendor: any;
  let customer: any;

  const http = () => request(app.getHttpServer());
  const get = (path: string, query: Record<string, unknown> = {}) =>
    http().get(path).query(query).set(ws.headers());
  const post = (path: string, body: unknown = {}) =>
    change(app, 'post', path, ws.headers(), body);
  const put = (path: string, body: unknown) =>
    change(app, 'put', path, ws.headers(), body);
  const del = (path: string) => change(app, 'delete', path, ws.headers());
  const error = (res: request.Response) => res.body?.errors?.[0];

  const accounts = async () =>
    (
      await get('/ledger/accounts', { include_before_start: 'true' }).expect(
        200,
      )
    ).body.data as any[];
  /** Each account's own balance that is not zero, by code, or by name where it has no code. */
  const own = async () =>
    Object.fromEntries(
      (await accounts())
        .filter((a) => a.own_balance !== '0.00')
        .map((a) => [a.code ?? a.name, a.own_balance]),
    );
  const line = (code: string, debit: string, credit: string, extra = {}) => ({
    account_id: id[code],
    debit,
    credit,
    ...extra,
  });
  const ledgerRows = async () =>
    (await ws.rows('accounts_transactions')).length;
  /** A write that must be refused and must leave the ledger as it was. */
  const refused = async (
    send: () => request.Test,
    type: string,
    status = 400,
  ) => {
    const before = await ledgerRows();
    const res = await send();

    expect([res.status, error(res)?.type]).toEqual([status, type]);
    expect(await ledgerRows()).toBe(before);
    return error(res);
  };

  beforeAll(async () => {
    app = await createTestApp();
    ws = await createTestWorkspace(app, {
      accounts: chart(),
      books_start_on: BOOKS_START,
    });
    id = Object.fromEntries((await accounts()).map((a) => [a.code, a.id]));
    vendor = (await post('/ledger/vendors', { external_id: 'v-1' })).body.data;
    customer = (await post('/ledger/customers', { external_id: 'c-1' })).body
      .data;
  });

  afterAll(async () => {
    await dropOrganizations(app, [ws.workspace.organization_id]);
    await app.close();
  });

  describe('a type root', () => {
    it('is the entry the chart marks, and no other', async () => {
      expect(
        (await accounts()).filter((a) => a.is_type_root).map((a) => a.code),
      ).toEqual(['1', '2', '3', '4', '5']);
    });

    it('takes no journal line', async () => {
      const payload = await refused(
        () =>
          post('/ledger/manual-journals', {
            posted_on: MAR_10,
            entries: [line('5', '10.00', '0'), line('1010', '0', '10.00')],
          }),
        'ACCOUNT_IS_TYPE_ROOT',
      );
      expect(payload.payload).toEqual({ accountIds: [id['5']] });
    });

    it('takes no bill line', async () => {
      await refused(
        () =>
          post('/ledger/bills', {
            vendor_id: vendor.id,
            posted_on: MAR_10,
            entries: [{ account_id: id['5'], rate: '10.00' }],
          }),
        'ACCOUNT_IS_TYPE_ROOT',
      );
    });

    it('takes no opening balance', async () => {
      await refused(
        () =>
          post('/ledger/opening-balances', {
            posted_on: '2030-12-31',
            balances: [
              { code: '1', debit: '10.00', credit: '0' },
              { code: '3900', debit: '0', credit: '10.00' },
            ],
          }),
        'ACCOUNT_IS_TYPE_ROOT',
      );
    });

    it('cannot be moved under an account, deleted or archived', async () => {
      const move = await put(`/ledger/accounts/${id['4']}`, {
        parent_id: id['4000'],
      });
      expect([move.status, error(move)?.type]).toEqual([
        400,
        'ACCOUNT_IS_TYPE_ROOT',
      ]);
      const remove = await del(`/ledger/accounts/${id['4']}`);
      expect(error(remove)?.type).toBe('ACCOUNT_IS_TYPE_ROOT');
      const archive = await post(`/ledger/accounts/${id['4']}/archive`);
      expect([archive.status, error(archive)?.type]).toEqual([
        400,
        'ACCOUNT_IS_TYPE_ROOT',
      ]);
    });

    it('a parent beneath a root still takes a line', async () => {
      const res = await post('/ledger/manual-journals', {
        posted_on: MAR_10,
        entries: [line('6200', '7.00', '0'), line('6210', '0', '7.00')],
      });
      expect(res.status).toBe(201);
      await del(`/ledger/manual-journals/${res.body.data.id}`).expect(200);
    });

    it('a chart may not mark two roots of one type, nor a root with a parent', async () => {
      const two = await http()
        .post('/ledger/workspaces')
        .set(ws.headers())
        .send({
          external_id: 'ws:two-roots',
          name: 'Two roots',
          country: 'US',
          base_currency: 'USD',
          timezone: 'America/Chicago',
          accounts: [
            {
              code: '5',
              name: 'Expenses',
              account_type: 'expense',
              type_root: true,
            },
            {
              code: '6',
              name: 'More',
              account_type: 'other-expense',
              type_root: true,
            },
            {
              code: '61',
              name: 'Under',
              account_type: 'expense',
              parent_code: '5',
              type_root: true,
            },
          ],
        });
      expect([two.status, error(two)?.type]).toEqual([400, 'CHART_INVALID']);
      expect(
        error(two).payload.problems.map((p: any) => [p.code, p.problem]),
      ).toEqual([
        ['6', 'The chart marks more than one type root for expense.'],
        ['61', 'A type root has no parent.'],
        ['61', 'The chart marks more than one type root for expense.'],
      ]);
    });
  });

  describe('a line on the payable or the receivable account', () => {
    let journalId: number;

    it('is refused without its party, and says which line', async () => {
      const payable = await refused(
        () =>
          post('/ledger/manual-journals', {
            posted_on: MAR_10,
            entries: [line('6000', '100.00', '0'), line('2010', '0', '100.00')],
          }),
        'JOURNAL_LINE_PARTY_REQUIRED',
      );
      expect(payable.payload).toEqual({ index: 2, accountId: id['2010'] });

      // A customer does not stand in for the vendor of a payable line.
      await refused(
        () =>
          post('/ledger/manual-journals', {
            posted_on: MAR_10,
            entries: [
              line('6000', '100.00', '0'),
              line('2010', '0', '100.00', { customer_id: customer.id }),
            ],
          }),
        'JOURNAL_LINE_PARTY_REQUIRED',
      );
      const receivable = await refused(
        () =>
          post('/ledger/manual-journals', {
            posted_on: MAR_10,
            entries: [line('1200', '5.00', '0'), line('4000', '0', '5.00')],
          }),
        'JOURNAL_LINE_PARTY_REQUIRED',
      );
      expect(receivable.payload).toEqual({ index: 1, accountId: id['1200'] });
    });

    it('is refused with both parties, or with one that does not exist', async () => {
      await refused(
        () =>
          post('/ledger/manual-journals', {
            posted_on: MAR_10,
            entries: [
              line('6000', '100.00', '0'),
              line('2010', '0', '100.00', {
                vendor_id: vendor.id,
                customer_id: customer.id,
              }),
            ],
          }),
        'JOURNAL_LINE_NAMES_ONE_PARTY',
      );
      // A customer's id is not a vendor's.
      await refused(
        () =>
          post('/ledger/manual-journals', {
            posted_on: MAR_10,
            entries: [
              line('6000', '100.00', '0'),
              line('2010', '0', '100.00', { vendor_id: customer.id }),
            ],
          }),
        'vendor_not_found',
        404,
      );
    });

    it('posts with its vendor, on the ledger row and on the line it answers', async () => {
      const res = await post('/ledger/manual-journals', {
        external_id: 'j-payable',
        posted_on: MAR_10,
        entries: [
          line('6000', '100.00', '0'),
          line('2010', '0', '100.00', { vendor_id: vendor.id }),
        ],
      });
      expect(res.status).toBe(201);
      journalId = res.body.data.id;
      expect(
        res.body.data.entries.map((e: any) => [e.customer_id, e.vendor_id]),
      ).toEqual([
        [null, null],
        [null, vendor.id],
      ]);
      const [row] = await ws.rows('accounts_transactions', {
        referenceType: 'Journal',
        referenceId: journalId,
        accountId: id['2010'],
      });
      expect(row.contactId).toBe(vendor.id);
      expect(await own()).toEqual({ '2010': '-100.00', '6000': '100.00' });
    });

    it("takes a party by the caller's own id: a customer that exists, a vendor made on sight", async () => {
      const unknown = await refused(
        () =>
          post('/ledger/manual-journals', {
            posted_on: MAR_10,
            entries: [
              line('1200', '5.00', '0', { customer_external_id: 'c-nobody' }),
              line('4000', '0', '5.00'),
            ],
          }),
        'customer_not_found',
        404,
      );
      expect(unknown.payload).toEqual({ externalId: 'c-nobody' });

      const vendors = async () =>
        (await ws.rows('ext_parties', { kind: 'vendor' })).length;
      const before = await vendors();
      const res = await post('/ledger/manual-journals', {
        posted_on: MAR_10,
        entries: [
          line('1200', '5.00', '0', { customer_external_id: 'c-1' }),
          line('2010', '0', '5.00', { vendor_external_id: 'v-new' }),
        ],
      });
      expect(res.status).toBe(201);
      expect(await vendors()).toBe(before + 1);
      expect(
        res.body.data.entries.map((e: any) => [
          e.customer_id,
          e.customer_external_id,
          e.vendor_external_id,
        ]),
      ).toEqual([
        [customer.id, 'c-1', null],
        [null, null, 'v-new'],
      ]);
      // Taken out again, so the figures worked at the top stand.
      await del(`/ledger/manual-journals/${res.body.data.id}`).expect(200);

      await refused(
        () =>
          post('/ledger/manual-journals', {
            posted_on: MAR_10,
            entries: [
              line('6000', '5.00', '0'),
              line('2010', '0', '5.00', {
                vendor_id: vendor.id,
                vendor_external_id: 'v-1',
              }),
            ],
          }),
        'JOURNAL_LINE_NAMES_ONE_PARTY',
      );
    });

    it('an edit that drops the party is refused, and the journal stays', async () => {
      const before = (await get(`/ledger/manual-journals/${journalId}`)).body
        .data;
      const edit = await put(`/ledger/manual-journals/${journalId}`, {
        posted_on: MAR_10,
        entries: [line('6000', '100.00', '0'), line('2010', '0', '100.00')],
      });
      expect([edit.status, error(edit)?.type]).toEqual([
        400,
        'JOURNAL_LINE_PARTY_REQUIRED',
      ]);
      expect(
        (await get(`/ledger/manual-journals/${journalId}`)).body.data,
      ).toEqual(before);
    });
  });

  describe('an archived account', () => {
    let billId: number;

    it('is archived after a bill, and still reports what it holds', async () => {
      const bill = await post('/ledger/bills', {
        vendor_id: vendor.id,
        posted_on: MAR_11,
        entries: [
          { account_id: id['6100'], rate: '100.00', external_id: 'l1' },
        ],
      });
      expect(bill.status).toBe(201);
      billId = bill.body.data.id;

      const res = await post(`/ledger/accounts/${id['6100']}/archive`);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        id: id['6100'],
        active: false,
        own_balance: '100.00',
      });
      expect(await own()).toEqual({
        '2010': '-200.00',
        '6000': '100.00',
        '6100': '100.00',
      });
    });

    it('takes no new line: a bill, a journal, a payment from it', async () => {
      const bill = await refused(
        () =>
          post('/ledger/bills', {
            vendor_id: vendor.id,
            posted_on: MAR_11,
            entries: [{ account_id: id['6100'], rate: '100.00' }],
          }),
        'ACCOUNT_ARCHIVED',
      );
      expect(bill.payload).toEqual({ accountIds: [id['6100']] });
      await refused(
        () =>
          post('/ledger/manual-journals', {
            posted_on: MAR_11,
            entries: [line('6100', '1.00', '0'), line('1010', '0', '1.00')],
          }),
        'ACCOUNT_ARCHIVED',
      );
      await refused(
        () =>
          post('/ledger/bill-payments', {
            paid_on: MAR_11,
            amount: '5.00',
            account_id: id['6100'],
            allocations: [],
          }),
        'ACCOUNT_ARCHIVED',
      );
    });

    it('takes its accounts beneath with it, and comes back with them', async () => {
      const archived = await post(`/ledger/accounts/${id['6200']}/archive`);
      expect(archived.status).toBe(200);
      const off = Object.fromEntries(
        (await accounts()).map((a) => [a.code, a.active]),
      );
      expect([off['6200'], off['6210'], off['6000']]).toEqual([
        false,
        false,
        true,
      ]);
      await post(`/ledger/accounts/${id['6200']}/restore`).expect(200);
      const on = Object.fromEntries(
        (await accounts()).map((a) => [a.code, a.active]),
      );
      expect([on['6200'], on['6210']]).toEqual([true, true]);
    });

    it('an account documents post to by role cannot be archived', async () => {
      for (const code of ['2010', '1200', '3900']) {
        const res = await post(`/ledger/accounts/${id[code]}/archive`);
        expect([code, res.status, error(res)?.type]).toEqual([
          code,
          400,
          'account_predefined',
        ]);
      }
    });

    it('restored, it takes a line again', async () => {
      const res = await post(`/ledger/accounts/${id['6100']}/restore`);
      expect(res.body.data.active).toBe(true);

      const edit = await put(`/ledger/bills/${billId}`, {
        vendor_id: vendor.id,
        posted_on: MAR_11,
        entries: [
          { account_id: id['6100'], rate: '100.00', external_id: 'l1' },
        ],
      });
      expect(edit.status).toBe(200);
    });
  });

  describe('a fixed asset and a loan say where the other side goes', () => {
    const asset = (extra = {}) => ({
      name: 'Truck',
      asset_type: 'VEHICLE',
      cost: '1200.00',
      ...extra,
    });
    const loan = (extra = {}) => ({
      name: 'Bank Note',
      loan_type: 'TERM_LOAN',
      ...extra,
    });

    it('an asset bought from the bank credits the bank, not opening equity', async () => {
      const res = await post(
        '/ledger/fixed-assets',
        asset({
          funding: {
            amount: '1200.00',
            posted_on: MAR_10,
            from: 'account',
            account_id: id['1010'],
          },
        }),
      );
      expect(res.status).toBe(201);
      expect(res.body.data.funding).toEqual({
        amount: '1200.00',
        posted_on: MAR_10,
        from: 'account',
        account_id: id['1010'],
      });
      expect(await own()).toEqual({
        '1010': '-1200.00',
        '2010': '-200.00',
        '6000': '100.00',
        '6100': '100.00',
        Truck: '1200.00',
      });
    });

    it('a loan received into the bank debits the bank, not opening equity', async () => {
      const res = await post(
        '/ledger/loans',
        loan({
          funding: {
            amount: '5000.00',
            posted_on: MAR_10,
            from: 'account',
            account_id: id['1010'],
          },
        }),
      );
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({
        balance: '5000.00',
        funding: {
          amount: '5000.00',
          posted_on: MAR_10,
          from: 'account',
          account_id: id['1010'],
        },
      });
      expect(await own()).toEqual({
        '1010': '3800.00',
        '2010': '-200.00',
        '6000': '100.00',
        '6100': '100.00',
        Truck: '1200.00',
        'Bank Note': '-5000.00',
      });
    });

    it('describes each entry by what it is', async () => {
      const feed = (await get('/ledger/entries', { order: 'asc' }).expect(200))
        .body.data;
      expect(
        feed
          .filter((e: any) => e.source_type === 'record_funding')
          .map((e: any) => e.description),
      ).toEqual(['Purchase of Truck', 'Proceeds of Bank Note']);
    });

    it('what was held as the books began goes against opening equity', async () => {
      const res = await post(
        '/ledger/fixed-assets',
        asset({
          name: 'Rig',
          cost: '800.00',
          funding: {
            amount: '800.00',
            posted_on: '2030-12-31',
            from: 'opening',
          },
        }),
      );
      expect(res.status).toBe(201);
      expect(res.body.data.funding).toMatchObject({
        from: 'opening',
        account_id: null,
      });
      expect(await own()).toEqual({
        '1010': '3800.00',
        '2010': '-200.00',
        '3900': '-800.00',
        '6000': '100.00',
        '6100': '100.00',
        Truck: '1200.00',
        Rig: '800.00',
        'Bank Note': '-5000.00',
      });
    });

    it('the day the books start is the last day for "held at the start"', async () => {
      // 1 January 2031 in Chicago, late in the evening.
      const onTheDay = await post(
        '/ledger/fixed-assets',
        asset({
          name: 'Trailer',
          cost: '1.00',
          funding: {
            amount: '1.00',
            posted_on: '2031-01-01',
            from: 'opening',
          },
        }),
      );
      expect(onTheDay.status).toBe(201);

      // 2 January 2031 in Chicago, just after midnight.
      const dayAfter = {
        amount: '1.00',
        posted_on: '2031-01-02',
        from: 'opening',
      };
      const refusedAsset = await refused(
        () =>
          post(
            '/ledger/fixed-assets',
            asset({ name: 'Late', funding: dayAfter }),
          ),
        'OPENING_AFTER_BOOKS_START',
      );
      expect(refusedAsset.payload).toEqual({
        postedOn: '2031-01-02',
        booksStartOn: BOOKS_START,
      });
      await refused(
        () => post('/ledger/loans', loan({ name: 'Late', funding: dayAfter })),
        'OPENING_AFTER_BOOKS_START',
      );
      expect((await accounts()).some((a) => a.name === 'Late')).toBe(false);
    });

    it('refuses an account that is missing, named with "opening", or not allowed', async () => {
      const funding = (extra: object) => ({
        amount: '1.00',
        posted_on: MAR_10,
        ...extra,
      });
      await refused(
        () =>
          post(
            '/ledger/fixed-assets',
            asset({ funding: funding({ from: 'account' }) }),
          ),
        'FUNDING_ACCOUNT_REQUIRED',
      );
      await refused(
        () =>
          post(
            '/ledger/fixed-assets',
            asset({
              funding: funding({ from: 'opening', account_id: id['1010'] }),
            }),
          ),
        'FUNDING_ACCOUNT_REQUIRED',
      );
      for (const code of ['2010', '1200', '6000', '3900']) {
        const res = await post(
          '/ledger/fixed-assets',
          asset({
            funding: funding({ from: 'account', account_id: id[code] }),
          }),
        );
        expect([code, error(res)?.type]).toEqual([
          code,
          'FUNDING_ACCOUNT_NOT_ALLOWED',
        ]);
      }
      const root = await post(
        '/ledger/fixed-assets',
        asset({ funding: funding({ from: 'account', account_id: id['1'] }) }),
      );
      expect(error(root)?.type).toBe('ACCOUNT_IS_TYPE_ROOT');
    });
  });
});
