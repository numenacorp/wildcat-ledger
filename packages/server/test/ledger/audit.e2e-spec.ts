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
 * The audit log: every create, edit, void and delete of a bill, an invoice,
 * a payment, a journal and an account leaves a row that says what was done,
 * who it was done for, and the record as it stood before and after.
 *
 * The story, in order, each step made for the member named:
 *
 *   ana   makes a bill of 100.00 (reference B-1) to Rent
 *   ben   edits it to 120.00
 *   ana   pays 50.00 of it (reference CHK-7)
 *   ben   deletes the payment
 *   ben   voids the bill
 *   ana   posts a journal of 30.00, edits it to 40.00, deletes it
 *   ana   makes an account, renames it, archives it, restores it, deletes it
 *   (no one named) makes an invoice of 75.00
 *
 * So the log of the bill reads, oldest first: create (nothing before, 100.00
 * after), edit (100.00 before, 120.00 after), void (open at 120.00 before,
 * voided with nothing owed after). The payment's: create (50.00 after),
 * delete (50.00 before, nothing after).
 */
const chart = () => [
  { code: '1010', name: 'Bank', account_type: 'bank' },
  { code: '1200', name: 'Receivables', account_type: 'accounts-receivable' },
  { code: '2010', name: 'Payables', account_type: 'accounts-payable' },
  { code: '4000', name: 'Sales', account_type: 'income' },
  { code: '6000', name: 'Rent', account_type: 'expense' },
];

describe('Ledger extension: the audit log', () => {
  let app: INestApplication;
  let ws: TestWorkspace;
  let id: Record<string, number>;
  let vendor: any;
  let customer: any;

  const http = () => request(app.getHttpServer());
  const as = (actor: string | null) =>
    actor ? { ...ws.headers(), 'x-ledger-actor': actor } : ws.headers();
  const get = (path: string, query: Record<string, unknown> = {}) =>
    http().get(path).query(query).set(ws.headers());
  const post = (actor: string | null, path: string, body: unknown = {}) =>
    change(app, 'post', path, as(actor), body);
  const put = (actor: string | null, path: string, body: unknown) =>
    change(app, 'put', path, as(actor), body);
  const del = (actor: string | null, path: string) =>
    change(app, 'delete', path, as(actor));
  /** The log of one record, oldest first. */
  const logOf = async (subject: string, subjectId: number) =>
    (
      await get('/ledger/audit-log', {
        subject,
        subject_id: subjectId,
      }).expect(200)
    ).body.data.reverse() as any[];
  const total = async () =>
    (await get('/ledger/audit-log').expect(200)).body.pagination.total;

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
    customer = (await post(null, '/ledger/customers', { external_id: 'c-1' }))
      .body.data;
  });

  afterAll(async () => {
    await dropOrganizations(app, [ws.workspace.organization_id]);
    await app.close();
  });

  describe('a bill and its payment', () => {
    let bill: any;
    let payment: any;
    const body = (rate: string) => ({
      vendor_id: vendor.id,
      posted_on: '2031-03-10',
      reference: 'B-1',
      entries: [{ account_id: id['6000'], rate, external_id: 'l1' }],
    });

    it('a create leaves a row with nothing before and the bill after', async () => {
      bill = (await post('ana', '/ledger/bills', body('100.00')).expect(201))
        .body.data;
      const log = await logOf('bill', bill.id);

      expect(log).toHaveLength(1);
      expect(log[0]).toMatchObject({
        action: 'create',
        subject: 'bill',
        subject_id: bill.id,
        number: 'B-1',
        actor: 'ana',
        before: null,
        after: { id: bill.id, amount: '100.00', status: 'open' },
        created_at: expect.any(String),
      });
      // The whole bill, as its route answers it.
      expect(log[0].after).toEqual(bill);
    });

    it('an edit keeps the bill as it was, and as it became', async () => {
      const edited = (
        await put('ben', `/ledger/bills/${bill.id}`, body('120.00')).expect(200)
      ).body.data;
      const log = await logOf('bill', bill.id);

      expect(log.map((r) => [r.action, r.actor])).toEqual([
        ['create', 'ana'],
        ['edit', 'ben'],
      ]);
      expect(log[1].before).toEqual(bill);
      expect(log[1].after).toEqual(edited);
      expect([log[1].before.amount, log[1].after.amount]).toEqual([
        '100.00',
        '120.00',
      ]);
    });

    it('a payment is logged when made, and when deleted the row keeps it whole', async () => {
      payment = (
        await post('ana', '/ledger/bill-payments', {
          paid_on: '2031-03-12',
          amount: '50.00',
          account_id: id['1010'],
          reference: 'CHK-7',
          allocations: [{ bill_id: bill.id, amount: '50.00' }],
        }).expect(201)
      ).body.data;
      await del('ben', `/ledger/bill-payments/${payment.id}`).expect(200);

      const log = await logOf('bill_payment', payment.id);
      expect(
        log.map((r) => [r.action, r.actor, r.number, r.before?.amount ?? null]),
      ).toEqual([
        ['create', 'ana', 'CHK-7', null],
        ['delete', 'ben', 'CHK-7', '50.00'],
      ]);
      expect(log[0].after).toEqual(payment);
      expect(log[1].before).toEqual(payment);
      expect(log[1].after).toBeNull();
    });

    it('a void is logged with the bill open before and voided after', async () => {
      await post('ben', `/ledger/bills/${bill.id}/void`).expect(200);
      const log = await logOf('bill', bill.id);

      expect(
        log.map((r) => [r.action, r.before?.status ?? null, r.after?.status]),
      ).toEqual([
        ['create', null, 'open'],
        ['edit', 'open', 'open'],
        ['void', 'open', 'voided'],
      ]);
      expect([log[2].before.balance, log[2].after.balance]).toEqual([
        '120.00',
        '0.00',
      ]);
      // A second void changes nothing and logs nothing.
      await post('ben', `/ledger/bills/${bill.id}/void`).expect(200);
      expect(await logOf('bill', bill.id)).toHaveLength(3);
    });

    it("Bigcapital's own log has a row for each, which the extension's row points to", async () => {
      const rows = await ws.rows('audit_logs', {
        subject: 'bill',
        subjectId: bill.id,
      });
      expect(rows.map((r) => r.action).sort()).toEqual([
        'create',
        'edit',
        'void',
      ]);
      const own = await ws.rows('ext_audit_log', {
        subject: 'bill',
        subjectId: bill.id,
      });
      expect(own.map((r) => r.auditLogId).sort()).toEqual(
        rows.map((r) => r.id).sort(),
      );
    });

    it('a write that is refused leaves no row', async () => {
      const before = await total();
      // A voided bill takes no edit.
      await put('ana', `/ledger/bills/${bill.id}`, body('130.00')).expect(400);
      // A bill to an account that does not exist.
      await post('ana', '/ledger/bills', {
        vendor_id: vendor.id,
        posted_on: '2031-03-10',
        entries: [{ account_id: 99999999, rate: '1.00' }],
      }).expect(404);
      expect(await total()).toBe(before);
    });
  });

  describe('a journal', () => {
    it('is logged when posted, edited and deleted, and the delete keeps it whole', async () => {
      const body = (amount: string) => ({
        posted_on: '2031-03-15',
        entries: [
          { account_id: id['6000'], debit: amount, credit: '0' },
          { account_id: id['1010'], debit: '0', credit: amount },
        ],
      });
      const made = (
        await post('ana', '/ledger/manual-journals', body('30.00')).expect(201)
      ).body.data;
      const edited = (
        await put(
          'ana',
          `/ledger/manual-journals/${made.id}`,
          body('40.00'),
        ).expect(200)
      ).body.data;
      await del('ana', `/ledger/manual-journals/${made.id}`).expect(200);

      const log = await logOf('manual_journal', made.id);
      expect(log.map((r) => [r.action, r.number, r.actor])).toEqual([
        ['create', made.journal_number, 'ana'],
        ['edit', made.journal_number, 'ana'],
        ['delete', made.journal_number, 'ana'],
      ]);
      expect(log[0].before).toBeNull();
      expect(log[0].after).toEqual(made);
      expect(log[1].before).toEqual(made);
      expect(log[1].after).toEqual(edited);
      expect(log[2].before).toEqual(edited);
      expect(log[2].after).toBeNull();
      expect(log[2].before.entries.map((e: any) => e.debit)).toEqual([
        '40.00',
        '0.00',
      ]);
    });
  });

  describe('an account', () => {
    it('is logged when made, renamed, archived, restored and deleted', async () => {
      const made = (
        await post('ana', '/ledger/accounts', {
          name: 'Hauling',
          code: '6100',
          account_type: 'expense',
        }).expect(201)
      ).body.data;
      await put('ana', `/ledger/accounts/${made.id}`, {
        name: 'Water Hauling',
      }).expect(200);
      await post('ana', `/ledger/accounts/${made.id}/archive`).expect(200);
      await post('ana', `/ledger/accounts/${made.id}/restore`).expect(200);
      await del('ana', `/ledger/accounts/${made.id}`).expect(200);

      const log = await logOf('account', made.id);
      expect(
        log.map((r) => [
          r.action,
          r.number,
          r.before?.name ?? null,
          r.after?.name ?? null,
          r.after?.active ?? null,
        ]),
      ).toEqual([
        ['create', '6100', null, 'Hauling', true],
        ['edit', '6100', 'Hauling', 'Water Hauling', true],
        ['archive', '6100', 'Water Hauling', 'Water Hauling', false],
        ['restore', '6100', 'Water Hauling', 'Water Hauling', true],
        ['delete', '6100', 'Water Hauling', null, null],
      ]);
    });
  });

  describe('reading the log', () => {
    it('a call that names no one is logged with no actor', async () => {
      const invoice = (
        await post(null, '/ledger/invoices', {
          customer_id: customer.id,
          posted_on: '2031-03-20',
          entries: [{ account_id: id['4000'], rate: '75.00' }],
        }).expect(201)
      ).body.data;
      const [row] = await logOf('sale_invoice', invoice.id);
      expect([row.action, row.actor, row.number, row.after.amount]).toEqual([
        'create',
        null,
        'INV-000001',
        '75.00',
      ]);
      expect(row.after).toEqual(invoice);
    });

    it('lists every row newest first, pages, and keeps to a range', async () => {
      const all = (await get('/ledger/audit-log', { page_size: 500 })).body;
      // The bill 3, the payment 2, the journal 3, the account 5, the invoice 1.
      expect(all.pagination.total).toBe(14);
      const stamps = all.data.map((r: any) => r.created_at);
      expect([...stamps].sort().reverse()).toEqual(stamps);

      const page = (await get('/ledger/audit-log', { page_size: 5, page: 3 }))
        .body;
      expect(page.data).toHaveLength(4);
      expect(page.data.map((r: any) => r.id)).toEqual(
        all.data.slice(10).map((r: any) => r.id),
      );
      const future = await get('/ledger/audit-log', {
        from: '2998-12-31',
      });
      expect(future.body.pagination.total).toBe(0);
      const past = await get('/ledger/audit-log', {
        to: '2999-01-01T00:00:00Z',
      });
      expect(past.body.pagination.total).toBe(14);
    });

    it('refuses a subject that is no kind of record, and an unknown field', async () => {
      await get('/ledger/audit-log', { subject: 'nonsense' }).expect(400);
      await get('/ledger/audit-log', { sort: 'actor' }).expect(400);
    });
  });
});
