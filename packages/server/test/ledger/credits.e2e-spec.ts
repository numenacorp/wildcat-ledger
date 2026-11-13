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
 * Credits: money a payment leaves unapplied, vendor credits and customer
 * credit notes, and the application of each to a document.
 *
 * Every figure is worked by hand, as debits less credits, in 2031.
 *
 * Payables, vendor v-1.
 *
 *   B1 100.00 to Rent, 10 March. P1 150.00 from Bank on 15 May, 100.00 of it
 *   to B1; it names no vendor, so the 50.00 over is a credit with B1's.
 *     accrual  Bank -150   Payables -100 + 150 = +50   Rent 100
 *     cash     Bank -150   Rent 100   Unapplied expense 50
 *
 *   B2 80.00 to Repairs, 1 June. 50.00 of P1 applied to it: dated 1 June,
 *   the later of 15 May and 1 June.
 *     accrual  Bank -150   Payables 50 - 80 = -30   Rent 100   Repairs 80
 *     cash, through May   Bank -150   Rent 100   Unapplied expense 50
 *     cash, through June  Bank -150   Rent 100   Repairs 50
 *
 *   The application deleted: as before it. Applied again, then P1 deleted:
 *   its application goes with it, and both bills owe in full.
 *     accrual  Payables -180   Rent 100   Repairs 80
 *     cash     nothing
 *   Both bills voided: the books are empty.
 *
 *   B3 100.00 to Rent, 10 March. Vendor credit C1 30.00 to Rent, 20 March,
 *   applied to B3: dated 20 March.
 *     accrual, through April  Payables -100 + 30 = -70   Rent 100 - 30 = 70
 *     cash, through April     nothing: Rent +30 for the bill's line and
 *                             -30 for the credit's, both on 20 March
 *   P2 70.00 from Bank on 15 May, all to B3.
 *     accrual  Bank -70   Rent 70   (Payables 0)
 *     cash     Bank -70   Rent 30 - 30 + 70 = 70
 *   C1 edited once applied: its amount is fixed at 30.00, and its reference
 *   is given. The books do not move.
 *
 *   A bill of -30.00 to Rent on 10 March is stored as vendor credit C3 of
 *   30.00.
 *     accrual  Bank -70   Payables +30   Rent 70 - 30 = 40
 *
 * Receivables, customer c-1, in books of their own.
 *
 *   I1 200.00 to Sales, 10 March. R1 250.00 into Bank on 15 May, 200.00 of
 *   it to I1.
 *     accrual  Bank 250   Receivables 200 - 250 = -50   Sales -200
 *     cash     Bank 250   Sales -200   Unapplied income -50
 *
 *   I2 80.00 to Sales, 1 June. 50.00 of R1 applied to it, dated 1 June.
 *   Credit note N1 30.00 to Sales, 5 June, applied to I2, dated 5 June.
 *     accrual  Bank 250   Receivables -50 + 80 - 30 = 0
 *              Sales -200 - 80 + 30 = -250
 *     cash     Bank 250   Sales -200 - 50 - 30 + 30 = -250
 */
const chart = () => [
  { code: '1010', name: 'Bank', account_type: 'bank' },
  { code: '1200', name: 'Receivables', account_type: 'accounts-receivable' },
  { code: '2010', name: 'Payables', account_type: 'accounts-payable' },
  { code: '4000', name: 'Sales', account_type: 'income' },
  {
    code: '4900',
    name: 'Unapplied cash income',
    account_type: 'other-income',
    slug: 'unapplied-cash-income',
  },
  { code: '6000', name: 'Rent', account_type: 'expense' },
  { code: '6100', name: 'Repairs', account_type: 'expense' },
  {
    code: '6900',
    name: 'Unapplied cash expense',
    account_type: 'other-expense',
    slug: 'unapplied-cash-expense',
  },
];

describe('Ledger extension: credits and their application', () => {
  let app: INestApplication;
  let payables: TestWorkspace;
  let receivables: TestWorkspace;
  let ws: TestWorkspace;
  let id: Record<string, number>;
  let codeOf: Record<number, string>;
  let vendor: any;

  const http = () => request(app.getHttpServer());
  const get = (path: string, query: Record<string, unknown> = {}) =>
    http().get(path).query(query).set(ws.headers());
  const post = (path: string, body: unknown = {}) =>
    change(app, 'post', path, ws.headers(), body);
  const put = (path: string, body: unknown = {}) =>
    change(app, 'put', path, ws.headers(), body);
  const del = (path: string) => change(app, 'delete', path, ws.headers());
  const errorOf = (res: request.Response) => res.body?.errors?.[0];
  const read = async (path: string) => (await get(path).expect(200)).body.data;
  const balances = async (basis: string, to: string) =>
    Object.fromEntries(
      (await get('/ledger/accounts', { basis, to }).expect(200)).body.data
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
  const use = async (workspace: TestWorkspace) => {
    ws = workspace;
    const accounts = (await get('/ledger/accounts').expect(200)).body.data;
    id = Object.fromEntries(accounts.map((a: any) => [a.code, a.id]));
    codeOf = Object.fromEntries(accounts.map((a: any) => [a.id, a.code]));
  };

  beforeAll(async () => {
    app = await createTestApp();
    payables = await createTestWorkspace(app, { accounts: chart() });
    receivables = await createTestWorkspace(app, { accounts: chart() });
  });

  afterAll(async () => {
    await dropOrganizations(app, [
      payables.workspace.organization_id,
      receivables.workspace.organization_id,
    ]);
    await app.close();
  });

  describe('a bill payment that pays more than its bills', () => {
    let other: any;
    let b1: any;
    let b2: any;
    let p1: any;
    let applied: any;

    const bill = (vendorId: number, day: string, code: string, rate: string) =>
      post('/ledger/bills', {
        vendor_id: vendorId,
        posted_on: day,
        entries: [{ account_id: id[code], rate }],
      });

    beforeAll(async () => {
      await use(payables);
      vendor = (await post('/ledger/vendors', { external_id: 'v-1' })).body
        .data;
      other = (await post('/ledger/vendors', { external_id: 'v-2' })).body.data;
    });

    it('leaves the rest as a credit with the vendor of its bills', async () => {
      b1 = (await bill(vendor.id, '2031-03-10', '6000', '100.00').expect(201))
        .body.data;
      const res = await post('/ledger/bill-payments', {
        external_id: 'p-1',
        paid_on: '2031-05-15',
        amount: '150.00',
        account_id: id['1010'],
        allocations: [{ bill_id: b1.id, amount: '100.00' }],
      }).expect(201);
      p1 = res.body.data;

      expect(p1.unapplied).toBe('50.00');
      expect(p1.vendor_id).toBe(vendor.id);
      expect(p1.applications).toEqual([]);

      // It is listed among the payments with money left, for its vendor.
      const left = (
        await get('/ledger/bill-payments', {
          unapplied: 'true',
          vendor_id: vendor.id,
        }).expect(200)
      ).body.data;
      expect(left.map((p: any) => [p.id, p.unapplied])).toEqual([
        [p1.id, '50.00'],
      ]);
      const theirs = (
        await get('/ledger/bill-payments', {
          unapplied: 'true',
          vendor_id: other.id,
        }).expect(200)
      ).body.data;
      expect(theirs).toEqual([]);
      expect(await balances('accrual', '2031-12-31')).toEqual({
        '1010': '-150.00',
        '2010': '50.00',
        '6000': '100.00',
      });
      expect(await balances('cash', '2031-12-31')).toEqual({
        '1010': '-150.00',
        '6000': '100.00',
        '6900': '50.00',
      });
    });

    it('with no bill and no vendor named, is refused', async () => {
      const res = await post('/ledger/bill-payments', {
        paid_on: '2031-05-15',
        amount: '10.00',
        account_id: id['1010'],
      });
      expect(res.status).toBe(400);
      expect(errorOf(res).type).toBe('VENDOR_REQUIRED');
      expect(errorOf(res).payload).toEqual({ unapplied: '10.00' });
    });

    it('an application names the version of its payment', async () => {
      b2 = (await bill(vendor.id, '2031-06-01', '6100', '80.00').expect(201))
        .body.data;
      const body = { external_id: 'a-1', bill_id: b2.id, amount: '50.00' };
      const path = `/ledger/bill-payments/${p1.id}/applications`;

      const bare = await http().post(path).set(ws.headers()).send(body);
      expect(bare.status).toBe(400);
      expect(errorOf(bare).type).toBe('VERSION_REQUIRED');

      const stale = await http()
        .post(path)
        .set(ws.headers())
        .send({ ...body, version: p1.version + 7 });
      expect(stale.status).toBe(409);
      expect(errorOf(stale).type).toBe('STALE_VERSION');
      expect(errorOf(stale).payload.current.id).toBe(p1.id);
      expect(errorOf(stale).payload.current.unapplied).toBe('50.00');
    });

    it('is applied to a later bill, dated the later of the two days', async () => {
      const path = `/ledger/bill-payments/${p1.id}/applications`;
      const body = {
        external_id: 'a-1',
        bill_id: b2.id,
        amount: '50.00',
        version: p1.version,
      };
      const res = await http().post(path).set(ws.headers()).send(body);
      expect(res.status).toBe(201);
      applied = res.body.data;
      expect(applied).toMatchObject({
        external_id: 'a-1',
        bill_payment_id: p1.id,
        bill_id: b2.id,
        amount: '50.00',
        applied_on: '2031-06-01',
        deleted_at: null,
        version: 1,
      });

      const payment = await read(`/ledger/bill-payments/${p1.id}`);
      expect(payment.unapplied).toBe('0.00');
      expect(
        (await get('/ledger/bill-payments', { unapplied: 'true' }).expect(200))
          .body.data,
      ).toEqual([]);
      expect(payment.version).toBe(p1.version + 1);
      expect(payment.applications.map((a: any) => a.id)).toEqual([applied.id]);

      const second = await read(`/ledger/bills/${b2.id}`);
      expect(second.balance).toBe('30.00');
      expect(second.status).toBe('partially_paid');
      expect(second.version).toBe(b2.version + 1);
      expect(second.applications.map((a: any) => a.id)).toEqual([applied.id]);

      expect(await balances('accrual', '2031-06-30')).toEqual({
        '1010': '-150.00',
        '2010': '-30.00',
        '6000': '100.00',
        '6100': '80.00',
      });
      expect(await balances('cash', '2031-05-31')).toEqual({
        '1010': '-150.00',
        '6000': '100.00',
        '6900': '50.00',
      });
      expect(await balances('cash', '2031-06-30')).toEqual({
        '1010': '-150.00',
        '6000': '100.00',
        '6100': '50.00',
      });

      // The same id and body again is a retry, whatever the version is now.
      const again = await http().post(path).set(ws.headers()).send(body);
      expect(again.status).toBe(200);
      expect(again.body.replayed).toBe(true);
      expect(again.body.data.id).toBe(applied.id);

      const changed = await http()
        .post(path)
        .set(ws.headers())
        .send({ ...body, amount: '40.00' });
      expect(changed.status).toBe(409);
      expect(errorOf(changed).type).toBe('EXTERNAL_ID_IN_USE');
      expect(errorOf(changed).payload).toMatchObject({
        kind: 'credit_application',
        externalId: 'a-1',
        recordId: applied.id,
      });
    });

    it('refuses more than is left, another vendor, and a locked day', async () => {
      const path = `/ledger/bill-payments/${p1.id}/applications`;
      const more = await post(path, { bill_id: b2.id, amount: '0.01' });
      expect(more.status).toBe(400);
      expect(errorOf(more).type).toBe('APPLICATION_EXCEEDS_UNAPPLIED');
      expect(errorOf(more).payload).toEqual({
        amount: '0.01',
        unapplied: '0.00',
      });

      const none = await post(path, { bill_id: b2.id, amount: '0.00' });
      expect(none.status).toBe(400);
      expect(errorOf(none).type).toBe('APPLICATION_AMOUNT_NOT_POSITIVE');

      const theirs = (
        await bill(other.id, '2031-06-02', '6100', '5.00').expect(201)
      ).body.data;
      const wrong = await post(path, { bill_id: theirs.id, amount: '1.00' });
      expect(wrong.status).toBe(400);
      expect(errorOf(wrong).type).toBe('APPLICATION_OF_ANOTHER_PARTY');
      expect(errorOf(wrong).payload).toEqual({ billId: theirs.id });
      await post(`/ledger/bills/${theirs.id}/void`).expect(200);

      const missing = await post(path, { bill_id: 999999, amount: '1.00' });
      expect(missing.status).toBe(404);
      expect(errorOf(missing).type).toBe('bill_not_found');

      // Locked through 1 June: the application's own day.
      await http()
        .put('/ledger/settings')
        .set(ws.headers())
        .send({ locked_through: '2031-06-01' })
        .expect(200);
      const locked = await del(`/ledger/credit-applications/${applied.id}`);
      expect(locked.status).toBe(400);
      expect(errorOf(locked).type).toBe('TRANSACTIONS_DATE_LOCKED');
      await http()
        .put('/ledger/settings')
        .set(ws.headers())
        .send({ locked_through: null })
        .expect(200);
    });

    it('a bill with an application to it cannot be voided', async () => {
      const res = await post(`/ledger/bills/${b2.id}/void`);
      expect(res.status).toBe(400);
      expect(errorOf(res).type).toBe('BILL_HAS_PAYMENTS');
    });

    it('an application deleted gives the money back to the payment', async () => {
      const path = `/ledger/credit-applications/${applied.id}`;
      const bare = await http().delete(path).set(ws.headers());
      expect(bare.status).toBe(400);
      expect(errorOf(bare).type).toBe('VERSION_REQUIRED');

      const res = await http()
        .delete(path)
        .query({ version: applied.version })
        .set(ws.headers());
      expect(res.status).toBe(200);
      expect(res.body.data.deleted_at).not.toBeNull();
      expect(res.body.data.external_id).toBe('a-1');
      expect(res.body.data.version).toBe(applied.version + 1);

      expect((await read(`/ledger/bill-payments/${p1.id}`)).unapplied).toBe(
        '50.00',
      );
      expect((await read(`/ledger/bills/${b2.id}`)).balance).toBe('80.00');
      expect(await balances('cash', '2031-06-30')).toEqual({
        '1010': '-150.00',
        '6000': '100.00',
        '6900': '50.00',
      });

      // Deleting it again changes nothing, and its id is not used again.
      await http().delete(path).set(ws.headers()).expect(200);
      const reused = await post(`/ledger/bill-payments/${p1.id}/applications`, {
        external_id: 'a-1',
        bill_id: b2.id,
        amount: '50.00',
      });
      expect(reused.status).toBe(409);
      expect(errorOf(reused).type).toBe('EXTERNAL_ID_IN_USE');
      expect(errorOf(reused).payload.state).toBe('deleted');
    });

    it('a payment deleted takes its applications with it', async () => {
      const again = (
        await post(`/ledger/bill-payments/${p1.id}/applications`, {
          external_id: 'a-2',
          bill_id: b2.id,
          amount: '50.00',
        }).expect(201)
      ).body.data;

      await del(`/ledger/bill-payments/${p1.id}`).expect(200);

      const gone = await read(`/ledger/credit-applications/${again.id}`);
      expect(gone.deleted_at).not.toBeNull();
      expect((await read(`/ledger/bills/${b1.id}`)).balance).toBe('100.00');
      const second = await read(`/ledger/bills/${b2.id}`);
      expect(second.balance).toBe('80.00');
      expect(second.applications).toEqual([]);
      expect(await balances('accrual', '2031-12-31')).toEqual({
        '2010': '-180.00',
        '6000': '100.00',
        '6100': '80.00',
      });
      expect(await balances('cash', '2031-12-31')).toEqual({});

      await post(`/ledger/bills/${b1.id}/void`).expect(200);
      await post(`/ledger/bills/${b2.id}/void`).expect(200);
      expect(await balances('accrual', '2031-12-31')).toEqual({});
    });
  });

  describe('a vendor credit', () => {
    let b3: any;
    let c1: any;
    let c2: any;

    beforeAll(async () => {
      await use(payables);
    });

    it('debits payables and credits its lines, and is applied to a bill', async () => {
      b3 = (
        await post('/ledger/bills', {
          vendor_id: vendor.id,
          posted_on: '2031-03-10',
          entries: [{ account_id: id['6000'], rate: '100.00' }],
        }).expect(201)
      ).body.data;
      const made = await post('/ledger/vendor-credits', {
        external_id: 'c-1',
        vendor_id: vendor.id,
        posted_on: '2031-03-20',
        entries: [{ account_id: id['6000'], rate: '30.00' }],
      });
      expect(made.status).toBe(201);
      c1 = made.body.data;
      expect(c1).toMatchObject({
        kind: 'vendor_credit',
        status: 'open',
        amount: '30.00',
        unapplied: '30.00',
        applications: [],
      });
      expect(c1.balance).toBeUndefined();
      expect(c1.payments).toBeUndefined();
      expect(c1.vendor.id).toBe(vendor.id);

      const application = (
        await post(`/ledger/vendor-credits/${c1.id}/applications`, {
          external_id: 'a-3',
          bill_id: b3.id,
          amount: '30.00',
        }).expect(201)
      ).body.data;
      expect(application).toMatchObject({
        vendor_credit_id: c1.id,
        bill_id: b3.id,
        amount: '30.00',
        applied_on: '2031-03-20',
      });

      const credit = await read(`/ledger/vendor-credits/${c1.id}`);
      expect(credit.status).toBe('applied');
      expect(credit.unapplied).toBe('0.00');
      expect(credit.version).toBe(c1.version + 1);
      expect((await read(`/ledger/bills/${b3.id}`)).balance).toBe('70.00');

      expect(await balances('accrual', '2031-04-30')).toEqual({
        '2010': '-70.00',
        '6000': '70.00',
      });
      expect(await balances('cash', '2031-04-30')).toEqual({});
      expect(await rowsOf('VendorCredit', c1.id)).toEqual([
        ['2031-03-20', 'accrual', '2010', '30.00'],
        ['2031-03-20', 'accrual', '6000', '-30.00'],
        ['2031-03-20', 'cash', '6000', '-30.00'],
        ['2031-03-20', 'cash', '6000', '30.00'],
      ]);
    });

    it('leaves the bill owing the rest, which a payment settles', async () => {
      await post('/ledger/bill-payments', {
        paid_on: '2031-05-15',
        amount: '70.00',
        account_id: id['1010'],
        allocations: [{ bill_id: b3.id, amount: '70.00' }],
      }).expect(201);

      const bill = await read(`/ledger/bills/${b3.id}`);
      expect(bill.status).toBe('paid');
      expect(bill.balance).toBe('0.00');
      expect(bill.paid_on).toBe('2031-05-15');
      expect(await balances('accrual', '2031-12-31')).toEqual({
        '1010': '-70.00',
        '6000': '70.00',
      });
      expect(await balances('cash', '2031-12-31')).toEqual({
        '1010': '-70.00',
        '6000': '70.00',
      });
    });

    it('cannot be applied past what a bill owes, voided once applied, or taken below zero', async () => {
      c2 = (
        await post('/ledger/vendor-credits', {
          vendor_id: vendor.id,
          posted_on: '2031-03-25',
          entries: [{ account_id: id['6000'], rate: '50.00' }],
        }).expect(201)
      ).body.data;
      const over = await post(`/ledger/vendor-credits/${c2.id}/applications`, {
        bill_id: b3.id,
        amount: '10.00',
      });
      expect(over.status).toBe(400);
      expect(errorOf(over).type).toBe('BILL_ALLOCATION_EXCEEDS_BALANCE');
      expect(errorOf(over).payload).toEqual({
        billId: b3.id,
        allocated: '10.00',
        balance: '0.00',
      });

      const voided = await post(`/ledger/vendor-credits/${c1.id}/void`);
      expect(voided.status).toBe(400);
      expect(errorOf(voided).type).toBe('VENDOR_CREDIT_HAS_APPLICATIONS');

      const below = await put(`/ledger/vendor-credits/${c2.id}`, {
        vendor_id: vendor.id,
        posted_on: '2031-03-25',
        entries: [{ account_id: id['6000'], rate: '-50.00' }],
      });
      expect(below.status).toBe(400);
      expect(errorOf(below).type).toBe('VENDOR_CREDIT_AMOUNT_NEGATIVE');

      // An unapplied credit is voided, and leaves the books.
      const gone = await post(`/ledger/vendor-credits/${c2.id}/void`);
      expect(gone.status).toBe(200);
      expect(gone.body.data.status).toBe('voided');
      expect(gone.body.data.unapplied).toBe('0.00');
      expect(await balances('accrual', '2031-12-31')).toEqual({
        '1010': '-70.00',
        '6000': '70.00',
      });
    });

    it('once applied, refuses an edit of its amount, below what is applied or above it, and takes one of its reference', async () => {
      const before = await read(`/ledger/vendor-credits/${c1.id}`);
      const rows = [
        ['2031-03-20', 'accrual', '2010', '30.00'],
        ['2031-03-20', 'accrual', '6000', '-30.00'],
        ['2031-03-20', 'cash', '6000', '-30.00'],
        ['2031-03-20', 'cash', '6000', '30.00'],
      ];
      const edit = (rate: string, extra = {}) => ({
        vendor_id: vendor.id,
        posted_on: '2031-03-20',
        entries: [{ account_id: id['6000'], rate }],
        ...extra,
      });

      // All 30.00 of C1 is applied to B3. 20.00 would be below that, and
      // 40.00 above it: both are refused for the line's amount.
      for (const rate of ['20.00', '40.00']) {
        const res = await put(`/ledger/vendor-credits/${c1.id}`, edit(rate));
        expect(res.status).toBe(400);
        expect(errorOf(res).type).toBe('VENDOR_CREDIT_EDIT_HAS_APPLICATIONS');
        expect(errorOf(res).payload).toEqual({
          vendorCreditId: c1.id,
          paid: '30.00',
          changed: ['entries'],
        });
      }
      expect(await read(`/ledger/vendor-credits/${c1.id}`)).toEqual(before);
      expect(await rowsOf('VendorCredit', c1.id)).toEqual(rows);

      const res = await put(
        `/ledger/vendor-credits/${c1.id}`,
        edit('30.00', { reference: 'CR-1' }),
      );
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        id: c1.id,
        external_id: 'c-1',
        reference: 'CR-1',
        status: 'applied',
        amount: '30.00',
        unapplied: '0.00',
        version: before.version + 1,
      });
      expect(res.body.data.entries[0].id).toBe(c1.entries[0].id);
      expect(res.body.data.applications).toEqual(before.applications);
      // The books are as they were: B3 still settled, 70.00 of rent.
      expect(await rowsOf('VendorCredit', c1.id)).toEqual(rows);
      expect((await read(`/ledger/bills/${b3.id}`)).balance).toBe('0.00');
      expect(await balances('accrual', '2031-12-31')).toEqual({
        '1010': '-70.00',
        '6000': '70.00',
      });
      expect(await balances('cash', '2031-12-31')).toEqual({
        '1010': '-70.00',
        '6000': '70.00',
      });
    });

    it('a bill sent below zero is stored as a vendor credit', async () => {
      const body = {
        external_id: 'neg-1',
        vendor_id: vendor.id,
        posted_on: '2031-03-10',
        entries: [{ account_id: id['6000'], rate: '-30.00' }],
      };
      const res = await post('/ledger/bills', body);
      expect(res.status).toBe(201);
      const c3 = res.body.data;
      expect(c3).toMatchObject({
        kind: 'vendor_credit',
        external_id: 'neg-1',
        status: 'open',
        amount: '30.00',
        unapplied: '30.00',
      });
      expect(c3.entries[0].rate).toBe('30.00');
      expect(c3.entries[0].amount).toBe('30.00');

      expect(await balances('accrual', '2031-12-31')).toEqual({
        '1010': '-70.00',
        '2010': '30.00',
        '6000': '40.00',
      });

      // The open bills, asked for with the credits, answer what each vendor
      // has left: here the 30.00 of this credit alone. B3 is paid, C1 is
      // applied in full and C2 is voided.
      const owing = await get('/ledger/bills', {
        status: 'open,partially_paid',
        with_credits: 'true',
      }).expect(200);
      expect(owing.body.data).toEqual([]);
      expect(owing.body.credits).toEqual([
        {
          kind: 'vendor_credit',
          id: c3.id,
          on: '2031-03-10',
          unapplied: '30.00',
          vendor: expect.objectContaining({ id: vendor.id }),
        },
      ]);

      // The same body again is a retry of the same credit.
      const again = await post('/ledger/bills', body);
      expect(again.status).toBe(200);
      expect(again.body.replayed).toBe(true);
      expect(again.body.data.id).toBe(c3.id);

      // Its id is the credit's for ever: a bill above zero under it is
      // refused, and makes no bill.
      const reused = await post('/ledger/bills', {
        ...body,
        entries: [{ account_id: id['6000'], rate: '30.00' }],
      });
      expect(reused.status).toBe(409);
      expect(errorOf(reused).type).toBe('EXTERNAL_ID_IN_USE');
      expect(errorOf(reused).payload).toMatchObject({
        kind: 'vendor_credit',
        recordId: c3.id,
      });

      // It is a vendor credit and no bill.
      await get(`/ledger/bills/${c3.id}`).expect(404);
      const credits = (await get('/ledger/vendor-credits').expect(200)).body
        .data;
      expect(credits.map((c: any) => c.id)).toContain(c3.id);
      const open = (
        await get('/ledger/vendor-credits', { status: 'open' }).expect(200)
      ).body.data;
      expect(open.map((c: any) => c.id)).toEqual([c3.id]);
      const applied = (
        await get('/ledger/vendor-credits', { status: 'applied' }).expect(200)
      ).body.data;
      expect(applied.map((c: any) => c.id)).toEqual([c1.id]);
      const bills = (await get('/ledger/bills').expect(200)).body.data;
      expect(bills.map((b: any) => b.id)).not.toContain(c3.id);
    });

    it('an edit cannot take a bill below zero', async () => {
      const res = await put(`/ledger/bills/${b3.id}`, {
        vendor_id: vendor.id,
        posted_on: '2031-03-10',
        entries: [{ account_id: id['6000'], rate: '-1.00' }],
      });
      expect(res.status).toBe(400);
      expect(errorOf(res).type).toBe('BILL_AMOUNT_NEGATIVE');
    });
  });

  describe('the receivable side', () => {
    let customer: any;
    let i1: any;
    let i2: any;
    let r1: any;

    const invoice = (day: string, rate: string) =>
      post('/ledger/invoices', {
        customer_id: customer.id,
        posted_on: day,
        entries: [{ account_id: id['4000'], rate }],
      });

    beforeAll(async () => {
      await use(receivables);
      customer = (
        await post('/ledger/customers', {
          external_id: 'c-1',
          company_name: 'North Field Partners',
        })
      ).body.data;
    });

    it('an invoice payment over its invoices is a credit with the customer', async () => {
      i1 = (await invoice('2031-03-10', '200.00').expect(201)).body.data;
      r1 = (
        await post('/ledger/invoice-payments', {
          customer_id: customer.id,
          paid_on: '2031-05-15',
          amount: '250.00',
          account_id: id['1010'],
          allocations: [{ invoice_id: i1.id, amount: '200.00' }],
        }).expect(201)
      ).body.data;

      expect(r1.unapplied).toBe('50.00');
      expect(await balances('accrual', '2031-12-31')).toEqual({
        '1010': '250.00',
        '1200': '-50.00',
        '4000': '-200.00',
      });
      expect(await balances('cash', '2031-12-31')).toEqual({
        '1010': '250.00',
        '4000': '-200.00',
        '4900': '-50.00',
      });
    });

    it('is applied to a later invoice, and a credit note settles the rest', async () => {
      i2 = (await invoice('2031-06-01', '80.00').expect(201)).body.data;
      const applied = (
        await post(`/ledger/invoice-payments/${r1.id}/applications`, {
          invoice_id: i2.id,
          amount: '50.00',
        }).expect(201)
      ).body.data;
      expect(applied).toMatchObject({
        invoice_payment_id: r1.id,
        invoice_id: i2.id,
        applied_on: '2031-06-01',
      });
      expect(await balances('cash', '2031-06-01')).toEqual({
        '1010': '250.00',
        '4000': '-250.00',
      });

      const note = (
        await post('/ledger/credit-notes', {
          customer_id: customer.id,
          posted_on: '2031-06-05',
          entries: [{ account_id: id['4000'], rate: '30.00' }],
        }).expect(201)
      ).body.data;
      expect(note).toMatchObject({
        kind: 'credit_note',
        credit_note_number: 'CN-000001',
        status: 'open',
        unapplied: '30.00',
      });
      expect(note.customer.id).toBe(customer.id);
      expect(await balances('accrual', '2031-12-31')).toEqual({
        '1010': '250.00',
        '4000': '-250.00',
      });

      const settled = (
        await post(`/ledger/credit-notes/${note.id}/applications`, {
          invoice_id: i2.id,
          amount: '30.00',
        }).expect(201)
      ).body.data;
      expect(settled).toMatchObject({
        credit_note_id: note.id,
        invoice_id: i2.id,
        applied_on: '2031-06-05',
      });

      const second = await read(`/ledger/invoices/${i2.id}`);
      expect(second.status).toBe('paid');
      expect(second.balance).toBe('0.00');
      expect(second.paid_on).toBe('2031-06-05');
      expect((await read(`/ledger/credit-notes/${note.id}`)).status).toBe(
        'applied',
      );

      expect(await balances('accrual', '2031-12-31')).toEqual({
        '1010': '250.00',
        '4000': '-250.00',
      });
      expect(await balances('cash', '2031-12-31')).toEqual({
        '1010': '250.00',
        '4000': '-250.00',
      });
      expect(await rowsOf('CreditNote', note.id)).toEqual([
        ['2031-06-05', 'accrual', '1200', '-30.00'],
        ['2031-06-05', 'accrual', '4000', '30.00'],
        ['2031-06-05', 'cash', '4000', '-30.00'],
        ['2031-06-05', 'cash', '4000', '30.00'],
      ]);
    });

    it('an invoice below zero is still refused', async () => {
      const res = await invoice('2031-06-10', '-5.00');
      expect(res.status).toBe(400);
      expect(errorOf(res).type).toBe('INVOICE_AMOUNT_NEGATIVE');
    });
  });
});
