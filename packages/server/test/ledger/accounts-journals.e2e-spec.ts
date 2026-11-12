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
 * Accounts, manual journals, balances, the ledger feed and the lock, on a
 * workspace in America/Chicago. Noon there is 18:00 UTC in winter.
 *
 * The books, worked by hand:
 *
 *   J1  15 Jan         Dr 1010 Operating 1,000.00   Cr 3000 Equity 1,000.00
 *   J2  20 Jan         Dr 6000 Rent 250.10, Dr 6100 Supplies 49.90
 *                                                   Cr 1010 Operating 300.00
 *   J3  31 Jan 23:59:59 Central (05:59:59 UTC on 1 Feb)
 *                      Dr 1020 Petty Cash 50.00     Cr 1010 Operating 50.00
 *   J4  1 Feb 00:00 Central (06:00 UTC)
 *                      Dr 1200 Receivables 400.00   Cr 4000 Sales 400.00
 *
 *   To date:   1010 650.00   1020 50.00   1000 (their parent) 700.00
 *              1200 400.00   3000 -1,000.00   4000 -400.00
 *              6000 250.10   6100 49.90
 *   January:   the same without J4.
 */
const chart = () => [
  { code: '1000', name: 'Cash and Bank', account_type: 'cash' },
  {
    code: '1010',
    name: 'Operating',
    account_type: 'bank',
    parent_code: '1000',
  },
  {
    code: '1020',
    name: 'Petty Cash',
    account_type: 'cash',
    parent_code: '1000',
  },
  { code: '1200', name: 'Receivables', account_type: 'accounts-receivable' },
  { code: '2010', name: 'Payables', account_type: 'accounts-payable' },
  { code: '3000', name: 'Equity', account_type: 'equity' },
  { code: '4000', name: 'Sales', account_type: 'income' },
  {
    code: '6000',
    name: 'Rent',
    account_type: 'expense',
    metadata: { a: 1, b: 1, camelKey: true },
  },
  { code: '6100', name: 'Supplies', account_type: 'expense' },
];

const JAN_START = '2031-01-01T06:00:00.000Z';
const FEB_START = '2031-02-01T06:00:00.000Z';

describe('Ledger extension: accounts, manual journals, balances and the lock', () => {
  let app: INestApplication;
  let ws: TestWorkspace;
  let other: TestWorkspace;
  let id: Record<string, number>;
  const journals: Record<string, any> = {};

  const http = () => request(app.getHttpServer());
  const get = (path: string, query: Record<string, unknown> = {}) =>
    http().get(path).query(query).set(ws.headers());
  const post = (path: string, body: unknown) =>
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

  const line = (code: string, debit: string, credit: string, extra = {}) => ({
    account_id: id[code],
    debit,
    credit,
    ...extra,
  });
  const journal = (postedAt: string, entries: unknown[], extra = {}) => ({
    external_id: `j:${randomUUID()}`,
    posted_at: postedAt,
    entries,
    ...extra,
  });
  const accounts = async (query: Record<string, unknown> = {}) => {
    const res = await get('/ledger/accounts', query).expect(200);
    return res.body.data as any[];
  };
  const balances = async (query: Record<string, unknown> = {}) =>
    Object.fromEntries(
      (await accounts(query))
        .filter((a) => a.code)
        .map((a) => [a.code, a.balance]),
    );
  const errorType = (res: request.Response) => res.body?.errors?.[0]?.type;

  beforeAll(async () => {
    app = await createTestApp();
    ws = await createTestWorkspace(app, { accounts: chart() });
    other = await createTestWorkspace(app, { accounts: chart() });

    id = Object.fromEntries((await accounts()).map((a) => [a.code, a.id]));

    const create = async (key: string, body: unknown) => {
      const res = await post('/ledger/manual-journals', body);
      expect(res.status).toBe(201);
      journals[key] = res.body.data;
    };
    await create(
      'J1',
      journal(
        '2031-01-15T18:00:00Z',
        [line('1010', '1000.00', '0'), line('3000', '0', '1000.00')],
        {
          description: 'Owner funds the business',
          reference: 'REF-1',
          created_by: 'user-7',
          metadata: { sourceDoc: 'A-1', nested: { camelKey: 1, snake_key: 2 } },
        },
      ),
    );
    await create(
      'J2',
      journal('2031-01-20T18:00:00Z', [
        line('6000', '250.10', '0', {
          note: 'January rent',
          external_id: 'line-rent',
          tracking: [{ category: 'Location', option: 'North' }],
        }),
        line('6100', '49.90', '0', {
          tracking: [
            { category: 'Location', option: 'South' },
            { category: 'Project', option: 'Alpha' },
          ],
        }),
        line('1010', '0', '300.00'),
      ]),
    );
    await create(
      'J3',
      journal('2031-02-01T05:59:59Z', [
        line('1020', '50.00', '0'),
        line('1010', '0', '50.00'),
      ]),
    );
    await create(
      'J4',
      journal('2031-02-01T06:00:00Z', [
        line('1200', '400.00', '0'),
        line('4000', '0', '400.00'),
      ]),
    );
  });

  afterAll(async () => {
    await dropOrganizations(
      app,
      [ws, other].filter(Boolean).map((w) => w.workspace.organization_id),
    );
    await app.close();
  });

  describe('the chart', () => {
    it('lists the accounts sent, in code order, and nothing else', async () => {
      const list = await accounts();
      expect(list.map((a) => a.code)).toEqual([
        '1000',
        '1010',
        '1020',
        '1200',
        '2010',
        '3000',
        '4000',
        '6000',
        '6100',
      ]);
    });

    it('gives each account as the caller named it', async () => {
      const list = await accounts();
      const rent = list.find((a) => a.code === '6000');
      const operating = list.find((a) => a.code === '1010');

      expect(rent).toEqual({
        id: id['6000'],
        code: '6000',
        name: 'Rent',
        account_type: 'expense',
        parent_id: null,
        external_id: null,
        metadata: { a: 1, b: 1, camelKey: true },
        deletable: false,
        balance: '250.10',
        own_balance: '250.10',
      });
      expect(operating.parent_id).toBe(id['1000']);
      expect(operating.account_type).toBe('bank');
    });
  });

  describe('balances', () => {
    it('to date', async () => {
      expect(await balances()).toEqual({
        '1000': '700.00',
        '1010': '650.00',
        '1020': '50.00',
        '1200': '400.00',
        '2010': '0.00',
        '3000': '-1000.00',
        '4000': '-400.00',
        '6000': '250.10',
        '6100': '49.90',
      });
    });

    it('a parent carries its children, and keeps its own separately', async () => {
      const parent = (await accounts()).find((a) => a.code === '1000');
      expect(parent.balance).toBe('700.00');
      expect(parent.own_balance).toBe('0.00');
    });

    it('for January: the last second of 31 January is in, midnight is out', async () => {
      expect(await balances({ from: JAN_START, to: FEB_START })).toEqual({
        '1000': '700.00',
        '1010': '650.00',
        '1020': '50.00',
        '1200': '0.00',
        '2010': '0.00',
        '3000': '-1000.00',
        '4000': '0.00',
        '6000': '250.10',
        '6100': '49.90',
      });
    });

    it('from 1 February: only the journal at midnight', async () => {
      const feb = await balances({ from: FEB_START });
      expect(feb['1200']).toBe('400.00');
      expect(feb['4000']).toBe('-400.00');
      expect(feb['1010']).toBe('0.00');
      expect(feb['1020']).toBe('0.00');
    });

    it('carries an opening balance when a start is sent: everything before it', async () => {
      const opening = async (query: Record<string, unknown>) =>
        Object.fromEntries(
          (await accounts(query))
            .filter((a) => a.code)
            .map((a) => [a.code, [a.opening_balance, a.own_opening_balance]]),
        );
      // Before 1 February: J1, J2 and J3.
      //   1010: 1,000.00 - 300.00 - 50.00    1020: 50.00    1000: their sum
      expect(await opening({ from: FEB_START })).toEqual({
        '1000': ['700.00', '0.00'],
        '1010': ['650.00', '650.00'],
        '1020': ['50.00', '50.00'],
        '1200': ['0.00', '0.00'],
        '2010': ['0.00', '0.00'],
        '3000': ['-1000.00', '-1000.00'],
        '4000': ['0.00', '0.00'],
        '6000': ['250.10', '250.10'],
        '6100': ['49.90', '49.90'],
      });
      // Opening and the range's own change make the balance to date.
      const feb = (await accounts({ from: FEB_START })).find(
        (a) => a.code === '1200',
      );
      expect([feb.opening_balance, feb.balance]).toEqual(['0.00', '400.00']);

      // From J2's own instant: J2 is in the range, so only J1 is before it.
      const fromJ2 = (
        await accounts({ from: '2031-01-20T18:00:00Z', to: FEB_START })
      ).find((a) => a.code === '1010');
      expect([fromJ2.opening_balance, fromJ2.balance]).toEqual([
        '1000.00',
        '-350.00',
      ]);

      // Nothing is before the first of January.
      const jan = await opening({ from: JAN_START });
      expect(Object.values(jan).every((b) => b[0] === '0.00')).toBe(true);
    });

    it('carries no opening balance when no start is sent', async () => {
      const [first] = await accounts({ to: FEB_START });
      expect(first).not.toHaveProperty('opening_balance');
      expect(first).not.toHaveProperty('own_opening_balance');
    });

    it('agree on both bases, since journals count on both', async () => {
      expect(await balances({ basis: 'cash' })).toEqual(
        await balances({ basis: 'accrual' }),
      );
    });

    it('the trial balance nets to zero', async () => {
      const total = (await accounts()).reduce(
        (sum, a) => sum + Math.round(Number(a.own_balance) * 1000),
        0,
      );
      expect(total).toBe(0);
    });

    it('refuses a range that is not a timestamp, and an unknown query field', async () => {
      await get('/ledger/accounts', { from: 'January' }).expect(400);
      await get('/ledger/accounts', { start_date: JAN_START }).expect(400);
    });
  });

  describe('a manual journal', () => {
    it('is answered whole, with its instant, number and stable line ids', () => {
      const j2 = journals.J2;
      expect(j2).toEqual({
        id: expect.any(Number),
        external_id: expect.stringMatching(/^j:/),
        journal_number: 'JE-000002',
        posted_at: '2031-01-20T18:00:00.000Z',
        description: null,
        reference: null,
        created_by: null,
        metadata: null,
        entries: [
          {
            id: expect.any(Number),
            external_id: 'line-rent',
            account_id: id['6000'],
            account: { id: id['6000'], code: '6000', name: 'Rent' },
            debit: '250.10',
            credit: '0.00',
            note: 'January rent',
            tracking: [
              {
                id: expect.any(Number),
                category: 'Location',
                option: 'North',
                option_name: 'North',
              },
            ],
          },
          {
            id: expect.any(Number),
            external_id: null,
            account_id: id['6100'],
            account: { id: id['6100'], code: '6100', name: 'Supplies' },
            debit: '49.90',
            credit: '0.00',
            note: null,
            tracking: [
              {
                id: expect.any(Number),
                category: 'Location',
                option: 'South',
                option_name: 'South',
              },
              {
                id: expect.any(Number),
                category: 'Project',
                option: 'Alpha',
                option_name: 'Alpha',
              },
            ],
          },
          {
            id: expect.any(Number),
            external_id: null,
            account_id: id['1010'],
            account: { id: id['1010'], code: '1010', name: 'Operating' },
            debit: '0.00',
            credit: '300.00',
            note: null,
            tracking: [],
          },
        ],
      });
    });

    it('keeps description, reference, creator and metadata keys as sent', () => {
      expect(journals.J1).toMatchObject({
        description: 'Owner funds the business',
        reference: 'REF-1',
        created_by: 'user-7',
        metadata: { sourceDoc: 'A-1', nested: { camelKey: 1, snake_key: 2 } },
      });
    });

    it('is dated in Bigcapital on its Central day', async () => {
      const rows = await ws.rows('manual_journals');
      const dayOf = (key: string) =>
        String(rows.find((r) => r.id === journals[key].id).date).slice(0, 10);

      expect(dayOf('J3')).toBe('2031-01-31');
      expect(dayOf('J4')).toBe('2031-02-01');
    });

    it('puts the placeholder customer on a receivable line that names no one', async () => {
      const settings = Object.fromEntries(
        (await ws.rows('ext_settings')).map((s) => [
          s.key,
          JSON.parse(s.value),
        ]),
      );
      const [row] = await ws.rows('accounts_transactions', {
        referenceType: 'Journal',
        referenceId: journals.J4.id,
        accountId: id['1200'],
      });
      expect(row.contactId).toBe(settings.placeholder_customer_id);
    });

    it('is read back and listed, oldest first', async () => {
      const read = await get(
        `/ledger/manual-journals/${journals.J2.id}`,
      ).expect(200);
      expect(read.body.data).toEqual(journals.J2);

      const list = await get('/ledger/manual-journals').expect(200);
      expect(list.body.data.map((j: any) => j.id)).toEqual(
        ['J1', 'J2', 'J3', 'J4'].map((k) => journals[k].id),
      );
      expect(list.body.pagination).toEqual({
        total: 4,
        page: 1,
        page_size: 50,
      });
    });

    it('is listed by a range that includes both of its ends', async () => {
      const list = await get('/ledger/manual-journals', {
        from: '2031-01-20T18:00:00Z',
        to: '2031-02-01T05:59:59Z',
      }).expect(200);
      expect(list.body.data.map((j: any) => j.id)).toEqual([
        journals.J2.id,
        journals.J3.id,
      ]);
    });

    it('is listed by external id, and pages', async () => {
      const byId = await get('/ledger/manual-journals', {
        external_ids: `${journals.J1.external_id},${journals.J4.external_id},nope`,
      }).expect(200);
      expect(byId.body.data.map((j: any) => j.id)).toEqual([
        journals.J1.id,
        journals.J4.id,
      ]);

      const second = await get('/ledger/manual-journals', {
        page: 2,
        page_size: 3,
      }).expect(200);
      expect(second.body.data.map((j: any) => j.id)).toEqual([journals.J4.id]);
      expect(second.body.pagination).toEqual({
        total: 4,
        page: 2,
        page_size: 3,
      });
    });

    it('a repeat of its external id replaces it with the new body, under the same id', async () => {
      // First: Dr 6000 9.00 / Cr 1010 9.00. Rent is then 250.10 + 9.00.
      const body = journal(
        '2031-01-25T18:00:00Z',
        [line('6000', '9.00', '0'), line('1010', '0', '9.00')],
        { description: 'first' },
      );
      const first = await post('/ledger/manual-journals', body);
      expect(first.status).toBe(201);
      expect((await balances())['6000']).toBe('259.10');

      // The same body again changes nothing.
      const same = await post('/ledger/manual-journals', body);
      expect(same.status).toBe(200);
      expect(same.body.data).toEqual(first.body.data);

      // Another body: Dr 6100 4.00, Dr 6000 1.50 / Cr 1010 5.50, a day later.
      const replaced = await post(
        '/ledger/manual-journals',
        journal(
          '2031-01-26T18:00:00Z',
          [
            line('6100', '4.00', '0'),
            line('6000', '1.50', '0'),
            line('1010', '0', '5.50'),
          ],
          { external_id: body.external_id, description: 'second' },
        ),
      );
      expect(replaced.status).toBe(200);
      expect(replaced.body.data).toMatchObject({
        id: first.body.data.id,
        external_id: body.external_id,
        journal_number: first.body.data.journal_number,
        posted_at: '2031-01-26T18:00:00.000Z',
        description: 'second',
      });
      expect(
        replaced.body.data.entries.map((e: any) => [
          e.account.code,
          e.debit,
          e.credit,
        ]),
      ).toEqual([
        ['6100', '4.00', '0.00'],
        ['6000', '1.50', '0.00'],
        ['1010', '0.00', '5.50'],
      ]);
      // 250.10 + 1.50, 49.90 + 4.00, 650.00 - 5.50.
      const after = await balances();
      expect(after['6000']).toBe('251.60');
      expect(after['6100']).toBe('53.90');
      expect(after['1010']).toBe('644.50');
      expect(
        await ws.rows('accounts_transactions', {
          referenceType: 'Journal',
          referenceId: first.body.data.id,
        }),
      ).toHaveLength(3);
      expect(
        await ws.rows('ext_external_ids', { externalId: body.external_id }),
      ).toHaveLength(1);

      await del(`/ledger/manual-journals/${first.body.data.id}`).expect(200);
    });

    it('takes a display name for a tag when its option is new, and keeps it', async () => {
      const tagged = (optionName: string) =>
        journal('2031-01-28T18:00:00Z', [
          line('6000', '1.00', '0', {
            tracking: [
              { category: 'Site', option: 'north', option_name: optionName },
            ],
          }),
          line('1010', '0', '1.00'),
        ]);
      const first = await post('/ledger/manual-journals', tagged('North Yard'));
      expect(first.status).toBe(201);
      expect(first.body.data.entries[0].tracking).toEqual([
        {
          id: expect.any(Number),
          category: 'Site',
          option: 'north',
          option_name: 'North Yard',
        },
      ]);
      // The option exists now: another name for it is not taken.
      const second = await post('/ledger/manual-journals', tagged('Elsewhere'));
      expect(second.body.data.entries[0].tracking).toEqual([
        {
          id: expect.any(Number),
          category: 'Site',
          option: 'north',
          option_name: 'North Yard',
        },
      ]);
      const lines = await get(`/ledger/accounts/${id['6000']}/lines`);
      expect(lines.body.data[0].tracking).toEqual([
        { category: 'Site', option: 'north', option_name: 'North Yard' },
      ]);

      await del(`/ledger/manual-journals/${first.body.data.id}`).expect(200);
      await del(`/ledger/manual-journals/${second.body.data.id}`).expect(200);
    });

    it('accepts a journal of zero amounts, which moves no balance', async () => {
      const before = await balances();
      const res = await post(
        '/ledger/manual-journals',
        journal('2031-01-27T18:00:00Z', [
          line('6000', '0', '0'),
          line('1010', '0.00', '0.00'),
        ]),
      );
      expect(res.status).toBe(201);
      expect(
        res.body.data.entries.map((e: any) => [e.debit, e.credit]),
      ).toEqual([
        ['0.00', '0.00'],
        ['0.00', '0.00'],
      ]);
      expect(await balances()).toEqual(before);

      await del(`/ledger/manual-journals/${res.body.data.id}`).expect(200);
    });

    it('eight simultaneous creates of one external id make one journal', async () => {
      const body = journal('2031-04-01T17:00:00Z', [
        line('6000', '1.00', '0'),
        line('1010', '0', '1.00'),
      ]);
      const results = await Promise.all(
        Array.from({ length: 8 }, () => post('/ledger/manual-journals', body)),
      );
      expect(results.map((r) => r.status).sort()).toEqual([
        200, 200, 200, 200, 200, 200, 200, 201,
      ]);
      const journalId = results[0].body.data.id;
      expect(new Set(results.map((r) => r.body.data.id)).size).toBe(1);
      expect(
        await ws.rows('accounts_transactions', {
          referenceType: 'Journal',
          referenceId: journalId,
        }),
      ).toHaveLength(2);

      await del(`/ledger/manual-journals/${journalId}`).expect(200);
    });
  });

  describe('refused journals', () => {
    const refused = async (body: unknown, type?: string) => {
      const before = (await ws.rows('manual_journals')).length;
      const res = await post('/ledger/manual-journals', body);
      expect(res.status).toBe(type === 'account_not_found' ? 404 : 400);
      if (type) expect(errorType(res)).toBe(type);
      expect(await ws.rows('manual_journals')).toHaveLength(before);
      return res;
    };

    it('debits that differ from credits, with both totals in the message', async () => {
      const res = await refused(
        journal('2031-03-01T18:00:00Z', [
          line('6000', '100.00', '0'),
          line('1010', '0', '99.99'),
        ]),
        'credit_debit_not_equal',
      );
      expect(res.body.errors[0].message).toBe(
        'Credits (99.99) and debits (100.00) must balance.',
      );
    });

    it('a difference of a thousandth, which rounding to cents would hide', async () => {
      await refused(
        journal('2031-03-01T18:00:00Z', [
          line('6000', '100.001', '0'),
          line('1010', '0', '100.00'),
        ]),
        'credit_debit_not_equal',
      );
    });

    it('a line that is both a debit and a credit', async () => {
      await refused(
        journal('2031-03-01T18:00:00Z', [
          line('6000', '5.00', '5.00'),
          line('1010', '0', '0'),
        ]),
        'credit_debit_not_equal',
      );
    });

    it('an account that does not exist, and one outside the presented chart', async () => {
      await refused(
        journal('2031-03-01T18:00:00Z', [
          { account_id: 99999999, debit: '1.00', credit: '0' },
          line('1010', '0', '1.00'),
        ]),
        'account_not_found',
      );
      const [hidden] = await ws.rows('accounts', { slug: 'office-expenses' });
      await refused(
        journal('2031-03-01T18:00:00Z', [
          { account_id: hidden.id, debit: '1.00', credit: '0' },
          line('1010', '0', '1.00'),
        ]),
        'account_not_found',
      );
    });

    it('malformed amounts, one line, an unknown field', async () => {
      const good = [line('6000', '1.00', '0'), line('1010', '0', '1.00')];
      const at = '2031-03-01T18:00:00Z';

      await refused(journal(at, [line('6000', '1.2345', '0'), good[1]]));
      await refused(journal(at, [line('6000', '-1.00', '0'), good[1]]));
      await refused(journal(at, [{ ...good[0], debit: 1 }, good[1]]));
      await refused(journal(at, [good[0]]));
      await refused(journal(at, good, { memo: 'x' }));
      await refused(journal(at, [{ ...good[0], direction: 'DEBIT' }, good[1]]));
      await refused(journal('March 1', good));
    });
  });

  describe('editing a journal', () => {
    let original: any;
    let edited: any;

    beforeAll(async () => {
      const created = await post(
        '/ledger/manual-journals',
        journal('2031-05-10T17:00:00Z', [
          line('6000', '10.00', '0'),
          line('6100', '20.00', '0'),
          line('1010', '0', '30.00'),
        ]),
      );
      original = created.body.data;

      const res = await put(`/ledger/manual-journals/${original.id}`, {
        external_id: `${original.external_id}:moved`,
        posted_at: '2031-05-11T17:00:00Z',
        description: 'Edited',
        entries: [
          line('6000', '15.00', '0'),
          line('6100', '20.00', '0'),
          line('1020', '5.00', '0'),
          line('1010', '0', '40.00'),
        ],
      });
      expect(res.status).toBe(200);
      edited = res.body.data;
    });

    afterAll(async () => {
      await del(`/ledger/manual-journals/${original.id}`).expect(200);
    });

    it('keeps the id and number, and takes the new instant and lines', () => {
      expect(edited.id).toBe(original.id);
      expect(edited.journal_number).toBe(original.journal_number);
      expect(edited.posted_at).toBe('2031-05-11T17:00:00.000Z');
      expect(edited.description).toBe('Edited');
      expect(
        edited.entries.map((e: any) => [e.account.code, e.debit, e.credit]),
      ).toEqual([
        ['6000', '15.00', '0.00'],
        ['6100', '20.00', '0.00'],
        ['1020', '5.00', '0.00'],
        ['1010', '0.00', '40.00'],
      ]);
    });

    it('keeps the id of each line whose position is unchanged', () => {
      expect(edited.entries.slice(0, 3).map((e: any) => e.id)).toEqual(
        original.entries.map((e: any) => e.id),
      );
      expect(original.entries.map((e: any) => e.id)).not.toContain(
        edited.entries[3].id,
      );
    });

    it('rewrites the ledger rows to the new amounts', async () => {
      const rows = await ws.rows('accounts_transactions', {
        referenceType: 'Journal',
        referenceId: original.id,
      });
      const net = (code: string) =>
        rows
          .filter((r) => r.accountId === id[code])
          .reduce((s, r) => s + Number(r.debit) - Number(r.credit), 0);

      expect(rows).toHaveLength(4);
      expect(net('6000')).toBeCloseTo(15, 3);
      expect(net('1020')).toBeCloseTo(5, 3);
      expect(net('1010')).toBeCloseTo(-40, 3);
    });

    it('moves the external id, and frees the old one', async () => {
      expect(edited.external_id).toBe(`${original.external_id}:moved`);

      const reuse = await post(
        '/ledger/manual-journals',
        journal(
          '2031-05-12T17:00:00Z',
          [line('6000', '1.00', '0'), line('1010', '0', '1.00')],
          { external_id: original.external_id },
        ),
      );
      expect(reuse.status).toBe(201);
      expect(reuse.body.data.id).not.toBe(original.id);
      await del(`/ledger/manual-journals/${reuse.body.data.id}`).expect(200);
    });

    it('refuses an edit that does not balance, and changes nothing', async () => {
      const res = await put(`/ledger/manual-journals/${original.id}`, {
        posted_at: '2031-05-11T17:00:00Z',
        entries: [line('6000', '1.00', '0'), line('1010', '0', '2.00')],
      });
      expect(res.status).toBe(400);

      const read = await get(`/ledger/manual-journals/${original.id}`).expect(
        200,
      );
      expect(read.body.data).toEqual(edited);
    });

    it('answers an edit of a journal that does not exist as not found', async () => {
      const res = await put('/ledger/manual-journals/99999999', {
        posted_at: '2031-05-11T17:00:00Z',
        entries: [line('6000', '1.00', '0'), line('1010', '0', '1.00')],
      });
      expect(res.status).toBe(404);
      expect(errorType(res)).toBe('manual_journal_not_found');
    });
  });

  describe('deleting a journal', () => {
    it('removes it, its ledger rows and its companion rows; its external id brings it back under the same id', async () => {
      const before = await balances();
      const body = journal(
        '2031-06-01T17:00:00Z',
        [
          line('6000', '77.00', '0', { external_id: 'gone-line' }),
          line('1010', '0', '77.00'),
        ],
        { metadata: { k: 1 } },
      );
      const created = (await post('/ledger/manual-journals', body)).body.data;
      expect((await balances())['6000']).toBe('327.10');

      await del(`/ledger/manual-journals/${created.id}`).expect(200);

      expect(await balances()).toEqual(before);
      const read = await get(`/ledger/manual-journals/${created.id}`);
      expect(read.status).toBe(404);
      expect(errorType(read)).toBe('manual_journal_not_found');
      expect(
        await ws.rows('accounts_transactions', {
          referenceType: 'Journal',
          referenceId: created.id,
        }),
      ).toHaveLength(0);
      expect(
        await ws.rows('ext_lines', {
          kind: 'manual_journal_entry',
          recordId: created.id,
        }),
      ).toHaveLength(0);
      expect(
        await ws.rows('ext_documents', {
          kind: 'manual_journal',
          recordId: created.id,
        }),
      ).toHaveLength(0);
      expect(
        await ws.rows('ext_metadata', {
          kind: 'manual_journal',
          recordId: created.id,
        }),
      ).toHaveLength(0);

      // Deleting again is not found, and it is on no list.
      expect((await del(`/ledger/manual-journals/${created.id}`)).status).toBe(
        404,
      );
      const listed = await get('/ledger/manual-journals', {
        external_ids: body.external_id,
      });
      expect(listed.body.data).toHaveLength(0);

      // Its external id brings it back under the same id, with the new body:
      // Dr 6100 5.00 / Cr 1010 5.00.
      const again = await post(
        '/ledger/manual-journals',
        journal(
          '2031-06-02T17:00:00Z',
          [line('6100', '5.00', '0'), line('1010', '0', '5.00')],
          { external_id: body.external_id },
        ),
      );
      expect(again.status).toBe(200);
      expect(again.body.data.id).toBe(created.id);
      expect(again.body.data.external_id).toBe(body.external_id);
      expect(again.body.data.journal_number).not.toBe(created.journal_number);
      expect(again.body.data.posted_at).toBe('2031-06-02T17:00:00.000Z');
      expect(again.body.data.metadata).toBeNull();
      expect((await balances())['6100']).toBe('54.90');
      expect((await balances())['6000']).toBe('250.10');

      const rows = await ws.rows('accounts_transactions', {
        referenceType: 'Journal',
        referenceId: created.id,
      });
      expect(rows).toHaveLength(2);
      expect(await ws.rows('manual_journals', { id: created.id })).toHaveLength(
        1,
      );
      expect(
        await ws.rows('manual_journals_entries', {
          manualJournalId: created.id,
        }),
      ).toHaveLength(2);
      const reread = await get(`/ledger/manual-journals/${created.id}`).expect(
        200,
      );
      expect(reread.body.data).toEqual(again.body.data);

      // It can be edited and deleted like any other, and brought back again.
      await put(`/ledger/manual-journals/${created.id}`, {
        posted_at: '2031-06-02T17:00:00Z',
        entries: [line('6100', '6.00', '0'), line('1010', '0', '6.00')],
      }).expect(200);
      expect((await balances())['6100']).toBe('55.90');
      await del(`/ledger/manual-journals/${created.id}`).expect(200);
      const third = await post('/ledger/manual-journals', body);
      expect(third.status).toBe(200);
      expect(third.body.data.id).toBe(created.id);
      await del(`/ledger/manual-journals/${created.id}`).expect(200);
      expect(await balances()).toEqual(before);
    });

    it('an account stays undeletable once posted to, though the journal is gone', async () => {
      const account = (
        await post('/ledger/accounts', {
          name: 'Used Once',
          account_type: 'expense',
        })
      ).body.data;
      expect(account.deletable).toBe(true);

      const created = await post('/ledger/manual-journals', {
        posted_at: '2031-06-03T17:00:00Z',
        entries: [
          { account_id: account.id, debit: '3.00', credit: '0' },
          line('1010', '0', '3.00'),
        ],
      });
      expect(created.status).toBe(201);
      await del(`/ledger/manual-journals/${created.body.data.id}`).expect(200);

      const listed = (await accounts()).find((a) => a.id === account.id);
      expect(listed.deletable).toBe(false);
      expect(listed.balance).toBe('0.00');

      const refused = await del(`/ledger/accounts/${account.id}`);
      expect(refused.status).toBe(400);
      expect(errorType(refused)).toBe('account_has_associated_transactions');
    });

    it('an account edited out of a journal stays undeletable too', async () => {
      const account = (
        await post('/ledger/accounts', {
          name: 'Edited Away',
          account_type: 'expense',
        })
      ).body.data;
      const created = await post('/ledger/manual-journals', {
        posted_at: '2031-06-04T17:00:00Z',
        entries: [
          { account_id: account.id, debit: '2.00', credit: '0' },
          line('1010', '0', '2.00'),
        ],
      });
      await put(`/ledger/manual-journals/${created.body.data.id}`, {
        posted_at: '2031-06-04T17:00:00Z',
        entries: [line('6000', '2.00', '0'), line('1010', '0', '2.00')],
      }).expect(200);
      await del(`/ledger/manual-journals/${created.body.data.id}`).expect(200);

      expect(
        (await accounts()).find((a) => a.id === account.id).deletable,
      ).toBe(false);
    });
  });

  describe('several journals at once', () => {
    const three = (bad: boolean) => ({
      journals: [
        journal('2031-07-01T17:00:00Z', [
          line('6000', '1.00', '0'),
          line('1010', '0', '1.00'),
        ]),
        journal('2031-07-02T17:00:00Z', [
          line('6100', '2.00', '0'),
          line('1010', '0', bad ? '2.50' : '2.00'),
        ]),
        journal('2031-07-03T17:00:00Z', [
          line('6000', '3.00', '0'),
          line('1010', '0', '3.00'),
        ]),
      ],
    });

    it('takes a request body larger than 100 KB', async () => {
      // Three journals, each carrying 60,000 characters of metadata.
      const body = {
        journals: [1, 2, 3].map((n) =>
          journal(
            `2031-07-0${n}T17:00:00Z`,
            [line('6000', '1.00', '0'), line('1010', '0', '1.00')],
            { metadata: { blob: 'x'.repeat(60000) } },
          ),
        ),
      };
      expect(Buffer.byteLength(JSON.stringify(body))).toBeGreaterThan(180000);

      const res = await post('/ledger/manual-journals/bulk', body);
      expect(res.status).toBe(201);
      expect(res.body.data.journals[2].metadata.blob).toHaveLength(60000);

      for (const j of res.body.data.journals) {
        await del(`/ledger/manual-journals/${j.id}`).expect(200);
      }
    });

    it('one refusal refuses them all', async () => {
      const before = (await ws.rows('manual_journals')).length;
      const body = three(true);
      const res = await post('/ledger/manual-journals/bulk', body);

      expect(res.status).toBe(400);
      expect(await ws.rows('manual_journals')).toHaveLength(before);
      expect(
        await ws.rows('ext_external_ids', {
          externalId: body.journals[0].external_id,
        }),
      ).toHaveLength(0);
    });

    it('creates all, and replaces one whose external id already exists', async () => {
      const body = three(false);
      const first = await post('/ledger/manual-journals/bulk', body);
      expect(first.status).toBe(201);
      expect(first.body.data.journals.map((j: any) => j.posted_at)).toEqual([
        '2031-07-01T17:00:00.000Z',
        '2031-07-02T17:00:00.000Z',
        '2031-07-03T17:00:00.000Z',
      ]);
      const numbers = first.body.data.journals.map(
        (j: any) => j.journal_number,
      );
      expect(new Set(numbers).size).toBe(3);
      // 1.00 + 3.00 on rent, 2.00 on supplies.
      expect((await balances())['6000']).toBe('254.10');
      expect((await balances())['6100']).toBe('51.90');

      const more = {
        journals: [
          {
            ...body.journals[1],
            entries: [line('6000', '9.00', '0'), line('1010', '0', '9.00')],
          },
          journal('2031-07-04T17:00:00Z', [
            line('6100', '4.00', '0'),
            line('1010', '0', '4.00'),
          ]),
        ],
      };
      const second = await post('/ledger/manual-journals/bulk', more);
      expect(second.status).toBe(201);
      expect(second.body.data.journals[0].id).toBe(
        first.body.data.journals[1].id,
      );
      expect(second.body.data.journals[0].journal_number).toBe(
        first.body.data.journals[1].journal_number,
      );
      expect(
        second.body.data.journals[0].entries.map((e: any) => [
          e.account.code,
          e.debit,
          e.credit,
        ]),
      ).toEqual([
        ['6000', '9.00', '0.00'],
        ['1010', '0.00', '9.00'],
      ]);
      // Supplies: 49.90 + 4.00, the replaced 2.00 gone.
      // Rent: 250.10 + 1.00 + 3.00 + 9.00.
      expect((await balances())['6100']).toBe('53.90');
      expect((await balances())['6000']).toBe('263.10');

      // The same external id twice in one request is refused whole.
      const twice = await post('/ledger/manual-journals/bulk', {
        journals: [more.journals[1], more.journals[1]],
      });
      expect(twice.status).toBe(400);
      expect((await balances())['6100']).toBe('53.90');

      for (const j of [
        ...first.body.data.journals,
        second.body.data.journals[1],
      ]) {
        await del(`/ledger/manual-journals/${j.id}`).expect(200);
      }
      expect((await balances())['6000']).toBe('250.10');
      expect((await balances())['6100']).toBe('49.90');
    });
  });

  describe('the ledger feed and the lines on an account', () => {
    it('lists every entry newest first, with its source', async () => {
      const feed = await get('/ledger/entries').expect(200);

      expect(feed.body.pagination).toEqual({
        total: 4,
        page: 1,
        page_size: 50,
      });
      expect(
        feed.body.data.map((e: any) => [
          e.source_type,
          e.source_id,
          e.posted_at,
        ]),
      ).toEqual([
        ['manual_journal', journals.J4.id, '2031-02-01T06:00:00.000Z'],
        ['manual_journal', journals.J3.id, '2031-02-01T05:59:59.000Z'],
        ['manual_journal', journals.J2.id, '2031-01-20T18:00:00.000Z'],
        ['manual_journal', journals.J1.id, '2031-01-15T18:00:00.000Z'],
      ]);
      const j1 = feed.body.data[3];
      expect(j1.number).toBe('JE-000001');
      expect(j1.description).toBe('Owner funds the business');
      expect(j1.reference).toBe('REF-1');
      expect(
        j1.entries.map((e: any) => [
          e.account.code,
          e.account.name,
          e.debit,
          e.credit,
        ]),
      ).toEqual([
        ['1010', 'Operating', '1000.00', '0.00'],
        ['3000', 'Equity', '0.00', '1000.00'],
      ]);
    });

    it('pages, oldest first when asked', async () => {
      const page = await get('/ledger/entries', {
        order: 'asc',
        page: 2,
        page_size: 3,
      }).expect(200);
      expect(page.body.data.map((e: any) => e.source_id)).toEqual([
        journals.J4.id,
      ]);
    });

    it('takes a range: its start is in, its end is out', async () => {
      const ids = async (query: Record<string, unknown>) =>
        (
          await get('/ledger/entries', { order: 'asc', ...query }).expect(200)
        ).body.data.map((e: any) => e.source_id);

      expect(await ids({ from: FEB_START })).toEqual([journals.J4.id]);
      expect(await ids({ to: FEB_START })).toEqual([
        journals.J1.id,
        journals.J2.id,
        journals.J3.id,
      ]);
      // From J2's instant to J3's: J2 is in, J3 is out.
      expect(
        await ids({ from: '2031-01-20T18:00:00Z', to: '2031-02-01T05:59:59Z' }),
      ).toEqual([journals.J2.id]);
      expect(await ids({ from: FEB_START, to: JAN_START })).toEqual([]);

      await get('/ledger/entries', { from: 'February' }).expect(400);
    });

    it('gives a whole export in one page, each entry with its lines in order', async () => {
      const feed = await get('/ledger/entries', {
        order: 'asc',
        page_size: 50000,
      }).expect(200);
      expect(feed.body.pagination).toEqual({
        total: 4,
        page: 1,
        page_size: 50000,
      });
      expect(
        feed.body.data.map((e: any) => [
          e.number,
          e.entries.map((l: any) => [l.account.code, l.debit, l.credit]),
        ]),
      ).toEqual([
        [
          'JE-000001',
          [
            ['1010', '1000.00', '0.00'],
            ['3000', '0.00', '1000.00'],
          ],
        ],
        [
          'JE-000002',
          [
            ['6000', '250.10', '0.00'],
            ['6100', '49.90', '0.00'],
            ['1010', '0.00', '300.00'],
          ],
        ],
        [
          'JE-000003',
          [
            ['1020', '50.00', '0.00'],
            ['1010', '0.00', '50.00'],
          ],
        ],
        [
          'JE-000004',
          [
            ['1200', '400.00', '0.00'],
            ['4000', '0.00', '400.00'],
          ],
        ],
      ]);

      const over = await get('/ledger/entries', { page_size: 60000 });
      expect(over.body.pagination.page_size).toBe(50000);
    });

    it('gives the lines on an account with their tracking and stable line id', async () => {
      const lines = await get(`/ledger/accounts/${id['6000']}/lines`).expect(
        200,
      );

      expect(lines.body.pagination.total).toBe(1);
      expect(lines.body.data).toEqual([
        {
          id: expect.any(Number),
          line_id: journals.J2.entries[0].id,
          source_type: 'manual_journal',
          source_id: journals.J2.id,
          account: { id: id['6000'], code: '6000', name: 'Rent' },
          debit: '250.10',
          credit: '0.00',
          posted_at: '2031-01-20T18:00:00.000Z',
          tracking: [
            { category: 'Location', option: 'North', option_name: 'North' },
          ],
        },
      ]);
    });

    it('gives the lines on an account newest first', async () => {
      const lines = await get(`/ledger/accounts/${id['1010']}/lines`).expect(
        200,
      );
      expect(lines.body.data.map((l: any) => [l.debit, l.credit])).toEqual([
        ['0.00', '50.00'],
        ['0.00', '300.00'],
        ['1000.00', '0.00'],
      ]);
    });
  });

  describe('account changes', () => {
    it('creates an account whose name and code are already in use', async () => {
      const externalId = `a:${randomUUID()}`;
      const body = {
        name: 'Rent',
        code: '6000',
        account_type: 'expense',
        parent_id: id['6000'],
        external_id: externalId,
        metadata: { someKey: 'v' },
      };
      const first = await post('/ledger/accounts', body);
      expect(first.status).toBe(201);
      expect(first.body.data).toEqual({
        id: expect.any(Number),
        code: '6000',
        name: 'Rent',
        account_type: 'expense',
        parent_id: id['6000'],
        external_id: externalId,
        metadata: { someKey: 'v' },
        deletable: true,
        balance: '0.00',
        own_balance: '0.00',
      });

      const repeat = await post('/ledger/accounts', { ...body, name: 'Other' });
      expect(repeat.status).toBe(200);
      expect(repeat.body.data).toEqual(first.body.data);

      await del(`/ledger/accounts/${first.body.data.id}`).expect(200);
    });

    it('refuses a parent of another root type, a second receivable account and an unknown type', async () => {
      const base = { name: 'X', account_type: 'income' };

      const wrongParent = await post('/ledger/accounts', {
        ...base,
        parent_id: id['6000'],
      });
      expect(wrongParent.status).toBe(400);
      expect(errorType(wrongParent)).toBe('parent_has_different_type');

      const second = await post('/ledger/accounts', {
        name: 'More receivables',
        account_type: 'accounts-receivable',
      });
      expect(errorType(second)).toBe('ACCOUNT_TYPE_SINGLE');

      const unknown = await post('/ledger/accounts', {
        name: 'X',
        account_type: 'asset',
      });
      expect(errorType(unknown)).toBe('account_type_not_found');

      const noParent = await post('/ledger/accounts', {
        ...base,
        parent_id: 99999999,
      });
      expect(noParent.status).toBe(404);
      expect(errorType(noParent)).toBe('parent_account_not_found');
    });

    it('creates a child with its parent type, and metadata laid over the parent metadata', async () => {
      const res = await post(`/ledger/accounts/${id['6000']}/children`, {
        name: 'Rent - Annex',
        metadata: { b: 2, extra: 'x' },
      });
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({
        name: 'Rent - Annex',
        code: null,
        account_type: 'expense',
        parent_id: id['6000'],
        metadata: { a: 1, b: 2, camelKey: true, extra: 'x' },
      });
      await del(`/ledger/accounts/${res.body.data.id}`).expect(200);
    });

    it('renames, renumbers, clears a number and moves', async () => {
      const created = (
        await post('/ledger/accounts', {
          name: 'Temp',
          code: '6900',
          account_type: 'expense',
        })
      ).body.data;

      const renamed = await put(`/ledger/accounts/${created.id}`, {
        name: 'Temporary',
        code: '6901',
        parent_id: id['6100'],
      });
      expect(renamed.body.data).toMatchObject({
        name: 'Temporary',
        code: '6901',
        parent_id: id['6100'],
      });

      const cleared = await put(`/ledger/accounts/${created.id}`, {
        code: null,
        parent_id: null,
      });
      expect(cleared.body.data).toMatchObject({
        name: 'Temporary',
        code: null,
        parent_id: null,
      });
      await del(`/ledger/accounts/${created.id}`).expect(200);
    });

    it('refuses a move under itself, under a descendant, or under another root type', async () => {
      const child = (
        await post(`/ledger/accounts/${id['6100']}/children`, { name: 'Child' })
      ).body.data;

      const underSelf = await put(`/ledger/accounts/${id['6100']}`, {
        parent_id: id['6100'],
      });
      expect(underSelf.status).toBe(400);
      expect(errorType(underSelf)).toBe('ACCOUNT_PARENT_CIRCULAR');

      const underChild = await put(`/ledger/accounts/${id['6100']}`, {
        parent_id: child.id,
      });
      expect(errorType(underChild)).toBe('ACCOUNT_PARENT_CIRCULAR');

      const otherRoot = await put(`/ledger/accounts/${id['6100']}`, {
        parent_id: id['4000'],
      });
      expect(errorType(otherRoot)).toBe('parent_has_different_type');

      expect(
        (await accounts()).find((a) => a.code === '6100').parent_id,
      ).toBeNull();
      await del(`/ledger/accounts/${child.id}`).expect(200);
    });

    it('a parent with a child on another account type still sums it', async () => {
      // 1000 is a cash account; 1010 under it is a bank account.
      expect((await balances())['1000']).toBe('700.00');
    });

    it('refuses to delete an account with postings, with children, or that the books depend on', async () => {
      const withPostings = await del(`/ledger/accounts/${id['6100']}`);
      expect(withPostings.status).toBe(400);
      expect(errorType(withPostings)).toBe(
        'account_has_associated_transactions',
      );

      const parent = (
        await post('/ledger/accounts', {
          name: 'Parent',
          account_type: 'expense',
        })
      ).body.data;
      const child = (
        await post(`/ledger/accounts/${parent.id}/children`, { name: 'Child' })
      ).body.data;
      const withChildren = await del(`/ledger/accounts/${parent.id}`);
      expect(errorType(withChildren)).toBe('ACCOUNT_HAS_CHILDREN');
      expect((await accounts()).find((a) => a.id === parent.id).deletable).toBe(
        false,
      );

      const receivable = await del(`/ledger/accounts/${id['1200']}`);
      expect(errorType(receivable)).toBe('account_predefined');

      await del(`/ledger/accounts/${child.id}`).expect(200);
      await del(`/ledger/accounts/${parent.id}`).expect(200);
    });

    it('refuses for its children first, when an account has both children and postings', async () => {
      const parent = (
        await post('/ledger/accounts', {
          name: 'Posted Parent',
          account_type: 'expense',
        })
      ).body.data;
      const posted = await post('/ledger/manual-journals', {
        posted_at: '2031-06-05T17:00:00Z',
        entries: [
          { account_id: parent.id, debit: '1.00', credit: '0' },
          line('1010', '0', '1.00'),
        ],
      });
      const child = (
        await post(`/ledger/accounts/${parent.id}/children`, { name: 'Child' })
      ).body.data;

      expect(errorType(await del(`/ledger/accounts/${parent.id}`))).toBe(
        'ACCOUNT_HAS_CHILDREN',
      );
      await del(`/ledger/accounts/${child.id}`).expect(200);
      expect(errorType(await del(`/ledger/accounts/${parent.id}`))).toBe(
        'account_has_associated_transactions',
      );
      await del(`/ledger/manual-journals/${posted.body.data.id}`).expect(200);
    });

    it('deletes an unused account from the chart and from Bigcapital', async () => {
      const created = (
        await post('/ledger/accounts', {
          name: 'Unused',
          account_type: 'expense',
        })
      ).body.data;
      await del(`/ledger/accounts/${created.id}`).expect(200);

      expect((await accounts()).some((a) => a.id === created.id)).toBe(false);
      expect(await ws.rows('accounts', { id: created.id })).toHaveLength(0);
      expect((await get(`/ledger/accounts/${created.id}`)).status).toBe(404);
      expect((await del(`/ledger/accounts/${created.id}`)).status).toBe(404);
    });

    it('answers an account outside the presented chart as not found', async () => {
      const [hidden] = await ws.rows('accounts', { slug: 'office-expenses' });
      const res = await get(`/ledger/accounts/${hidden.id}`);
      expect(res.status).toBe(404);
      expect(errorType(res)).toBe('account_not_found');
    });
  });

  describe('the lock', () => {
    const entries = () => [
      line('6000', '1.00', '0'),
      line('1010', '0', '1.00'),
    ];
    const locked = (res: request.Response) => {
      expect(res.status).toBe(400);
      expect(errorType(res)).toBe('TRANSACTIONS_DATE_LOCKED');
    };
    let open: any;

    beforeAll(async () => {
      open = (
        await post(
          '/ledger/manual-journals',
          journal('2031-02-10T18:00:00Z', entries()),
        )
      ).body.data;

      const res = await put('/ledger/settings', {
        closing_at: '2031-02-01T00:00:00-06:00',
      });
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({
        closing_at: FEB_START,
        reporting_basis: 'accrual',
      });
    });

    afterAll(async () => {
      await put('/ledger/settings', { closing_at: null }).expect(200);
      await del(`/ledger/manual-journals/${open.id}`).expect(200);
    });

    it('is read back exactly, and sets the day lock on the day before', async () => {
      const read = await get('/ledger/settings').expect(200);
      expect(read.body.data.closing_at).toBe(FEB_START);

      const bigcapital = await http()
        .get('/transactions-locking')
        .set(ws.headers())
        .expect(200);
      expect(JSON.stringify(bigcapital.body)).toContain('2031-01-31');
    });

    it('refuses a create a millisecond before the closing instant, and allows one at it', async () => {
      locked(
        await post(
          '/ledger/manual-journals',
          journal('2031-02-01T05:59:59.999Z', entries()),
        ),
      );
      const at = await post(
        '/ledger/manual-journals',
        journal(FEB_START, entries()),
      );
      expect(at.status).toBe(201);
      await del(`/ledger/manual-journals/${at.body.data.id}`).expect(200);
    });

    it('refuses an edit and a delete of a locked journal, and leaves it as it was', async () => {
      locked(
        await put(`/ledger/manual-journals/${journals.J2.id}`, {
          posted_at: journals.J2.posted_at,
          entries: entries(),
        }),
      );
      locked(await del(`/ledger/manual-journals/${journals.J2.id}`));

      const read = await get(
        `/ledger/manual-journals/${journals.J2.id}`,
      ).expect(200);
      expect(read.body.data).toEqual(journals.J2);
    });

    it('refuses moving an open journal into the locked period, and a locked one out of it', async () => {
      locked(
        await put(`/ledger/manual-journals/${open.id}`, {
          posted_at: '2031-01-10T18:00:00Z',
          entries: entries(),
        }),
      );
      locked(
        await put(`/ledger/manual-journals/${journals.J2.id}`, {
          posted_at: '2031-03-10T18:00:00Z',
          entries: entries(),
        }),
      );
    });

    it('refuses a create that would replace a locked journal, alone or in bulk', async () => {
      const body = journal('2031-02-12T18:00:00Z', entries(), {
        external_id: journals.J1.external_id,
      });
      locked(await post('/ledger/manual-journals', body));
      locked(await post('/ledger/manual-journals/bulk', { journals: [body] }));

      const read = await get(`/ledger/manual-journals/${journals.J1.id}`);
      expect(read.body.data).toEqual(journals.J1);
    });

    it('refuses a bulk create with any journal in the locked period', async () => {
      const before = (await ws.rows('manual_journals')).length;
      locked(
        await post('/ledger/manual-journals/bulk', {
          journals: [
            journal('2031-03-01T18:00:00Z', entries()),
            journal('2031-01-05T18:00:00Z', entries()),
          ],
        }),
      );
      expect(await ws.rows('manual_journals')).toHaveLength(before);
    });

    it('a closing instant in the middle of a day locks that morning only', async () => {
      await put('/ledger/settings', {
        closing_at: '2031-03-15T18:00:00Z',
      }).expect(200);

      locked(
        await post(
          '/ledger/manual-journals',
          journal('2031-03-15T17:59:59Z', entries()),
        ),
      );
      const afternoon = await post(
        '/ledger/manual-journals',
        journal('2031-03-15T18:00:00Z', entries()),
      );
      expect(afternoon.status).toBe(201);
      await del(`/ledger/manual-journals/${afternoon.body.data.id}`).expect(
        200,
      );

      await put('/ledger/settings', { closing_at: FEB_START }).expect(200);
    });

    it('clearing it reopens the books', async () => {
      await put('/ledger/settings', { closing_at: null }).expect(200);
      expect((await get('/ledger/settings')).body.data.closing_at).toBeNull();

      const res = await post(
        '/ledger/manual-journals',
        journal('2031-01-05T18:00:00Z', entries()),
      );
      expect(res.status).toBe(201);
      await del(`/ledger/manual-journals/${res.body.data.id}`).expect(200);

      await put('/ledger/settings', { closing_at: FEB_START }).expect(200);
    });

    it('sets the reporting basis, which the workspace then reports', async () => {
      const res = await put('/ledger/settings', {
        reporting_basis: 'cash',
      }).expect(200);
      expect(res.body.data).toEqual({
        closing_at: FEB_START,
        reporting_basis: 'cash',
      });

      const workspace = await http()
        .get(`/ledger/workspaces/${ws.workspace.id}`)
        .set(ws.user.headers())
        .expect(200);
      expect(workspace.body.data.reporting_basis).toBe('cash');

      await put('/ledger/settings', { reporting_basis: 'accrual' }).expect(200);
      await put('/ledger/settings', { reporting_basis: 'modified' }).expect(
        400,
      );
    });
  });

  describe('separation between workspaces', () => {
    it('one workspace cannot read, edit or delete another journal or account', async () => {
      const asOther = (method: 'get' | 'put' | 'delete', path: string) =>
        (http() as any)[method](path).set(other.headers());

      const read = await asOther(
        'get',
        `/ledger/manual-journals/${journals.J4.id}`,
      );
      expect(read.status).toBe(404);

      const edit = await asOther(
        'put',
        `/ledger/manual-journals/${journals.J4.id}`,
      ).send({
        posted_at: '2031-02-01T06:00:00Z',
        entries: [line('1200', '1.00', '0'), line('4000', '0', '1.00')],
      });
      expect(edit.status).toBe(404);
      expect(
        (await asOther('delete', `/ledger/manual-journals/${journals.J4.id}`))
          .status,
      ).toBe(404);

      // The other workspace has the same chart and no postings at all.
      const otherAccounts = (await asOther('get', '/ledger/accounts')).body
        .data;
      expect(otherAccounts.every((a: any) => a.balance === '0.00')).toBe(true);
      expect(
        (await asOther('get', '/ledger/entries')).body.pagination.total,
      ).toBe(0);
    });

    it('a call under an inactive workspace is refused', async () => {
      await http()
        .put(`/ledger/workspaces/${other.workspace.id}/inactivate`)
        .set(other.user.headers())
        .expect(200);

      for (const path of [
        '/ledger/accounts',
        '/ledger/manual-journals',
        '/ledger/entries',
        '/ledger/settings',
      ]) {
        const res = await http().get(path).set(other.headers());
        expect(res.status).toBe(404);
        expect(res.body.errors[0].type).toBe('WORKSPACE_INACTIVE');
      }
    });

    it('a call with no workspace named is refused', async () => {
      await http().get('/ledger/accounts').set(ws.user.headers()).expect(401);
    });
  });

  describe("the books' start", () => {
    const setStart = (booksStartAt: string) =>
      http()
        .put(`/ledger/workspaces/${ws.workspace.id}`)
        .set(ws.user.headers())
        .send({ books_start_at: booksStartAt })
        .expect(200);
    const feedTotal = async (query = {}) =>
      (await get('/ledger/entries', query).expect(200)).body.pagination.total;
    const lineTotal = async (query = {}) =>
      (await get(`/ledger/accounts/${id['1010']}/lines`, query).expect(200))
        .body.pagination.total;

    afterAll(() => setStart('2030-01-01T06:00:00Z'));

    it('entries before it are left out of balances, the feed and account lines', async () => {
      // Starting 1 February, only J4 counts.
      await setStart(FEB_START);

      const only = {
        '1000': '0.00',
        '1010': '0.00',
        '1020': '0.00',
        '1200': '400.00',
        '2010': '0.00',
        '3000': '0.00',
        '4000': '-400.00',
        '6000': '0.00',
        '6100': '0.00',
      };
      expect(await balances()).toEqual(only);
      expect(await balances({ from: JAN_START })).toEqual(only);
      expect(await feedTotal()).toBe(1);
      expect(await lineTotal()).toBe(0);
    });

    it('and counted when the read asks for them', async () => {
      const all = await balances({ include_before_start: 'true' });
      expect(all['1010']).toBe('650.00');
      expect(all['6000']).toBe('250.10');
      expect(all['1000']).toBe('700.00');
      expect(await feedTotal({ include_before_start: 'true' })).toBe(4);
      // J1, J2 and J3 each have one line on 1010.
      expect(await lineTotal({ include_before_start: 'true' })).toBe(3);
    });

    it('the opening balance leaves them out too, unless asked', async () => {
      const cash = async (query: Record<string, unknown>) =>
        (await accounts({ from: FEB_START, ...query })).find(
          (a) => a.code === '1010',
        ).opening_balance;

      expect(await cash({})).toBe('0.00');
      expect(await cash({ include_before_start: 'true' })).toBe('650.00');
    });

    it('the feed range and the start both apply', async () => {
      expect(await feedTotal({ from: JAN_START })).toBe(1);
      expect(
        await feedTotal({ from: JAN_START, include_before_start: 'true' }),
      ).toBe(4);
    });

    it('an account posted to only before it is still listed, and not deletable', async () => {
      const rent = (await accounts()).find((a) => a.code === '6000');
      expect(rent.balance).toBe('0.00');
      expect(rent.deletable).toBe(false);
    });

    it('the feed takes its one sort key, and refuses another', async () => {
      await get('/ledger/entries', { sort: 'posted_at', order: 'desc' }).expect(
        200,
      );
      await get('/ledger/entries', { sort: 'amount' }).expect(400);
      await get('/ledger/accounts', { include_before_start: 'yes' }).expect(
        400,
      );
    });
  });

  describe('at the end', () => {
    it('the books are back to the four journals worked by hand', async () => {
      expect(await balances()).toEqual({
        '1000': '700.00',
        '1010': '650.00',
        '1020': '50.00',
        '1200': '400.00',
        '2010': '0.00',
        '3000': '-1000.00',
        '4000': '-400.00',
        '6000': '250.10',
        '6100': '49.90',
      });
      expect(await ws.rows('manual_journals')).toHaveLength(4);
      expect(await ws.rows('accounts_transactions')).toHaveLength(9);
    });

    it('nothing was ever posted to an account outside the presented chart', async () => {
      const presented = new Set(
        (await ws.rows('ext_account_tree')).map((n) => n.accountId),
      );
      const rows = await ws.rows('accounts_transactions');
      expect(rows.filter((r) => !presented.has(r.accountId))).toHaveLength(0);
    });
  });
});
