import request = require('supertest');
import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import {
  change,
  createTestApp,
  createTestWorkspace,
  dropOrganizations,
  TestWorkspace,
} from './harness';

/**
 * Tracking categories, their options, and links between lines and options
 * made and removed on their own, on a workspace in America/Chicago.
 *
 * The documents, worked by hand:
 *
 *   J1  15 Jan   6000 Rent +100.00, 1010 Operating -100.00
 *   B1  10 Mar   70.00 to 6000 Rent, 30.00 to 6100 Supplies   total 100.00
 *
 * A link moves no money: after any number of links are made and removed,
 * 6000 holds 170.00, 6100 holds 30.00, 1010 holds -100.00 and 2010 holds
 * -100.00 (balances are debits less credits).
 *
 * A write names tags that exist. A category or an option nobody has made,
 * or an option that is archived, is refused, and the refusal writes nothing.
 */
const chart = () => [
  { code: '1010', name: 'Operating', account_type: 'bank' },
  { code: '2010', name: 'Payables', account_type: 'accounts-payable' },
  { code: '6000', name: 'Rent', account_type: 'expense' },
  { code: '6100', name: 'Supplies', account_type: 'expense' },
];

describe('Ledger extension: tracking categories, options and links', () => {
  let app: INestApplication;
  let ws: TestWorkspace;
  let id: Record<string, number>;
  let site: any;
  let j1: any;
  let b1: any;

  const http = () => request(app.getHttpServer());
  const get = (path: string, query: Record<string, unknown> = {}) =>
    http().get(path).query(query).set(ws.headers());
  const post = (path: string, body: unknown = {}) =>
    change(app, 'post', path, ws.headers(), body);
  const put = (path: string, body: unknown) =>
    change(app, 'put', path, ws.headers(), body);
  const del = (path: string) => change(app, 'delete', path, ws.headers());
  const errorType = (res: request.Response) => res.body?.errors?.[0]?.type;

  const balances = async () =>
    Object.fromEntries(
      (await get('/ledger/accounts').expect(200)).body.data
        .filter((a: any) => a.code && a.balance !== '0.00')
        .map((a: any) => [a.code, a.balance]),
    );
  const accountLineTracking = async (code: string) =>
    (await get(`/ledger/accounts/${id[code]}/lines`).expect(200)).body.data.map(
      (line: any) => line.tracking,
    );
  const link = (lineType: string, lineIds: number[], tracking: unknown[]) =>
    post('/ledger/tracking-links', {
      line_type: lineType,
      line_ids: lineIds,
      tracking,
    });
  const readJournal = async () =>
    (await get(`/ledger/manual-journals/${j1.id}`).expect(200)).body.data;
  const readBill = async () =>
    (await get(`/ledger/bills/${b1.id}`).expect(200)).body.data;
  const error = (res: request.Response) => res.body?.errors?.[0];
  /** Every category with the names of its options, as the list answers. */
  const categories = async () =>
    (await get('/ledger/tracking-categories').expect(200)).body.data.map(
      (c: any) => [c.name, c.options.map((o: any) => o.name)],
    );
  /** How many rows each table a write could reach holds. */
  const written = async () =>
    Object.fromEntries(
      await Promise.all(
        [
          'manual_journals',
          'ext_trade_documents',
          'accounts_transactions',
          'ext_tracking_links',
          'ext_audit_log',
          'tracking_categories',
          'tracking_category_options',
        ].map(async (table) => [table, (await ws.rows(table)).length]),
      ),
    );
  /** The newest audit row of a line, and how many rows the line has. */
  const lineLog = async (subject: string, lineId: number) => {
    const res = await get('/ledger/audit-log', {
      subject,
      subject_id: lineId,
    }).expect(200);
    return { newest: res.body.data[0], total: res.body.pagination.total };
  };
  const aJournal = (day: string, amount: string, tracking: unknown[]) => ({
    external_id: `j:${randomUUID()}`,
    posted_on: day,
    entries: [
      { account_id: id['6100'], debit: amount, credit: '0', tracking },
      { account_id: id['1010'], debit: '0', credit: amount },
    ],
  });

  beforeAll(async () => {
    app = await createTestApp();
    ws = await createTestWorkspace(app, { accounts: chart() });

    const accounts = (await get('/ledger/accounts').expect(200)).body.data;
    id = Object.fromEntries(accounts.map((a: any) => [a.code, a.id]));

    const journal = await post('/ledger/manual-journals', {
      external_id: `j:${randomUUID()}`,
      posted_on: '2031-01-15',
      entries: [
        { account_id: id['6000'], debit: '100.00', credit: '0' },
        { account_id: id['1010'], debit: '0', credit: '100.00' },
      ],
    });
    expect(journal.status).toBe(201);
    j1 = journal.body.data;

    await post('/ledger/vendors', {
      external_id: 'v-acme',
      company_name: 'Acme Supply',
    }).expect(201);
    const bill = await post('/ledger/bills', {
      external_id: `b:${randomUUID()}`,
      vendor_external_id: 'v-acme',
      posted_on: '2031-03-10',
      entries: [
        { account_id: id['6000'], rate: '70.00' },
        { account_id: id['6100'], rate: '30.00' },
      ],
    });
    expect(bill.status).toBe(201);
    b1 = bill.body.data;
  });

  afterAll(async () => {
    await dropOrganizations(app, [ws.workspace.organization_id]);
    await app.close();
  });

  describe('a category', () => {
    it('is created with its options, and a repeat adds the missing ones and removes none', async () => {
      const first = await post('/ledger/tracking-categories', {
        name: 'Site',
        display_name: 'Work Site',
        options: [
          { name: 'north', display_name: 'North Yard' },
          { name: 'south' },
        ],
      });
      expect(first.status).toBe(201);
      expect(first.body.data).toEqual({
        id: expect.any(Number),
        name: 'Site',
        display_name: 'Work Site',
        options: [
          {
            id: expect.any(Number),
            name: 'north',
            display_name: 'North Yard',
            active: true,
          },
          {
            id: expect.any(Number),
            name: 'south',
            display_name: 'south',
            active: true,
          },
        ],
        created_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT.*Z$/),
        updated_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT.*Z$/),
      });

      const again = await post('/ledger/tracking-categories', {
        name: 'Site',
        options: [{ name: 'south' }, { name: 'west' }],
      });
      expect(again.status).toBe(200);
      expect(again.body.data.id).toBe(first.body.data.id);
      expect(again.body.data.display_name).toBe('Work Site');
      expect(again.body.data.options.map((o: any) => o.name)).toEqual([
        'north',
        'south',
        'west',
      ]);
      expect(again.body.data.options.slice(0, 2)).toEqual(
        first.body.data.options,
      );
      site = again.body.data;
    });

    it('is read by name without regard to case, and listed with the others', async () => {
      const byName = await get('/ledger/tracking-categories/by-name/site');
      expect(byName.status).toBe(200);
      expect(byName.body.data).toEqual(site);

      await post('/ledger/tracking-categories', { name: 'Crew' }).expect(201);
      const list = await get('/ledger/tracking-categories').expect(200);
      expect(list.body.data.map((c: any) => [c.name, c.display_name])).toEqual([
        ['Site', 'Work Site'],
        ['Crew', 'Crew'],
      ]);
      expect(list.body.data[0]).toEqual(site);
      expect(list.body.data[1].options).toEqual([]);

      const unknown = await get('/ledger/tracking-categories/by-name/nothing');
      expect(unknown.status).toBe(404);
      expect(errorType(unknown)).toBe('tracking_category_not_found');
    });

    it('refuses a category with no name', async () => {
      await post('/ledger/tracking-categories', { options: [] }).expect(400);
      await post('/ledger/tracking-categories', {
        name: 'Site',
        colour: 'red',
      }).expect(400);
    });
  });

  describe('an option', () => {
    let east: any;

    it('is added once: a repeat answers the same option', async () => {
      const first = await post(
        `/ledger/tracking-categories/${site.id}/options`,
        {
          name: 'east',
        },
      );
      expect(first.status).toBe(201);
      // Answered alone, an option says which category it is of.
      expect(first.body.data).toEqual({
        category: 'Site',
        id: expect.any(Number),
        name: 'east',
        display_name: 'east',
        active: true,
      });
      east = first.body.data;

      const again = await post(
        `/ledger/tracking-categories/${site.id}/options`,
        {
          name: 'east',
          display_name: 'Not Taken',
        },
      );
      expect(again.status).toBe(200);
      expect(again.body.data).toEqual(east);

      const unknown = await post(
        '/ledger/tracking-categories/99999999/options',
        {
          name: 'east',
        },
      );
      expect(unknown.status).toBe(404);
      expect(errorType(unknown)).toBe('tracking_category_not_found');
    });

    it('takes a new display name, and keeps the name it is matched by', async () => {
      const renamed = await put(
        `/ledger/tracking-categories/${site.id}/options/${east.id}`,
        { display_name: 'East Yard' },
      );
      expect(renamed.status).toBe(200);
      expect(renamed.body.data).toEqual({ ...east, display_name: 'East Yard' });

      const read = await get('/ledger/tracking-categories/by-name/Site');
      expect(
        read.body.data.options.map((o: any) => [o.name, o.display_name]),
      ).toEqual([
        ['north', 'North Yard'],
        ['south', 'south'],
        ['west', 'west'],
        ['east', 'East Yard'],
      ]);
    });

    it('is not found under a category it does not belong to', async () => {
      const crew = (await get('/ledger/tracking-categories/by-name/Crew')).body
        .data;
      const wrong = await put(
        `/ledger/tracking-categories/${crew.id}/options/${east.id}`,
        { display_name: 'x' },
      );
      expect(wrong.status).toBe(404);
      expect(errorType(wrong)).toBe('tracking_option_not_found');
    });
  });

  describe('a link on a journal line', () => {
    let linkId: number;

    it('is made with an id of its own, and leaves the line ids as they were', async () => {
      const res = await link(
        'journal_line',
        [j1.entries[0].id],
        [{ category: 'Site', option: 'north' }],
      );
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([
        {
          id: expect.any(Number),
          line_id: j1.entries[0].id,
          category: 'Site',
          option: 'north',
          option_name: 'North Yard',
        },
      ]);
      linkId = res.body.data[0].id;

      const read = await readJournal();
      expect(read.entries.map((e: any) => e.id)).toEqual(
        j1.entries.map((e: any) => e.id),
      );
      expect(read.entries[0].tracking).toEqual([
        {
          id: linkId,
          category: 'Site',
          option: 'north',
          option_name: 'North Yard',
        },
      ]);
      expect(read.entries[1].tracking).toEqual([]);
    });

    it('reaches the ledger rows of that line and no other', async () => {
      expect(await accountLineTracking('6000')).toEqual([
        [], // the bill's line, later in the year and so first
        [{ category: 'Site', option: 'north', option_name: 'North Yard' }],
      ]);
      expect(await accountLineTracking('1010')).toEqual([[]]);
    });

    it('takes another option of the same category on the same link', async () => {
      const res = await link(
        'journal_line',
        [j1.entries[0].id],
        [{ category: 'site', option: 'South' }],
      );
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([
        {
          id: linkId,
          line_id: j1.entries[0].id,
          category: 'Site',
          option: 'south',
          option_name: 'south',
        },
      ]);
      expect((await accountLineTracking('6000'))[1]).toEqual([
        { category: 'Site', option: 'south', option_name: 'south' },
      ]);
    });

    it('keeps its id when the journal is edited with the same assignment', async () => {
      const crew = (await get('/ledger/tracking-categories/by-name/Crew')).body
        .data;
      await post(`/ledger/tracking-categories/${crew.id}/options`, {
        name: 'day',
      }).expect(201);

      const edited = await put(`/ledger/manual-journals/${j1.id}`, {
        posted_on: '2031-01-15',
        entries: [
          {
            account_id: id['6000'],
            debit: '100.00',
            credit: '0',
            tracking: [
              { category: 'Site', option: 'south' },
              { category: 'Crew', option: 'day' },
            ],
          },
          { account_id: id['1010'], debit: '0', credit: '100.00' },
        ],
      });
      expect(edited.status).toBe(200);
      expect(edited.body.data.entries[0].tracking).toEqual([
        { id: linkId, category: 'Site', option: 'south', option_name: 'south' },
        {
          id: expect.any(Number),
          category: 'Crew',
          option: 'day',
          option_name: 'day',
        },
      ]);
      expect(edited.body.data.entries[0].tracking[1].id).not.toBe(linkId);
      expect(
        (await accountLineTracking('6000'))[1]
          .map((t: any) => `${t.category}:${t.option}`)
          .sort(),
      ).toEqual(['Crew:day', 'Site:south']);
    });

    it('is removed by its id, from the journal and from the ledger rows', async () => {
      const res = await post('/ledger/tracking-links/remove', {
        ids: [linkId],
      });
      expect(res.status).toBe(200);

      const read = await readJournal();
      expect(read.entries.map((e: any) => e.id)).toEqual(
        j1.entries.map((e: any) => e.id),
      );
      expect(
        read.entries[0].tracking.map((t: any) => [t.category, t.option]),
      ).toEqual([['Crew', 'day']]);
      expect((await accountLineTracking('6000'))[1]).toEqual([
        { category: 'Crew', option: 'day', option_name: 'day' },
      ]);

      // An edit that does not name tracking afterwards must not bring the
      // removed link back: Bigcapital's own copy is gone too.
      const entryIds = (
        await ws.rows('manual_journals_entries', { manualJournalId: j1.id })
      ).map((row) => row.id);
      const held = await ws.rows('manual_journal_entry_tracking_categories');
      expect(
        held.filter((row) => entryIds.includes(row.manualJournalEntryId)),
      ).toHaveLength(1);
    });

    it('refuses a link that is not there, and removes nothing when one of several is not', async () => {
      const crewLink = (await readJournal()).entries[0].tracking[0].id;
      const res = await post('/ledger/tracking-links/remove', {
        ids: [crewLink, linkId],
      });
      expect(res.status).toBe(404);
      expect(errorType(res)).toBe('tracking_link_not_found');
      expect((await readJournal()).entries[0].tracking).toHaveLength(1);
    });

    it('refuses a category it names that is new, makes none, and takes it once it is made', async () => {
      const before = await written();
      const res = await link(
        'journal_line',
        [j1.entries[1].id],
        [{ category: 'Phase', option: 'two', option_name: 'Phase Two' }],
      );
      expect(res.status).toBe(400);
      expect(error(res).type).toBe('TRACKING_CATEGORY_NOT_FOUND');
      expect(error(res).payload).toEqual({ category: 'Phase' });
      expect(await categories()).toEqual([
        ['Site', ['north', 'south', 'west', 'east']],
        ['Crew', ['day']],
      ]);
      expect(await written()).toEqual(before);
      expect((await readJournal()).entries[1].tracking).toEqual([]);

      await post('/ledger/tracking-categories', {
        name: 'Phase',
        options: [{ name: 'two', display_name: 'Phase Two' }],
      }).expect(201);
      // The option is shown under the name it was made with, not the link's.
      const made = await link(
        'journal_line',
        [j1.entries[1].id],
        [{ category: 'Phase', option: 'two', option_name: 'Not Taken' }],
      );
      expect(made.status).toBe(200);
      expect(made.body.data).toEqual([
        {
          id: expect.any(Number),
          line_id: j1.entries[1].id,
          category: 'Phase',
          option: 'two',
          option_name: 'Phase Two',
        },
      ]);
      expect(await categories()).toEqual([
        ['Site', ['north', 'south', 'west', 'east']],
        ['Crew', ['day']],
        ['Phase', ['two']],
      ]);
    });

    it('is refused in a locked period, as an edit is, and allowed again once unlocked', async () => {
      const crewLink = (await readJournal()).entries[0].tracking[0].id;

      await put('/ledger/settings', {
        locked_through: '2031-01-31',
      }).expect(200);
      try {
        const before = await written();
        const edit = await put(`/ledger/manual-journals/${j1.id}`, {
          posted_on: '2031-01-15',
          entries: [
            { account_id: id['6000'], debit: '1.00', credit: '0' },
            { account_id: id['1010'], debit: '0', credit: '1.00' },
          ],
        });
        expect(edit.status).toBe(400);
        expect(errorType(edit)).toBe('TRANSACTIONS_DATE_LOCKED');

        // The journal's own day, 15 January, is the one looked at.
        const made = await link(
          'journal_line',
          [j1.entries[1].id],
          [{ category: 'Site', option: 'west' }],
        );
        expect(made.status).toBe(400);
        expect(error(made).type).toBe('TRANSACTIONS_DATE_LOCKED');
        expect(error(made).payload).toEqual({
          lockedThrough: '2031-01-31',
          date: '2031-01-15',
        });
        const removed = await post('/ledger/tracking-links/remove', {
          ids: [crewLink],
        });
        expect(removed.status).toBe(400);
        expect(error(removed).type).toBe('TRANSACTIONS_DATE_LOCKED');

        expect(await written()).toEqual(before);
        expect(
          (await readJournal()).entries.map((e: any) =>
            e.tracking.map((t: any) => [t.id, t.category, t.option]),
          ),
        ).toEqual([
          [[crewLink, 'Crew', 'day']],
          [[expect.any(Number), 'Phase', 'two']],
        ]);
      } finally {
        await put('/ledger/settings', { locked_through: null }).expect(200);
      }
      const res = await link(
        'journal_line',
        [j1.entries[1].id],
        [{ category: 'Site', option: 'west' }],
      );
      expect(res.status).toBe(200);
      await post('/ledger/tracking-links/remove', {
        ids: [res.body.data[0].id],
      }).expect(200);
    });
  });

  describe('a link on a bill line', () => {
    let linkIds: number[];

    it('is made on several lines at once, each with its own id', async () => {
      const lineIds = b1.entries.map((e: any) => e.id);
      const res = await link('bill_line', lineIds, [
        { category: 'Site', option: 'north' },
      ]);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual(
        lineIds.map((lineId: number) => ({
          id: expect.any(Number),
          line_id: lineId,
          category: 'Site',
          option: 'north',
          option_name: 'North Yard',
        })),
      );
      linkIds = res.body.data.map((l: any) => l.id);
      expect(new Set(linkIds).size).toBe(2);

      const read = await readBill();
      expect(read.entries.map((e: any) => e.id)).toEqual(lineIds);
      expect(read.entries.map((e: any) => e.tracking)).toEqual(
        linkIds.map((linkId) => [
          {
            id: linkId,
            category: 'Site',
            option: 'north',
            option_name: 'North Yard',
          },
        ]),
      );
    });

    it("reaches the bill's ledger rows of those lines, and not the payable's", async () => {
      const north = [
        { category: 'Site', option: 'north', option_name: 'North Yard' },
      ];
      expect((await accountLineTracking('6000'))[0]).toEqual(north);
      expect(await accountLineTracking('6100')).toEqual([north]);
      expect(await accountLineTracking('2010')).toEqual([[]]);
    });

    it('is removed from one line and stays on the other', async () => {
      await post('/ledger/tracking-links/remove', {
        ids: [linkIds[0]],
      }).expect(200);

      const read = await readBill();
      expect(read.entries.map((e: any) => e.tracking.length)).toEqual([0, 1]);
      expect(read.entries[1].tracking[0].id).toBe(linkIds[1]);
      expect((await accountLineTracking('6000'))[0]).toEqual([]);
      expect((await accountLineTracking('6100'))[0]).toHaveLength(1);
    });
  });

  describe('a link request', () => {
    it('is refused whole when a line does not exist or is of another kind', async () => {
      const unknown = await link(
        'journal_line',
        [j1.entries[1].id, 99999999],
        [{ category: 'Site', option: 'north' }],
      );
      expect(unknown.status).toBe(404);
      expect(errorType(unknown)).toBe('line_not_found');
      expect(
        (await readJournal()).entries[1].tracking.map((t: any) => t.category),
      ).toEqual(['Phase']);

      const wrongKind = await link(
        'journal_line',
        [b1.entries[0].id],
        [{ category: 'Site', option: 'north' }],
      );
      expect(wrongKind.status).toBe(404);
      expect(errorType(wrongKind)).toBe('line_not_found');
    });

    it('is refused for a kind of line that cannot be linked, and with nothing to link', async () => {
      await link(
        'bank_line',
        [1],
        [{ category: 'Site', option: 'north' }],
      ).expect(400);
      await link(
        'journal_line',
        [],
        [{ category: 'Site', option: 'north' }],
      ).expect(400);
      await link('journal_line', [j1.entries[0].id], []).expect(400);
      await post('/ledger/tracking-links/remove', { ids: [] }).expect(400);
    });
  });

  /**
   * By now the links stand so:
   *   J1  6000 +100.00 carries Crew: day      1010 -100.00 carries Phase: two
   *   B1  6100  +30.00 carries Site: north    6000 +70.00 and 2010 carry none
   */
  describe('balances by one tracking category', () => {
    const by = async (query: Record<string, unknown>) =>
      Object.fromEntries(
        (await get('/ledger/accounts', query).expect(200)).body.data
          .filter((a: any) => a.code && a.balance !== '0.00')
          .map((a: any) => [a.code, a.balance]),
      );

    it('count only the rows carrying an option of it', async () => {
      expect(await by({ tracking_category: 'Site' })).toEqual({
        '6100': '30.00',
      });
      expect(await by({ tracking_category: 'crew' })).toEqual({
        '6000': '100.00',
      });
      expect(await by({ tracking_category: 'Phase' })).toEqual({
        '1010': '-100.00',
      });
    });

    it('count only the options named, one or several', async () => {
      expect(
        await by({ tracking_category: 'Site', tracking_option: 'north' }),
      ).toEqual({ '6100': '30.00' });
      expect(
        await by({ tracking_category: 'Site', tracking_option: 'south' }),
      ).toEqual({});
      expect(
        await by({
          tracking_category: 'Site',
          tracking_option: ['south', 'north', 'nowhere'],
        }),
      ).toEqual({ '6100': '30.00' });
    });

    it('keep to the range and the basis asked for', async () => {
      expect(
        await by({
          tracking_category: 'Site',
          from: '2031-01-01',
          to: '2031-01-31',
        }),
      ).toEqual({});
      // On the cash basis an unpaid bill has posted nothing.
      expect(await by({ tracking_category: 'Site', basis: 'cash' })).toEqual(
        {},
      );
      expect(await by({ tracking_category: 'Crew', basis: 'cash' })).toEqual({
        '6000': '100.00',
      });
    });

    it('are all zero for a category or an option nobody has made', async () => {
      expect(await by({ tracking_category: 'Nothing' })).toEqual({});
      expect(
        await by({ tracking_category: 'Site', tracking_option: 'nowhere' }),
      ).toEqual({});
    });

    it('refuse an option named with no category', async () => {
      const res = await get('/ledger/accounts', { tracking_option: 'north' });
      expect(res.status).toBe(400);
      expect(errorType(res)).toBe('TRACKING_OPTION_WITHOUT_CATEGORY');
    });
  });

  describe('a tag nobody has made', () => {
    it('is refused when its category is unknown, on a journal, a bill and a link, and nothing is written', async () => {
      const before = await written();
      const tracking = [{ category: 'Depot', option: 'a', option_name: 'A' }];
      const refusals = [
        await post(
          '/ledger/manual-journals',
          aJournal('2031-02-10', '5.00', tracking),
        ),
        await post('/ledger/bills', {
          vendor_external_id: 'v-acme',
          posted_on: '2031-03-11',
          entries: [{ account_id: id['6000'], rate: '5.00', tracking }],
        }),
        await link('journal_line', [j1.entries[0].id], tracking),
        await link('bill_line', [b1.entries[0].id], tracking),
      ];
      for (const res of refusals) {
        expect(res.status).toBe(400);
        expect(error(res).type).toBe('TRACKING_CATEGORY_NOT_FOUND');
        expect(error(res).payload).toEqual({ category: 'Depot' });
      }
      expect(await written()).toEqual(before);
      expect(await categories()).toEqual([
        ['Site', ['north', 'south', 'west', 'east']],
        ['Crew', ['day']],
        ['Phase', ['two']],
      ]);
    });

    it('is refused when its category has no such option, and the category gains none', async () => {
      const before = await written();
      const tracking = [
        { category: 'Site', option: 'nowhere', option_name: 'Nowhere' },
      ];
      const refusals = [
        await post(
          '/ledger/manual-journals',
          aJournal('2031-02-10', '5.00', tracking),
        ),
        await post('/ledger/bills', {
          vendor_external_id: 'v-acme',
          posted_on: '2031-03-11',
          entries: [{ account_id: id['6000'], rate: '5.00', tracking }],
        }),
        await link('journal_line', [j1.entries[0].id], tracking),
        await link('bill_line', [b1.entries[0].id], tracking),
      ];
      for (const res of refusals) {
        expect(res.status).toBe(400);
        expect(error(res).type).toBe('TRACKING_OPTION_NOT_FOUND');
        expect(error(res).payload).toEqual({
          category: 'Site',
          option: 'nowhere',
        });
      }
      expect(await written()).toEqual(before);
      expect(await categories()).toEqual([
        ['Site', ['north', 'south', 'west', 'east']],
        ['Crew', ['day']],
        ['Phase', ['two']],
      ]);
    });

    it('refuses the whole write when one tag of several is unknown', async () => {
      const before = await written();
      const res = await link(
        'journal_line',
        [j1.entries[0].id],
        [
          { category: 'Site', option: 'north' },
          { category: 'Depot', option: 'a' },
        ],
      );
      expect(res.status).toBe(400);
      expect(error(res).type).toBe('TRACKING_CATEGORY_NOT_FOUND');
      expect(await written()).toEqual(before);
      expect(
        (await readJournal()).entries[0].tracking.map((t: any) => t.category),
      ).toEqual(['Crew']);
    });
  });

  /**
   * J2, 10 Feb: 6100 Supplies +5.00 carrying Site: west, 1010 Operating
   * -5.00. It is the only line carrying west, and it is deleted at the end,
   * so the balances of the documents above stand.
   */
  describe('an archived option', () => {
    let west: any;
    let j2: any;
    const optionPath = () =>
      `/ledger/tracking-categories/${site.id}/options/${west.id}`;
    const westOnly = async () =>
      Object.fromEntries(
        (
          await get('/ledger/accounts', {
            tracking_category: 'Site',
            tracking_option: 'west',
          }).expect(200)
        ).body.data
          .filter((a: any) => a.code && a.balance !== '0.00')
          .map((a: any) => [a.code, a.balance]),
      );

    it('is archived by its category and id, and says so wherever it is read', async () => {
      const made = await post(
        '/ledger/manual-journals',
        aJournal('2031-02-10', '5.00', [{ category: 'Site', option: 'west' }]),
      );
      expect(made.status).toBe(201);
      j2 = made.body.data;
      west = site.options.find((o: any) => o.name === 'west');

      const archived = await put(optionPath(), { active: false });
      expect(archived.status).toBe(200);
      expect(archived.body.data).toEqual({
        category: 'Site',
        id: west.id,
        name: 'west',
        display_name: 'west',
        active: false,
      });
      const read = await get('/ledger/tracking-categories/by-name/Site');
      expect(
        read.body.data.options.map((o: any) => [o.name, o.active]),
      ).toEqual([
        ['north', true],
        ['south', true],
        ['west', false],
        ['east', true],
      ]);
    });

    it('takes no new journal line and no new link, and nothing is written', async () => {
      const before = await written();
      const tracking = [{ category: 'Site', option: 'west' }];
      const refusals = [
        await post(
          '/ledger/manual-journals',
          aJournal('2031-02-11', '7.00', tracking),
        ),
        await link('journal_line', [j1.entries[1].id], tracking),
        await link('bill_line', [b1.entries[0].id], tracking),
      ];
      for (const res of refusals) {
        expect(res.status).toBe(400);
        expect(error(res).type).toBe('TRACKING_OPTION_ARCHIVED');
        expect(error(res).payload).toEqual({
          category: 'Site',
          option: 'west',
        });
      }
      expect(await written()).toEqual(before);
      expect(
        (await readJournal()).entries[1].tracking.map((t: any) => t.category),
      ).toEqual(['Phase']);
      expect((await readBill()).entries[0].tracking).toEqual([]);
    });

    it('stays on the line that carries it, which still reads it', async () => {
      const read = (await get(`/ledger/manual-journals/${j2.id}`).expect(200))
        .body.data;
      expect(read.entries[0].tracking).toEqual([
        {
          id: j2.entries[0].tracking[0].id,
          category: 'Site',
          option: 'west',
          option_name: 'west',
        },
      ]);
      // 6100 holds the bill's line of 10 March first, then J2's of 10 Feb.
      expect((await accountLineTracking('6100'))[1]).toEqual([
        { category: 'Site', option: 'west', option_name: 'west' },
      ]);
      expect(await westOnly()).toEqual({ '6100': '5.00' });
    });

    it('is kept by an edit of the journal that carries it, and taken by no other', async () => {
      // The same journal sent again with another description: taken, the
      // archived tag still on its line and its 5.00 still counted.
      const body = (externalId: string) => ({
        ...aJournal('2031-02-10', '5.00', [
          { category: 'Site', option: 'west' },
        ]),
        external_id: externalId,
        description: 'Sent again',
      });
      const edited = await put(
        `/ledger/manual-journals/${j2.id}`,
        body(j2.external_id),
      );
      expect(edited.status).toBe(200);
      expect(
        edited.body.data.entries[0].tracking.map((t: any) => [
          t.category,
          t.option,
        ]),
      ).toEqual([['Site', 'west']]);
      expect(await westOnly()).toEqual({ '6100': '5.00' });

      // The same edit of the first journal, which does not carry it: refused.
      const other = await put(
        `/ledger/manual-journals/${j1.id}`,
        body(j1.external_id),
      );
      expect(other.status).toBe(400);
      expect(errorType(other)).toBe('TRACKING_OPTION_ARCHIVED');
    });

    it('takes a display name while archived, and stays archived', async () => {
      const renamed = await put(optionPath(), { display_name: 'West Gate' });
      expect(renamed.status).toBe(200);
      expect(renamed.body.data).toEqual({
        category: 'Site',
        id: west.id,
        name: 'west',
        display_name: 'West Gate',
        active: false,
      });
    });

    it('is restored, and takes a new line and a new link again', async () => {
      const restored = await put(optionPath(), { active: true });
      expect(restored.status).toBe(200);
      expect(restored.body.data).toEqual({
        category: 'Site',
        id: west.id,
        name: 'west',
        display_name: 'West Gate',
        active: true,
      });

      const tracking = [{ category: 'Site', option: 'west' }];
      const linked = await link('journal_line', [j1.entries[1].id], tracking);
      expect(linked.status).toBe(200);
      expect(linked.body.data).toEqual([
        {
          id: expect.any(Number),
          line_id: j1.entries[1].id,
          category: 'Site',
          option: 'west',
          option_name: 'West Gate',
        },
      ]);
      const j3 = await post(
        '/ledger/manual-journals',
        aJournal('2031-02-11', '7.00', tracking),
      );
      expect(j3.status).toBe(201);
      // J2's 5.00 and J3's 7.00 on 6100; J1's -100.00 on 1010.
      expect(await westOnly()).toEqual({ '6100': '12.00', '1010': '-100.00' });

      // The books are left as the documents at the top make them.
      await post('/ledger/tracking-links/remove', {
        ids: [linked.body.data[0].id],
      }).expect(200);
      await del(`/ledger/manual-journals/${j3.body.data.id}`).expect(200);
      await del(`/ledger/manual-journals/${j2.id}`).expect(200);
      expect(await westOnly()).toEqual({});
    });

    it('refuses a value for active that is not true or false', async () => {
      await put(optionPath(), { active: 'no' }).expect(400);
      const read = await get('/ledger/tracking-categories/by-name/Site');
      expect(
        read.body.data.options.find((o: any) => o.name === 'west'),
      ).toEqual({
        id: west.id,
        name: 'west',
        display_name: 'West Gate',
        active: true,
      });
    });
  });

  /**
   * J1's line on 6000 carries Crew: day, and J1 is dated 15 January. B1's
   * line on 6100 carries Site: north, and B1 is dated 10 March.
   */
  describe('a retag', () => {
    let crewLink: number;
    const night = [{ category: 'Crew', option: 'night' }];

    beforeAll(async () => {
      const crew = (await get('/ledger/tracking-categories/by-name/Crew')).body
        .data;
      await post(`/ledger/tracking-categories/${crew.id}/options`, {
        name: 'night',
      }).expect(201);
      crewLink = (await readJournal()).entries[0].tracking[0].id;
    });

    it('is refused in a locked period, and the line, its ledger rows and the log stay as they were', async () => {
      await put('/ledger/settings', {
        locked_through: '2031-03-31',
      }).expect(200);
      try {
        const before = await written();
        const onJournal = await link('journal_line', [j1.entries[0].id], night);
        expect(onJournal.status).toBe(400);
        expect(error(onJournal).type).toBe('TRANSACTIONS_DATE_LOCKED');
        expect(error(onJournal).payload).toEqual({
          lockedThrough: '2031-03-31',
          date: '2031-01-15',
        });
        // A bill is looked at on the day it was posted on, 10 March.
        const onBill = await link(
          'bill_line',
          [b1.entries[1].id],
          [{ category: 'Site', option: 'south' }],
        );
        expect(onBill.status).toBe(400);
        expect(error(onBill).type).toBe('TRANSACTIONS_DATE_LOCKED');
        expect(error(onBill).payload).toEqual({
          lockedThrough: '2031-03-31',
          date: '2031-03-10',
        });

        expect(await written()).toEqual(before);
        expect((await readJournal()).entries[0].tracking).toEqual([
          { id: crewLink, category: 'Crew', option: 'day', option_name: 'day' },
        ]);
        expect((await accountLineTracking('6000'))[1]).toEqual([
          { category: 'Crew', option: 'day', option_name: 'day' },
        ]);
        expect(
          (await readBill()).entries[1].tracking.map((t: any) => t.option),
        ).toEqual(['north']);
      } finally {
        await put('/ledger/settings', { locked_through: null }).expect(200);
      }
    });

    it('is let through a locked period by an exception covering the day', async () => {
      const lineId = b1.entries[1].id;
      const { total } = await lineLog('bill_entry', lineId);

      await put('/ledger/settings', {
        locked_through: '2031-03-31',
      }).expect(200);
      try {
        const exception = await http()
          .post('/ledger/lock-exceptions')
          .set({ ...ws.headers(), 'x-ledger-actor': 'ana' })
          .send({
            from: '2031-03-01',
            to: '2031-03-31',
            reason: 'A March bill was tagged late',
            expires_at: '2999-01-01T00:00:00.000Z',
          });
        expect(exception.status).toBe(201);

        // March is open again; January is not.
        const onJournal = await link('journal_line', [j1.entries[0].id], night);
        expect(onJournal.status).toBe(400);
        expect(error(onJournal).type).toBe('TRANSACTIONS_DATE_LOCKED');

        const onBill = await link(
          'bill_line',
          [lineId],
          [{ category: 'Site', option: 'south' }],
        );
        expect(onBill.status).toBe(200);

        await http()
          .post(`/ledger/lock-exceptions/${exception.body.data.id}/revoke`)
          .set({ ...ws.headers(), 'x-ledger-actor': 'ana' })
          .expect(200);
      } finally {
        await put('/ledger/settings', { locked_through: null }).expect(200);
      }
      // The bill's line is logged with the option it had and the one it has.
      const log = await lineLog('bill_entry', lineId);
      expect(log.total).toBe(total + 1);
      expect(log.newest).toEqual({
        id: expect.any(Number),
        action: 'edit',
        subject: 'bill_entry',
        subject_id: lineId,
        number: null,
        actor: null,
        before: { tracking: [{ category: 'Site', option: 'north' }] },
        after: { tracking: [{ category: 'Site', option: 'south' }] },
        created_at: expect.any(String),
      });
      // The 30.00 of that line moved from north to south with it.
      const south = (
        await get('/ledger/accounts', {
          tracking_category: 'Site',
          tracking_option: 'south',
        }).expect(200)
      ).body.data.find((a: any) => a.code === '6100');
      expect(south.balance).toBe('30.00');
    });

    it('in an open period is logged on the line with both values, exactly', async () => {
      const lineId = j1.entries[0].id;
      const { total } = await lineLog('manual_journal_entry', lineId);
      const untouched = await lineLog('manual_journal_entry', j1.entries[1].id);

      const res = await link('journal_line', [lineId], night);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([
        {
          id: crewLink,
          line_id: lineId,
          category: 'Crew',
          option: 'night',
          option_name: 'night',
        },
      ]);

      const log = await lineLog('manual_journal_entry', lineId);
      expect(log.total).toBe(total + 1);
      expect(log.newest).toEqual({
        id: expect.any(Number),
        action: 'edit',
        subject: 'manual_journal_entry',
        subject_id: lineId,
        number: null,
        actor: null,
        before: { tracking: [{ category: 'Crew', option: 'day' }] },
        after: { tracking: [{ category: 'Crew', option: 'night' }] },
        created_at: expect.any(String),
      });
      // The other line of the journal was not changed, and has no new row.
      expect(
        (await lineLog('manual_journal_entry', j1.entries[1].id)).total,
      ).toBe(untouched.total);
    });

    it('of several lines at once is logged once for each line', async () => {
      const lineIds = b1.entries.map((e: any) => e.id);
      const totals = await Promise.all(
        lineIds.map((lineId: number) => lineLog('bill_entry', lineId)),
      );
      await link('bill_line', lineIds, [
        { category: 'Phase', option: 'two' },
      ]).expect(200);

      // The first line carried nothing; the second carries Site: south.
      const logs = await Promise.all(
        lineIds.map((lineId: number) => lineLog('bill_entry', lineId)),
      );
      expect(logs.map((log) => log.total)).toEqual(
        totals.map((log) => log.total + 1),
      );
      expect(logs.map((log) => [log.newest.before, log.newest.after])).toEqual([
        [
          { tracking: [] },
          { tracking: [{ category: 'Phase', option: 'two' }] },
        ],
        [
          { tracking: [{ category: 'Site', option: 'south' }] },
          {
            tracking: [
              { category: 'Site', option: 'south' },
              { category: 'Phase', option: 'two' },
            ],
          },
        ],
      ]);
    });
  });

  describe('a link removed', () => {
    it('is logged on its line with what the line carried and what it is left with', async () => {
      const lineId = b1.entries[1].id;
      const { total } = await lineLog('bill_entry', lineId);
      const links = (await readBill()).entries[1].tracking;
      const siteLink = links.find((t: any) => t.category === 'Site').id;

      await post('/ledger/tracking-links/remove', {
        ids: [siteLink],
      }).expect(200);

      const log = await lineLog('bill_entry', lineId);
      expect(log.total).toBe(total + 1);
      expect(log.newest).toEqual({
        id: expect.any(Number),
        action: 'edit',
        subject: 'bill_entry',
        subject_id: lineId,
        number: null,
        actor: null,
        before: {
          tracking: [
            { category: 'Site', option: 'south' },
            { category: 'Phase', option: 'two' },
          ],
        },
        after: { tracking: [{ category: 'Phase', option: 'two' }] },
        created_at: expect.any(String),
      });
    });

    it('from a journal line is logged the same way, down to no tag at all', async () => {
      const lineId = j1.entries[0].id;
      const { total } = await lineLog('manual_journal_entry', lineId);
      const [crewLink] = (await readJournal()).entries[0].tracking;

      await post('/ledger/tracking-links/remove', {
        ids: [crewLink.id],
      }).expect(200);

      const log = await lineLog('manual_journal_entry', lineId);
      expect(log.total).toBe(total + 1);
      expect(log.newest).toEqual({
        id: expect.any(Number),
        action: 'edit',
        subject: 'manual_journal_entry',
        subject_id: lineId,
        number: null,
        actor: null,
        before: { tracking: [{ category: 'Crew', option: 'night' }] },
        after: { tracking: [] },
        created_at: expect.any(String),
      });
      expect((await readJournal()).entries[0].tracking).toEqual([]);
    });

    it('is refused in a locked period and writes no row', async () => {
      const lineId = b1.entries[0].id;
      const [phaseLink] = (await readBill()).entries[0].tracking;

      await put('/ledger/settings', {
        locked_through: '2031-03-10',
      }).expect(200);
      try {
        const before = await written();
        const res = await post('/ledger/tracking-links/remove', {
          ids: [phaseLink.id],
        });
        expect(res.status).toBe(400);
        expect(error(res).type).toBe('TRANSACTIONS_DATE_LOCKED');
        expect(error(res).payload).toEqual({
          lockedThrough: '2031-03-10',
          date: '2031-03-10',
        });
        expect(await written()).toEqual(before);
      } finally {
        await put('/ledger/settings', { locked_through: null }).expect(200);
      }
      expect((await readBill()).entries[0].tracking).toEqual([
        {
          id: phaseLink.id,
          category: 'Phase',
          option: 'two',
          option_name: 'Phase Two',
        },
      ]);
      expect((await lineLog('bill_entry', lineId)).newest.after).toEqual({
        tracking: [{ category: 'Phase', option: 'two' }],
      });
    });
  });

  it('moves no money: every balance is what the documents alone make it', async () => {
    expect(await balances()).toEqual({
      '1010': '-100.00',
      '2010': '-100.00',
      '6000': '170.00',
      '6100': '30.00',
    });
  });
});
