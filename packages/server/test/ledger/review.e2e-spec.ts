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
 * Faults found by reading the code, each with the case that showed it, on a
 * workspace in America/Chicago.
 */
const chart = () => [
  { code: '1010', name: 'Operating', account_type: 'bank' },
  {
    code: '1200',
    name: 'Receivables',
    account_type: 'accounts-receivable',
    slug: 'accounts-receivable',
  },
  {
    code: '1300',
    name: 'Clearing In',
    account_type: 'other-current-asset',
    slug: 'payments-in-clearing',
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
    code: '2100',
    name: 'Clearing Out',
    account_type: 'other-current-liability',
    slug: 'payments-out-clearing',
    parent_code: '2000',
  },
  { code: '4000', name: 'Sales', account_type: 'income', slug: 'sales' },
  {
    code: '4900',
    name: 'Uncategorized In',
    account_type: 'other-income',
    slug: 'uncategorized-income',
  },
  { code: '6000', name: 'Rent', account_type: 'expense' },
  {
    code: '6900',
    name: 'Uncategorized Out',
    account_type: 'expense',
    slug: 'uncategorized-expense',
  },
];

describe('Ledger extension: faults found in review', () => {
  let app: INestApplication;
  let ws: TestWorkspace;
  let id: Record<string, number>;

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
  const lockAt = (closingAt: string | null) =>
    put('/ledger/settings', { closing_at: closingAt }).expect(200);

  const bill = (postedAt: string, rate: string, extra = {}) => ({
    external_id: `b:${randomUUID()}`,
    vendor_external_id: 'v-1',
    posted_at: postedAt,
    entries: [{ account_id: id['6000'], rate }],
    ...extra,
  });

  beforeAll(async () => {
    app = await createTestApp();
    ws = await createTestWorkspace(app, { accounts: chart() });

    const accounts = (await get('/ledger/accounts').expect(200)).body.data;
    id = Object.fromEntries(accounts.map((a: any) => [a.code, a.id]));
    await post('/ledger/vendors', { external_id: 'v-1' }).expect(201);
  });

  afterAll(async () => {
    await dropOrganizations(app, [ws.workspace.organization_id]);
    await app.close();
  });

  /**
   * A bill payment's cash-basis entry, and what it pays beyond its bills,
   * land on the day it was paid. The lock looked only at its bills' days.
   */
  describe("the lock and a bill payment's own day", () => {
    let open: any;

    beforeAll(async () => {
      open = (
        await post('/ledger/bills', bill('2031-04-20T18:00:00Z', '100.00'))
      ).body.data;
    });

    afterAll(async () => {
      await lockAt(null);
    });

    it('refuses a payment dated in the closed period, with no bill and with an open bill', async () => {
      await lockAt('2031-04-01T00:00:00-05:00');

      const none = await post('/ledger/bill-payments', {
        paid_at: '2031-03-15T18:00:00Z',
        amount: '5.00',
        account_id: id['1010'],
      });
      expect(none.status).toBe(400);
      expect(errorType(none)).toBe('TRANSACTIONS_DATE_LOCKED');

      const onOpenBill = await post('/ledger/bill-payments', {
        paid_at: '2031-03-15T18:00:00Z',
        amount: '10.00',
        account_id: id['1010'],
        allocations: [{ bill_id: open.id, amount: '10.00' }],
      });
      expect(onOpenBill.status).toBe(400);
      expect(errorType(onOpenBill)).toBe('TRANSACTIONS_DATE_LOCKED');
      expect((await get(`/ledger/bills/${open.id}`)).body.data.balance).toBe(
        '100.00',
      );
    });

    it('refuses deleting a payment whose own day has since been closed', async () => {
      await lockAt(null);
      const paid = await post('/ledger/bill-payments', {
        paid_at: '2031-04-12T18:00:00Z',
        amount: '10.00',
        account_id: id['1010'],
        allocations: [{ bill_id: open.id, amount: '10.00' }],
      });
      expect(paid.status).toBe(201);

      // Closed through 14 April: the payment's day is closed, its bill's is not.
      await lockAt('2031-04-15T00:00:00-05:00');
      const res = await del(`/ledger/bill-payments/${paid.body.data.id}`);
      expect(res.status).toBe(400);
      expect(errorType(res)).toBe('TRANSACTIONS_DATE_LOCKED');
      expect((await get(`/ledger/bills/${open.id}`)).body.data.balance).toBe(
        '90.00',
      );
    });
  });

  describe('bills sent at once for a vendor nobody has seen', () => {
    it('all use the one vendor the first of them made', async () => {
      const results = await Promise.all(
        [1, 2, 3, 4].map(() =>
          post(
            '/ledger/bills',
            bill('2031-05-05T18:00:00Z', '1.00', {
              vendor_external_id: 'v-new',
            }),
          ),
        ),
      );
      expect(results.map((res) => res.status)).toEqual([201, 201, 201, 201]);
      expect(new Set(results.map((res) => res.body.data.vendor.id)).size).toBe(
        1,
      );
      expect(results[0].body.data.vendor.external_id).toBe('v-new');
    });
  });

  describe('an account a fixed asset or a loan depends on', () => {
    it('cannot be deleted, though nothing is posted to it', async () => {
      const accumulated = (
        await post('/ledger/accounts', {
          name: 'Accumulated',
          code: '1590',
          account_type: 'fixed-asset',
        }).expect(201)
      ).body.data;
      const asset = (
        await post('/ledger/fixed-assets', {
          name: 'Press',
          asset_type: 'EQUIPMENT',
          cost: '100.00',
          accumulated_account_id: accumulated.id,
        }).expect(201)
      ).body.data;
      const loan = (
        await post('/ledger/loans', {
          name: 'Note',
          loan_type: 'TERM_LOAN',
        }).expect(201)
      ).body.data;

      for (const accountId of [
        accumulated.id,
        asset.account.id,
        loan.account.id,
      ]) {
        const res = await del(`/ledger/accounts/${accountId}`);
        expect(res.status).toBe(400);
        expect(errorType(res)).toBe('ACCOUNT_IN_USE');
      }
      // The value update the deletion would have broken still posts.
      await post('/ledger/fixed-assets/value-updates', {
        asset_id: asset.id,
        amount: '1.00',
        update_type: 'DEPRECIATION_AMORTIZATION',
        posted_at: '2031-06-30T18:00:00Z',
        counter_account_id: id['6000'],
      }).expect(201);
    });
  });

  describe('a paid bill moved to another vendor', () => {
    it("moves the payment's row on payables to the new vendor", async () => {
      const second = (
        await post('/ledger/vendors', { external_id: 'v-2' }).expect(201)
      ).body.data;
      const made = (
        await post('/ledger/bills', bill('2031-07-01T18:00:00Z', '40.00'))
      ).body.data;
      const paid = (
        await post('/ledger/bill-payments', {
          paid_at: '2031-07-02T18:00:00Z',
          amount: '40.00',
          account_id: id['1010'],
          allocations: [{ bill_id: made.id, amount: '40.00' }],
        }).expect(201)
      ).body.data;
      const payableContacts = async () =>
        (
          await ws.rows('accounts_transactions', {
            referenceType: 'BillPayment',
            referenceId: paid.id,
          })
        )
          .filter((row) => row.accountId === id['2010'])
          .map((row) => row.contactId);

      expect(await payableContacts()).toEqual([made.vendor.id]);

      const edited = await put(`/ledger/bills/${made.id}`, {
        vendor_id: second.id,
        posted_at: '2031-07-01T18:00:00Z',
        entries: [{ account_id: id['6000'], rate: '40.00' }],
      });
      expect(edited.status).toBe(200);
      expect(edited.body.data.vendor.id).toBe(second.id);
      expect(await payableContacts()).toEqual([second.id]);
    });
  });

  describe('an invoice edited while one of its payments is deleted', () => {
    it('never leaves the deleted payment with ledger rows', async () => {
      const customer = (
        await post('/ledger/customers', { external_id: 'c-race' }).expect(201)
      ).body.data;
      const body = (note: string) => ({
        customer_id: customer.id,
        posted_at: '2031-08-01T18:00:00Z',
        note,
        entries: [{ account_id: id['4000'], rate: '100.00' }],
      });
      const invoice = (
        await post('/ledger/invoices', body('first')).expect(201)
      ).body.data;

      for (let round = 0; round < 4; round += 1) {
        const paid = (
          await post('/ledger/invoice-payments', {
            customer_id: customer.id,
            paid_at: '2031-08-02T18:00:00Z',
            amount: '100.00',
            account_id: id['1010'],
            allocations: [{ invoice_id: invoice.id, amount: '100.00' }],
          }).expect(201)
        ).body.data;

        const [edited, deleted] = await Promise.all([
          put(`/ledger/invoices/${invoice.id}`, body(`round ${round}`)),
          del(`/ledger/invoice-payments/${paid.id}`),
        ]);
        expect([edited.status, deleted.status]).toEqual([200, 200]);
        expect(
          await ws.rows('accounts_transactions', {
            referenceType: 'PaymentReceive',
            referenceId: paid.id,
          }),
        ).toEqual([]);
        expect(
          (await get(`/ledger/invoices/${invoice.id}`)).body.data.balance,
        ).toBe('100.00');
      }
    });
  });

  describe('an amount larger than the ledger holds', () => {
    it('is refused, as a row and as a running balance', async () => {
      const tooLarge = await post(
        '/ledger/bills',
        bill('2031-09-01T18:00:00Z', '999999999999', {
          entries: [
            { account_id: id['6000'], rate: '999999999999', quantity: '999' },
          ],
        }),
      );
      expect(tooLarge.status).toBe(400);
      expect(errorType(tooLarge)).toBe('AMOUNT_TOO_LARGE');

      const justOver = await post(
        '/ledger/bills',
        bill('2031-09-01T18:00:00Z', '10000000000.00'),
      );
      expect(justOver.status).toBe(400);
      expect(errorType(justOver)).toBe('AMOUNT_TOO_LARGE');

      // 9,000,000,000.00 is within a row, and the running balances of the
      // accounts it touches stay within what they hold.
      const large = await post(
        '/ledger/bills',
        bill('2031-09-01T18:00:00Z', '9000000000.00'),
      );
      expect(large.status).toBe(201);
      expect(large.body.data.amount).toBe('9000000000.00');

      // A second one would carry the payable's balance past what it holds.
      const second = await post(
        '/ledger/bills',
        bill('2031-09-01T18:00:00Z', '9000000000.00'),
      );
      expect(second.status).toBe(400);
      expect(errorType(second)).toBe('AMOUNT_TOO_LARGE');

      await put(`/ledger/bills/${large.body.data.id}`, {
        vendor_external_id: 'v-1',
        posted_at: '2031-09-01T18:00:00Z',
        entries: [{ account_id: id['6000'], rate: '1.00' }],
      }).expect(200);

      const payment = await post('/ledger/bill-payments', {
        paid_at: '2031-09-02T18:00:00Z',
        amount: '10000000000.00',
        account_id: id['1010'],
      });
      expect(payment.status).toBe(400);
      expect(errorType(payment)).toBe('AMOUNT_TOO_LARGE');
    });
  });

  describe('the size of a request body', () => {
    it('is the small default on a route that needs no sign-in', async () => {
      const res = await http()
        .post('/auth/signin')
        .send({ email: 'a@b.test', password: 'x'.repeat(200 * 1024) });
      expect(res.status).toBe(413);
    });

    it('is large on the routes of the ledger', async () => {
      const res = await post('/ledger/vendors', {
        external_id: 'v-big',
        notes: 'x'.repeat(9000),
        company_name: 'Big',
      });
      expect(res.status).toBe(201);

      // 300 KB of metadata: over the default, within the ledger's limit.
      const big = await post('/ledger/accounts', {
        name: 'Big Metadata',
        account_type: 'expense',
        metadata: { blob: 'x'.repeat(40 * 1024) },
      });
      expect(big.status).toBe(201);
      const bigger = await post('/ledger/manual-journals', {
        posted_at: '2031-10-01T18:00:00Z',
        description: 'x'.repeat(300 * 1024),
        entries: [
          { account_id: id['6000'], debit: '1.00', credit: '0' },
          { account_id: id['1010'], debit: '0', credit: '1.00' },
        ],
      });
      expect(bigger.status).not.toBe(413);
    });
  });

  describe('the closing instant', () => {
    it('is read back as none once cleared, and set again', async () => {
      await lockAt('2031-02-01T00:00:00-06:00');
      await lockAt(null);
      expect((await get('/ledger/settings')).body.data.closing_at).toBeNull();

      // With the lock cleared a write dated before the old closing is open.
      await post('/ledger/manual-journals', {
        posted_at: '2031-01-10T18:00:00Z',
        entries: [
          { account_id: id['6000'], debit: '1.00', credit: '0' },
          { account_id: id['1010'], debit: '0', credit: '1.00' },
        ],
      }).expect(201);
    });
  });
});
