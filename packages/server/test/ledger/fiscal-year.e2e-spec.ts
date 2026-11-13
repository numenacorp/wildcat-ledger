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
 * The fiscal year, and what income and expense accounts held before it: the
 * figure a balance sheet moves into retained earnings. Nothing is posted at
 * a year end.
 *
 * Worked by hand, as debits less credits:
 *
 *   An invoice of 500.00 to Sales on 1 June 2030, unpaid.
 *   A bill of 100.00 to Rent on 10 November 2030, unpaid.
 *   A bill of 40.00 to Rent on 1 February 2031, unpaid.
 *
 * Through 31 March 2031 the balances are Sales -500.00 and Rent 140.00,
 * whatever the fiscal year. What was earned before the fiscal year 31 March
 * 2031 falls in:
 *
 *   first month   the year began   Sales before   Rent before
 *   January       1 Jan 2031       -500.00        100.00
 *   November      1 Nov 2030       -500.00          0.00   (10 Nov is in it)
 *   July          1 Jul 2030       -500.00          0.00
 *   June          1 Jun 2030          0.00          0.00   (1 Jun is in it)
 *   March         1 Mar 2031       -500.00        140.00
 *
 * So with the year from January a balance sheet of that day shows retained
 * earnings of 500.00 - 100.00 = 400.00 and a net loss of 40.00.
 */
const chart = () => [
  { code: '1200', name: 'Receivables', account_type: 'accounts-receivable' },
  { code: '2010', name: 'Payables', account_type: 'accounts-payable' },
  { code: '4000', name: 'Sales', account_type: 'income' },
  { code: '6000', name: 'Rent', account_type: 'expense' },
];

describe('Ledger extension: the fiscal year', () => {
  let app: INestApplication;
  let ws: TestWorkspace;
  let july: TestWorkspace;

  const http = () => request(app.getHttpServer());
  const post = (path: string, body: unknown) =>
    change(app, 'post', path, ws.headers(), body);
  const accounts = async (query: Record<string, unknown>) =>
    Object.fromEntries(
      (
        await http().get('/ledger/accounts').query(query).set(ws.headers())
      ).body.data.map((a: any) => [a.code, a]),
    );
  const before = async (to: string) => {
    const by = await accounts({ to });
    return [
      by['4000'].balance,
      by['4000'].prior_years_balance,
      by['6000'].balance,
      by['6000'].prior_years_balance,
    ];
  };
  const startIn = (month: number) =>
    http()
      .put(`/ledger/workspaces/${ws.workspace.id}`)
      .set(ws.user.headers())
      .send({ fiscal_year_start_month: month });

  beforeAll(async () => {
    app = await createTestApp();
    ws = await createTestWorkspace(app, { accounts: chart() });
    july = await createTestWorkspace(app, {
      accounts: chart(),
      fiscal_year_start_month: 7,
    });
    const id = Object.fromEntries(
      Object.values(await accounts({})).map((a: any) => [a.code, a.id]),
    );
    const customer = (await post('/ledger/customers', { external_id: 'c-1' }))
      .body.data;
    await post('/ledger/invoices', {
      customer_id: customer.id,
      posted_on: '2030-06-01',
      entries: [{ account_id: id['4000'], rate: '500.00' }],
    }).expect(201);
    for (const [day, rate] of [
      ['2030-11-10', '100.00'],
      ['2031-02-01', '40.00'],
    ]) {
      await post('/ledger/bills', {
        vendor_external_id: 'v-1',
        posted_on: day,
        entries: [{ account_id: id['6000'], rate }],
      }).expect(201);
    }
  });

  afterAll(async () => {
    await dropOrganizations(app, [
      ws.workspace.organization_id,
      july.workspace.organization_id,
    ]);
    await app.close();
  });

  it('starts in January unless the workspace says otherwise', () => {
    expect(ws.workspace.fiscal_year_start_month).toBe(1);
    expect(july.workspace.fiscal_year_start_month).toBe(7);
  });

  it('answers what income and expenses held before the fiscal year of the last day asked for', async () => {
    expect(await before('2031-03-31')).toEqual([
      '-500.00',
      '-500.00',
      '140.00',
      '100.00',
    ]);
    // The last day of the year before: all of it is that year's own.
    expect(await before('2030-12-31')).toEqual([
      '-500.00',
      '0.00',
      '100.00',
      '0.00',
    ]);
  });

  it('answers it on income and expense accounts alone, and only with a last day', async () => {
    const by = await accounts({ to: '2031-03-31' });
    expect(by['1200'].balance).toBe('500.00');
    expect(by['1200'].prior_years_balance).toBeUndefined();
    expect(by['2010'].prior_years_balance).toBeUndefined();
    expect((await accounts({}))['4000'].prior_years_balance).toBeUndefined();
  });

  it('follows the first month when it is changed, with nothing posted', async () => {
    const cases: Array<[number, string, string]> = [
      [11, '-500.00', '0.00'],
      [7, '-500.00', '0.00'],
      [6, '0.00', '0.00'],
      [3, '-500.00', '140.00'],
      [1, '-500.00', '100.00'],
    ];
    const rows = (await ws.rows('accounts_transactions')).length;

    for (const [month, sales, rent] of cases) {
      const res = await startIn(month).expect(200);
      expect(res.body.data.fiscal_year_start_month).toBe(month);
      expect(await before('2031-03-31')).toEqual([
        '-500.00',
        sales,
        '140.00',
        rent,
      ]);
    }
    expect((await ws.rows('accounts_transactions')).length).toBe(rows);
  });

  it('refuses a month that is not one', async () => {
    for (const month of [0, 13, 1.5, 'july']) {
      expect((await startIn(month as number)).status).toBe(400);
    }
  });
});
