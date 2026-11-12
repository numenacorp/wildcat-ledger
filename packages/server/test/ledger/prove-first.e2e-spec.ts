import request = require('supertest');
import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { Knex } from 'knex';
import {
  createTestApp,
  createTestOrganization,
  dropTestOrganization,
  ledgerRows,
  tableRows,
  listAccounts,
  TestAccount,
  TestOrganization,
} from './harness';
import { UnitOfWork } from '../../src/modules/Tenancy/TenancyDB/UnitOfWork.service';
import { CreateManualJournalService } from '../../src/modules/ManualJournals/commands/CreateManualJournal.service';
import { CreateBill } from '../../src/modules/Bills/commands/CreateBill.service';

/**
 * Checks of the behaviour the ledger extension is built on. Each asserts a
 * figure worked out by hand from the transactions posted, on an organization
 * created for this file alone.
 */
describe('Ledger: behaviour the extension depends on', () => {
  let app: INestApplication;
  let org: TestOrganization;
  let accounts: TestAccount[];
  let vendorId: number;
  let customerId: number;
  let itemId: number;

  const http = () => request(app.getHttpServer());
  const bySlug = (slug: string) => {
    const account = accounts.find((a) => a.slug === slug);
    if (!account) throw new Error(`No seeded account with slug ${slug}`);
    return account;
  };
  const byType = (type: string) => {
    const account = accounts.find((a) => a.account_type === type);
    if (!account) throw new Error(`No seeded account of type ${type}`);
    return account;
  };

  /** Net debit balance of an account over a date range, from ledger rows. */
  const balance = async (
    accountId: number,
    basis: 'accrual' | 'cash',
    from = '0000-01-01',
    to = '9999-12-31',
  ) => {
    const rows = await ledgerRows(org, { accountId });
    return rows
      .filter((r) => r.basis === basis || r.basis === 'both' || !r.basis)
      .filter((r) => {
        const d = String(r.date).slice(0, 10);
        return d >= from && d <= to;
      })
      .reduce((sum, r) => sum + Number(r.debit) - Number(r.credit), 0);
  };

  const createBill = async (body: Record<string, unknown>) =>
    http()
      .post('/bills')
      .set(org.headers())
      .send({
        vendorId,
        billNumber: randomUUID(),
        open: true,
        ...body,
      });

  const createInvoice = async (body: Record<string, unknown>) =>
    http()
      .post('/sale-invoices')
      .set(org.headers())
      .send({
        customerId,
        invoiceNo: randomUUID(),
        delivered: true,
        ...body,
      });

  const createJournal = (body: Record<string, unknown>) =>
    http()
      .post('/manual-journals')
      .set(org.headers())
      .send({ journalNumber: randomUUID(), publish: true, ...body });

  beforeAll(async () => {
    app = await createTestApp();
    org = await createTestOrganization(app);
    accounts = await listAccounts(org);

    const vendor = await http()
      .post('/vendors')
      .set(org.headers())
      .send({ displayName: 'Prove Vendor', currencyCode: 'USD' })
      .expect(201);
    vendorId = vendor.body.id;

    const customer = await http()
      .post('/customers')
      .set(org.headers())
      .send({
        displayName: 'Prove Customer',
        customerType: 'business',
        currencyCode: 'USD',
      })
      .expect(201);
    customerId = customer.body.id;

    const item = await http()
      .post('/items')
      .set(org.headers())
      .send({
        name: 'Generic line',
        type: 'service',
        sellable: true,
        purchasable: true,
        sellAccountId: bySlug('sales-of-service-income').id,
        costAccountId: bySlug('cost-of-goods-sold').id,
        costPrice: 1,
        sellPrice: 1,
      })
      .expect(201);
    itemId = Number(item.body.id);
  });

  afterAll(async () => {
    if (org) await dropTestOrganization(org);
    if (app) await app.close();
  });

  it('check 6: an organization builds from the API', () => {
    console.log(`PROVE check 6: organization built in ${org.buildMs} ms`);
    expect(accounts.length).toBeGreaterThan(0);
  });

  describe('check 4: a line account override accepts any account type', () => {
    const types = [
      'fixed-asset',
      'other-current-liability',
      'equity',
      'income',
      'expense',
      'bank',
    ];

    it.each(types)('bill line posted to a %s account', async (type) => {
      const account = byType(type);
      const res = await createBill({
        billDate: '2031-01-10',
        entries: [
          {
            index: 1,
            itemId,
            quantity: 1,
            rate: 100,
            costAccountId: account.id,
          },
        ],
      });
      expect(res.status).toBe(201);

      const rows = await ledgerRows(org, {
        referenceType: 'Bill',
        referenceId: res.body.id,
        accountId: account.id,
      });
      const debit = rows
        .filter((r) => r.basis !== 'cash')
        .reduce((s, r) => s + Number(r.debit) - Number(r.credit), 0);
      expect(debit).toBeCloseTo(100, 2);
    });

    it.each(types)('invoice line posted to a %s account', async (type) => {
      const account = byType(type);
      const res = await createInvoice({
        invoiceDate: '2031-01-10',
        dueDate: '2031-01-10',
        entries: [
          {
            index: 1,
            itemId,
            quantity: 1,
            rate: 100,
            sellAccountId: account.id,
          },
        ],
      });
      expect(res.status).toBe(201);

      const rows = await ledgerRows(org, {
        referenceType: 'SaleInvoice',
        referenceId: res.body.id,
        accountId: account.id,
      });
      const credit = rows
        .filter((r) => r.basis !== 'cash')
        .reduce((s, r) => s + Number(r.credit) - Number(r.debit), 0);
      expect(credit).toBeCloseTo(100, 2);
    });
  });

  describe('check 2: negative lines', () => {
    it('a bill with a negative line posts the net to payables', async () => {
      const expense = bySlug('office-expenses');
      const other = bySlug('rent');
      const payable = byType('accounts-payable');

      const res = await createBill({
        billDate: '2031-02-10',
        entries: [
          {
            index: 1,
            itemId,
            quantity: 1,
            rate: 500,
            costAccountId: expense.id,
          },
          {
            index: 2,
            itemId,
            quantity: 1,
            rate: -120,
            costAccountId: other.id,
          },
        ],
      });
      expect(res.status).toBe(201);

      const rows = (
        await ledgerRows(org, {
          referenceType: 'Bill',
          referenceId: res.body.id,
        })
      ).filter((r) => r.basis !== 'cash');
      const net = (accountId: number) =>
        rows
          .filter((r) => r.accountId === accountId)
          .reduce((s, r) => s + Number(r.debit) - Number(r.credit), 0);

      // By hand: expense +500, rent -120, payables -380.
      expect(net(expense.id)).toBeCloseTo(500, 2);
      expect(net(other.id)).toBeCloseTo(-120, 2);
      expect(net(payable.id)).toBeCloseTo(-380, 2);
    });

    it('an invoice with a negative line posts the net to receivables', async () => {
      const income = bySlug('sales-of-service-income');
      const other = bySlug('other-income');
      const receivable = byType('accounts-receivable');

      const res = await createInvoice({
        invoiceDate: '2031-02-10',
        dueDate: '2031-02-10',
        entries: [
          {
            index: 1,
            itemId,
            quantity: 1,
            rate: 500,
            sellAccountId: income.id,
          },
          {
            index: 2,
            itemId,
            quantity: 1,
            rate: -120,
            sellAccountId: other.id,
          },
        ],
      });
      expect(res.status).toBe(201);

      const rows = (
        await ledgerRows(org, {
          referenceType: 'SaleInvoice',
          referenceId: res.body.id,
        })
      ).filter((r) => r.basis !== 'cash');
      const net = (accountId: number) =>
        rows
          .filter((r) => r.accountId === accountId)
          .reduce((s, r) => s + Number(r.debit) - Number(r.credit), 0);

      // By hand: income credited 500, other income debited 120, receivables +380.
      expect(net(income.id)).toBeCloseTo(-500, 2);
      expect(net(other.id)).toBeCloseTo(120, 2);
      expect(net(receivable.id)).toBeCloseTo(380, 2);
    });
  });

  describe('check 1: cash basis, against a month worked by hand', () => {
    // A bill of 1,000 dated 10 March is paid 400 on 5 April and 600 on 20 May.
    // An invoice of 900 dated 12 March is paid 300 on 8 April and 600 on 2 June.
    //
    //              accrual expense   cash expense   accrual income   cash income
    //   March           1,000              0              900              0
    //   April               0            400                0            300
    //   May                 0            600                0              0
    //   June                0              0                0            600
    let expense: TestAccount;
    let income: TestAccount;
    let bank: TestAccount;

    beforeAll(async () => {
      expense = bySlug('bank-fees-and-charges');
      income = bySlug('uncategorized-income');
      bank = bySlug('bank-account');

      const bill = await createBill({
        billDate: '2032-03-10',
        entries: [
          {
            index: 1,
            itemId,
            quantity: 1,
            rate: 1000,
            costAccountId: expense.id,
          },
        ],
      });
      expect(bill.status).toBe(201);

      for (const [paymentDate, paymentAmount] of [
        ['2032-04-05', 400],
        ['2032-05-20', 600],
      ] as const) {
        await http()
          .post('/bill-payments')
          .set(org.headers())
          .send({
            vendorId,
            paymentDate,
            paymentAccountId: bank.id,
            paymentNumber: randomUUID(),
            entries: [{ index: 1, billId: bill.body.id, paymentAmount }],
          })
          .expect(201);
      }

      const invoice = await createInvoice({
        invoiceDate: '2032-03-12',
        dueDate: '2032-03-12',
        entries: [
          {
            index: 1,
            itemId,
            quantity: 1,
            rate: 900,
            sellAccountId: income.id,
          },
        ],
      });
      expect(invoice.status).toBe(201);

      for (const [paymentDate, paymentAmount] of [
        ['2032-04-08', 300],
        ['2032-06-02', 600],
      ] as const) {
        await http()
          .post('/payments-received')
          .set(org.headers())
          .send({
            customerId,
            paymentDate,
            depositAccountId: bank.id,
            paymentReceiveNo: randomUUID(),
            entries: [{ index: 1, invoiceId: invoice.body.id, paymentAmount }],
          })
          .expect(201);
      }
    });

    const months: Array<
      [string, string, string, number, number, number, number]
    > = [
      ['March', '2032-03-01', '2032-03-31', 1000, 0, 900, 0],
      ['April', '2032-04-01', '2032-04-30', 0, 400, 0, 300],
      ['May', '2032-05-01', '2032-05-31', 0, 600, 0, 0],
      ['June', '2032-06-01', '2032-06-30', 0, 0, 0, 600],
    ];

    it.each(months)(
      '%s',
      async (
        _m,
        from,
        to,
        accrualExpense,
        cashExpense,
        accrualIncome,
        cashIncome,
      ) => {
        expect(await balance(expense.id, 'accrual', from, to)).toBeCloseTo(
          accrualExpense,
          2,
        );
        expect(await balance(expense.id, 'cash', from, to)).toBeCloseTo(
          cashExpense,
          2,
        );
        expect(-(await balance(income.id, 'accrual', from, to))).toBeCloseTo(
          accrualIncome,
          2,
        );
        expect(-(await balance(income.id, 'cash', from, to))).toBeCloseTo(
          cashIncome,
          2,
        );
      },
    );

    it('over the whole period both bases agree, and cash moved by 700 out and 900 in', async () => {
      expect(await balance(expense.id, 'cash')).toBeCloseTo(1000, 2);
      expect(-(await balance(income.id, 'cash'))).toBeCloseTo(900, 2);
      // Bank: -400 -600 +300 +600 = -100, on both bases.
      expect(
        await balance(bank.id, 'accrual', '2032-01-01', '2032-12-31'),
      ).toBeCloseTo(-100, 2);
      expect(
        await balance(bank.id, 'cash', '2032-01-01', '2032-12-31'),
      ).toBeCloseTo(-100, 2);
    });

    it('the profit and loss report gives the same cash-basis April', async () => {
      const res = await http()
        .get('/reports/profit-loss-sheet')
        .query({ fromDate: '2032-04-01', toDate: '2032-04-30', basis: 'cash' })
        .set(org.headers())
        .expect(200);

      const flat: any[] = [];
      const walk = (nodes: any[]) =>
        (nodes ?? []).forEach((n) => {
          flat.push(n);
          walk(n.children);
        });
      walk(res.body.data);
      const total = (id: number) =>
        Number(flat.find((n) => Number(n.id) === id)?.total?.amount ?? 0);

      expect(total(expense.id)).toBeCloseTo(400, 2);
      expect(total(income.id)).toBeCloseTo(300, 2);
    });
  });

  describe('check 5: the lock refuses writes in a closed period', () => {
    let journalId: number;
    const entries = () => [
      { index: 1, debit: 50, credit: 0, accountId: bySlug('rent').id },
      { index: 2, debit: 0, credit: 50, accountId: bySlug('bank-account').id },
    ];

    beforeAll(async () => {
      const created = await createJournal({
        date: '2030-06-15',
        entries: entries(),
      });
      expect(created.status).toBe(201);
      journalId = created.body.id;

      await http()
        .put('/transactions-locking/lock')
        .set(org.headers())
        .send({ module: 'all', lock_to_date: '2030-06-30', reason: 'closed' })
        .expect(200);
    });

    afterAll(async () => {
      await http()
        .put('/transactions-locking/cancel-lock')
        .set(org.headers())
        .send({ reason: 'reopen' });
    });

    const expectLocked = (res: request.Response) => {
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toContain('TRANSACTIONS_DATE_LOCKED');
    };

    it('refuses a create on the lock day', async () => {
      expectLocked(
        await createJournal({ date: '2030-06-30', entries: entries() }),
      );
    });

    it('allows a create on the day after', async () => {
      const res = await createJournal({
        date: '2030-07-01',
        entries: entries(),
      });
      expect(res.status).toBe(201);
    });

    it('refuses an edit of an entry in the closed period', async () => {
      const res = await http()
        .put(`/manual-journals/${journalId}`)
        .set(org.headers())
        .send({
          date: '2030-06-15',
          journalNumber: randomUUID(),
          entries: entries().map((e) => ({
            ...e,
            debit: e.debit ? 60 : 0,
            credit: e.credit ? 60 : 0,
          })),
        });
      expectLocked(res);
    });

    it('refuses moving an open entry into the closed period', async () => {
      const open = await createJournal({
        date: '2030-07-02',
        entries: entries(),
      });
      const res = await http()
        .put(`/manual-journals/${open.body.id}`)
        .set(org.headers())
        .send({
          date: '2030-06-20',
          journalNumber: randomUUID(),
          entries: entries(),
        });
      expectLocked(res);
    });

    it('refuses a delete in the closed period, and the entry is still there', async () => {
      expectLocked(
        await http().delete(`/manual-journals/${journalId}`).set(org.headers()),
      );
      const rows = await ledgerRows(org, {
        referenceType: 'Journal',
        referenceId: journalId,
      });
      expect(rows.length).toBe(2);
    });
  });

  describe('check 3: several services share one transaction', () => {
    it('a failure after a journal and a bill leaves neither, nor their ledger rows', async () => {
      const uow = app.get(UnitOfWork, { strict: false });
      const journals = app.get(CreateManualJournalService, { strict: false });
      const bills = app.get(CreateBill, { strict: false });

      const journalNumber = `ROLLBACK-${randomUUID()}`;
      const billNumber = `ROLLBACK-${randomUUID()}`;
      const before = (await ledgerRows(org)).length;
      const seen: { journalId?: number; billId?: number; rowsInside?: number } =
        {};

      const attempt = org.inTenant(() =>
        uow.withTransaction(async (trx: Knex.Transaction) => {
          const journal = await journals.makeJournalEntries(
            {
              date: new Date('2031-09-01'),
              journalNumber,
              publish: true,
              entries: [
                {
                  index: 1,
                  debit: 75,
                  credit: 0,
                  accountId: bySlug('rent').id,
                },
                {
                  index: 2,
                  debit: 0,
                  credit: 75,
                  accountId: bySlug('bank-account').id,
                },
              ],
            } as any,
            trx,
          );
          seen.journalId = journal.id;

          const bill = await bills.createBill(
            {
              vendorId,
              billNumber,
              billDate: new Date('2031-09-01'),
              open: true,
              entries: [
                {
                  index: 1,
                  itemId,
                  quantity: 1,
                  rate: 200,
                  costAccountId: bySlug('office-expenses').id,
                },
              ],
            } as any,
            trx,
          );
          seen.billId = bill.id;

          // Both documents and their ledger rows are visible inside the transaction.
          const inside = await trx('accounts_transactions').whereIn(
            'referenceId',
            [journal.id, bill.id],
          );
          seen.rowsInside = inside.length;

          throw new Error('forced failure after both writes');
        }),
      );
      await expect(attempt).rejects.toThrow('forced failure after both writes');

      expect(seen.journalId).toBeDefined();
      expect(seen.billId).toBeDefined();
      expect(seen.rowsInside).toBeGreaterThanOrEqual(4);

      // Nothing remains.
      expect((await ledgerRows(org)).length).toBe(before);
      expect(
        await tableRows(org, 'manual_journals', { id: seen.journalId }),
      ).toHaveLength(0);
      expect(
        await tableRows(org, 'manual_journals_entries', {
          manualJournalId: seen.journalId,
        }),
      ).toHaveLength(0);
      expect(await tableRows(org, 'bills', { id: seen.billId })).toHaveLength(
        0,
      );
      expect(
        await tableRows(org, 'items_entries', {
          referenceType: 'Bill',
          referenceId: seen.billId,
        }),
      ).toHaveLength(0);
    });
  });

  describe('check 7: a 5,000-entry journal import in one transaction', () => {
    it('posts 5,000 journals atomically', async () => {
      const uow = app.get(UnitOfWork, { strict: false });
      const journals = app.get(CreateManualJournalService, { strict: false });
      const rent = bySlug('rent').id;
      const bank = bySlug('bank-account').id;
      const count = Number(process.env.PROVE_IMPORT_COUNT ?? 5000);

      const before = await balance(rent, 'accrual', '2034-01-01', '2034-12-31');
      const startedAt = Date.now();

      await org.inTenant(() =>
        uow.withTransaction(async (trx: Knex.Transaction) => {
          for (let i = 0; i < count; i += 1) {
            await journals.makeJournalEntries(
              {
                date: new Date('2034-01-15'),
                journalNumber: `IMPORT-${i}-${randomUUID()}`,
                publish: true,
                entries: [
                  { index: 1, debit: 1, credit: 0, accountId: rent },
                  { index: 2, debit: 0, credit: 1, accountId: bank },
                ],
              } as any,
              trx,
            );
          }
        }),
      );

      console.log(
        `PROVE check 7: ${count} journals in ${Date.now() - startedAt} ms`,
      );

      const after = await balance(rent, 'accrual', '2034-01-01', '2034-12-31');
      expect(after - before).toBeCloseTo(count, 2);
    }, 1_800_000);
  });
});
