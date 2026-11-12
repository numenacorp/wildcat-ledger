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
    http()
      .post(path)
      .set(ws.headers())
      .send(body as any);
  const put = (path: string, body: unknown) =>
    http()
      .put(path)
      .set(ws.headers())
      .send(body as any);
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

  beforeAll(async () => {
    app = await createTestApp();
    ws = await createTestWorkspace(app, { accounts: chart() });

    const accounts = (await get('/ledger/accounts').expect(200)).body.data;
    id = Object.fromEntries(accounts.map((a: any) => [a.code, a.id]));

    const journal = await post('/ledger/manual-journals', {
      external_id: `j:${randomUUID()}`,
      posted_at: '2031-01-15T18:00:00Z',
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
      posted_at: '2031-03-10T18:00:00Z',
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
      const edited = await put(`/ledger/manual-journals/${j1.id}`, {
        posted_at: '2031-01-15T18:00:00Z',
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

    it('makes a category and an option it names that are new', async () => {
      const res = await link(
        'journal_line',
        [j1.entries[1].id],
        [{ category: 'Phase', option: 'two', option_name: 'Phase Two' }],
      );
      expect(res.status).toBe(200);
      expect(res.body.data[0]).toMatchObject({
        category: 'Phase',
        option: 'two',
        option_name: 'Phase Two',
      });
      const made = await get('/ledger/tracking-categories/by-name/Phase');
      expect(made.body.data.options).toEqual([
        {
          id: expect.any(Number),
          name: 'two',
          display_name: 'Phase Two',
          active: true,
        },
      ]);
    });

    it('is allowed in a locked period, where an edit is not', async () => {
      await put('/ledger/settings', {
        closing_at: '2031-02-01T00:00:00-06:00',
      }).expect(200);
      try {
        const edit = await put(`/ledger/manual-journals/${j1.id}`, {
          posted_at: '2031-01-15T18:00:00Z',
          entries: [
            { account_id: id['6000'], debit: '1.00', credit: '0' },
            { account_id: id['1010'], debit: '0', credit: '1.00' },
          ],
        });
        expect(edit.status).toBe(400);
        expect(errorType(edit)).toBe('TRANSACTIONS_DATE_LOCKED');

        const res = await link(
          'journal_line',
          [j1.entries[1].id],
          [{ category: 'Site', option: 'west' }],
        );
        expect(res.status).toBe(200);
        await post('/ledger/tracking-links/remove', {
          ids: [res.body.data[0].id],
        }).expect(200);
      } finally {
        await put('/ledger/settings', { closing_at: null }).expect(200);
      }
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
          from: '2031-01-01T06:00:00Z',
          to: '2031-02-01T06:00:00Z',
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

  it('moves no money: every balance is what the documents alone make it', async () => {
    expect(await balances()).toEqual({
      '1010': '-100.00',
      '2010': '-100.00',
      '6000': '170.00',
      '6100': '30.00',
    });
  });
});
