import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { Knex } from 'knex';
import {
  createTestApp,
  createTestOrganization,
  dropTestOrganization,
  listAccounts,
  tableRows,
  TestAccount,
  TestOrganization,
} from './harness';
import { ExtUnitOfWork } from '../../src/modules/LedgerExt/common/ExtUnitOfWork.service';
import { ExternalIdsService } from '../../src/modules/LedgerExt/common/ExternalIds.service';
import { ExtMetadataService } from '../../src/modules/LedgerExt/common/ExtMetadata.service';
import { ExtDocumentsService } from '../../src/modules/LedgerExt/common/ExtDocuments.service';
import { ExtLinesService } from '../../src/modules/LedgerExt/common/ExtLines.service';
import { ExtSettingsService } from '../../src/modules/LedgerExt/common/ExtSettings.service';
import { ExtRecordKind } from '../../src/modules/LedgerExt/LedgerExt.constants';
import { CreateManualJournalService } from '../../src/modules/ManualJournals/commands/CreateManualJournal.service';

describe('Ledger extension: shared services', () => {
  let app: INestApplication;
  let org: TestOrganization;
  let accounts: TestAccount[];

  let uow: ExtUnitOfWork;
  let externalIds: ExternalIdsService;
  let metadata: ExtMetadataService;
  let documents: ExtDocumentsService;
  let lines: ExtLinesService;
  let settings: ExtSettingsService;
  let journals: CreateManualJournalService;

  const account = (slug: string) => accounts.find((a) => a.slug === slug)!.id;

  /** Creates a published journal of 10.00 carrying `reference`, in `trx`. */
  const createJournal = async (reference: string, trx: Knex.Transaction) => {
    const journal = await journals.makeJournalEntries(
      {
        date: new Date('2031-05-05'),
        journalNumber: randomUUID(),
        reference,
        publish: true,
        entries: [
          { index: 1, debit: 10, credit: 0, accountId: account('rent') },
          {
            index: 2,
            debit: 0,
            credit: 10,
            accountId: account('bank-account'),
          },
        ],
      } as any,
      trx,
    );
    return journal.id;
  };
  const journalsWithReference = (reference: string) =>
    tableRows(org, 'manual_journals', { reference });

  beforeAll(async () => {
    app = await createTestApp();
    org = await createTestOrganization(app);
    accounts = await listAccounts(org);

    uow = app.get(ExtUnitOfWork, { strict: false });
    externalIds = app.get(ExternalIdsService, { strict: false });
    metadata = app.get(ExtMetadataService, { strict: false });
    documents = app.get(ExtDocumentsService, { strict: false });
    lines = app.get(ExtLinesService, { strict: false });
    settings = app.get(ExtSettingsService, { strict: false });
    journals = app.get(CreateManualJournalService, { strict: false });
  });

  afterAll(async () => {
    if (org) await dropTestOrganization(org);
    if (app) await app.close();
  });

  describe('the transaction', () => {
    it('runs at READ COMMITTED', async () => {
      const level = await org.inTenant(() =>
        uow.withTransaction(async (trx) => {
          await trx('ext_settings').first();
          const [rows] = await trx.raw(
            'SELECT trx_isolation_level AS level FROM information_schema.innodb_trx WHERE trx_mysql_thread_id = CONNECTION_ID()',
          );
          return rows[0]?.level ?? rows[0]?.LEVEL;
        }),
      );
      expect(level).toBe('READ COMMITTED');
    });
  });

  describe('external ids', () => {
    const kind = ExtRecordKind.ManualJournal;

    it('creates a record once and answers a repeat with the same record', async () => {
      const externalId = `once:${randomUUID()}`;
      const create = jest.fn((trx: Knex.Transaction) =>
        createJournal(externalId, trx),
      );
      const read = async (id: number) => ({ id });

      const first = await org.inTenant(() =>
        externalIds.createOnce({ kind, externalId, create, read }),
      );
      const second = await org.inTenant(() =>
        externalIds.createOnce({ kind, externalId, create, read }),
      );

      expect(first.created).toBe(true);
      expect(first.replayed).toBe(false);
      expect(second.created).toBe(false);
      expect(second.replayed).toBe(true);
      expect(second.recordId).toBe(first.recordId);
      expect(create).toHaveBeenCalledTimes(1);
      expect(await journalsWithReference(externalId)).toHaveLength(1);
      expect(
        await org.inTenant(() =>
          externalIds.findExternalId(kind, first.recordId),
        ),
      ).toBe(externalId);
    });

    it('of twelve simultaneous creates, exactly one writes', async () => {
      const externalId = `race:${randomUUID()}`;
      const read = async (id: number) => ({ id });

      const results = await Promise.all(
        Array.from({ length: 12 }, () =>
          org.inTenant(() =>
            externalIds.createOnce({
              kind,
              externalId,
              create: (trx) => createJournal(externalId, trx),
              read,
            }),
          ),
        ),
      );

      expect(results.filter((r) => r.created)).toHaveLength(1);
      expect(results.filter((r) => r.replayed)).toHaveLength(11);
      expect(new Set(results.map((r) => r.recordId)).size).toBe(1);
      expect(await journalsWithReference(externalId)).toHaveLength(1);
      // 12 requests, one journal of two lines: two ledger rows, not twenty-four.
      expect(
        await tableRows(org, 'accounts_transactions', {
          referenceType: 'Journal',
          referenceId: results[0].recordId,
        }),
      ).toHaveLength(2);
    });

    it('thirty simultaneous creates of different ids all succeed', async () => {
      // More at once than the organization has database connections.
      const prefix = `many:${randomUUID()}`;
      const read = async (id: number) => ({ id });

      const results = await Promise.all(
        Array.from({ length: 30 }, (_unused, i) =>
          org.inTenant(() =>
            externalIds.createOnce({
              kind,
              externalId: `${prefix}:${i}`,
              create: (trx) => createJournal(`${prefix}:${i}`, trx),
              read,
            }),
          ),
        ),
      );
      expect(results.filter((r) => r.created)).toHaveLength(30);
      expect(new Set(results.map((r) => r.recordId)).size).toBe(30);
    });

    it('a create that fails leaves nothing, and the id can be used again', async () => {
      const externalId = `fail:${randomUUID()}`;
      const read = async (id: number) => ({ id });

      await expect(
        org.inTenant(() =>
          externalIds.createOnce({
            kind,
            externalId,
            create: async (trx) => {
              await createJournal(externalId, trx);
              throw new Error('forced failure');
            },
            read,
          }),
        ),
      ).rejects.toThrow('forced failure');

      expect(await journalsWithReference(externalId)).toHaveLength(0);
      expect(
        await tableRows(org, 'ext_external_ids', { externalId }),
      ).toHaveLength(0);

      const retry = await org.inTenant(() =>
        externalIds.createOnce({
          kind,
          externalId,
          create: (trx) => createJournal(externalId, trx),
          read,
        }),
      );
      expect(retry.created).toBe(true);
      expect(await journalsWithReference(externalId)).toHaveLength(1);
    });

    it('answers a repeat with the same body as a replay, and another body as a conflict', async () => {
      const externalId = `body:${randomUUID()}`;
      const read = async (id: number) => ({ id });
      const create = jest.fn((trx: Knex.Transaction) =>
        createJournal(externalId, trx),
      );
      const body = { amount: '10.00', lines: [{ a: 1, b: 2 }] };

      const first = await org.inTenant(() =>
        externalIds.createOnce({ kind, externalId, body, create, read }),
      );
      expect(first.created).toBe(true);
      expect(first.replayed).toBe(false);

      // The same values with the keys written in another order are the same body.
      const again = await org.inTenant(() =>
        externalIds.createOnce({
          kind,
          externalId,
          body: { lines: [{ b: 2, a: 1 }], amount: '10.00' },
          create,
          read,
        }),
      );
      expect(again.created).toBe(false);
      expect(again.replayed).toBe(true);
      expect(again.recordId).toBe(first.recordId);

      // One changed value is another body. The record is described for the answer.
      await expect(
        org.inTenant(() =>
          externalIds.createOnce({
            kind,
            externalId,
            body: { ...body, amount: '10.01' },
            describe: async () => ({ version: 4 }),
            create,
            read,
          }),
        ),
      ).rejects.toMatchObject({
        errorType: 'EXTERNAL_ID_IN_USE',
        payload: {
          kind,
          externalId,
          recordId: first.recordId,
          state: 'live',
          version: 4,
        },
      });

      // A record its describer calls voided is refused whatever the body.
      await expect(
        org.inTenant(() =>
          externalIds.createOnce({
            kind,
            externalId,
            body,
            describe: async () => ({ state: 'voided', version: 5 }),
            create,
            read,
          }),
        ),
      ).rejects.toMatchObject({
        errorType: 'EXTERNAL_ID_IN_USE',
        payload: { recordId: first.recordId, state: 'voided', version: 5 },
      });

      // A record made on first sight from its id alone answers any body.
      const any = await org.inTenant(() =>
        externalIds.createOnce({
          kind,
          externalId,
          anyBody: true,
          create,
          read,
        }),
      );
      expect(any.replayed).toBe(true);
      expect(any.recordId).toBe(first.recordId);

      expect(create).toHaveBeenCalledTimes(1);
      expect(await journalsWithReference(externalId)).toHaveLength(1);
    });

    it('the id of a deleted record stays held: it finds no record and is never used again', async () => {
      const externalId = `spent:${randomUUID()}`;
      const read = async (id: number) => ({ id });
      const create = jest.fn((trx: Knex.Transaction) =>
        createJournal(externalId, trx),
      );

      const first = await org.inTenant(() =>
        externalIds.createOnce({ kind, externalId, create, read }),
      );
      await org.inTenant(() =>
        uow.withTransaction((trx) =>
          externalIds.markDeleted(kind, first.recordId, trx),
        ),
      );
      expect(
        await org.inTenant(() => externalIds.findRecordId(kind, externalId)),
      ).toBeNull();
      expect(
        await org.inTenant(() =>
          externalIds.findExternalId(kind, first.recordId),
        ),
      ).toBeNull();
      // A deleted record is still shown with the id it carried.
      expect(
        await org.inTenant(() =>
          externalIds.findLastExternalId(kind, first.recordId),
        ),
      ).toBe(externalId);

      // The same body as the first create: still refused, and nothing is made.
      await expect(
        org.inTenant(() =>
          externalIds.createOnce({ kind, externalId, create, read }),
        ),
      ).rejects.toMatchObject({
        errorType: 'EXTERNAL_ID_IN_USE',
        payload: {
          kind,
          externalId,
          recordId: first.recordId,
          state: 'deleted',
          version: null,
        },
      });
      expect(create).toHaveBeenCalledTimes(1);
      expect(await journalsWithReference(externalId)).toHaveLength(1);
      expect(
        await tableRows(org, 'ext_external_ids', { externalId }),
      ).toHaveLength(1);
    });

    it('the same id may be used by records of different kinds', async () => {
      const externalId = `kinds:${randomUUID()}`;
      await org.inTenant(() =>
        uow.withTransaction(async (trx) => {
          await externalIds.attach(ExtRecordKind.Vendor, 501, externalId, trx);
          await externalIds.attach(
            ExtRecordKind.Customer,
            502,
            externalId,
            trx,
          );
        }),
      );
      expect(
        await org.inTenant(() =>
          externalIds.findRecordId(ExtRecordKind.Vendor, externalId),
        ),
      ).toBe(501);
      expect(
        await org.inTenant(() =>
          externalIds.findRecordId(ExtRecordKind.Customer, externalId),
        ),
      ).toBe(502);
    });

    it('ids that differ only by case are different ids', async () => {
      const suffix = randomUUID();
      await org.inTenant(() =>
        uow.withTransaction(async (trx) => {
          await externalIds.attach(
            ExtRecordKind.Vendor,
            601,
            `Case-${suffix}`,
            trx,
          );
          await externalIds.attach(
            ExtRecordKind.Vendor,
            602,
            `case-${suffix}`,
            trx,
          );
        }),
      );
      expect(
        await org.inTenant(() =>
          externalIds.findRecordId(ExtRecordKind.Vendor, `Case-${suffix}`),
        ),
      ).toBe(601);
      expect(
        await org.inTenant(() =>
          externalIds.findRecordId(ExtRecordKind.Vendor, `case-${suffix}`),
        ),
      ).toBe(602);
    });

    it('a second live record cannot take an id in use', async () => {
      const externalId = `taken:${randomUUID()}`;
      await org.inTenant(() =>
        uow.withTransaction((trx) =>
          externalIds.attach(ExtRecordKind.Vendor, 701, externalId, trx),
        ),
      );
      await expect(
        org.inTenant(() =>
          uow.withTransaction((trx) =>
            externalIds.attach(ExtRecordKind.Vendor, 702, externalId, trx),
          ),
        ),
      ).rejects.toMatchObject({ errorType: 'EXTERNAL_ID_IN_USE' });
    });

    it('accepts 255 characters with colons and hyphens, and refuses 256 and empty', async () => {
      const longest = `a:b-${'x'.repeat(251)}`;
      expect(longest).toHaveLength(255);

      await org.inTenant(() =>
        uow.withTransaction((trx) =>
          externalIds.attach(ExtRecordKind.Vendor, 801, longest, trx),
        ),
      );
      expect(
        await org.inTenant(() =>
          externalIds.findRecordId(ExtRecordKind.Vendor, longest),
        ),
      ).toBe(801);

      for (const bad of [`${longest}y`, '']) {
        await expect(
          org.inTenant(() =>
            uow.withTransaction((trx) =>
              externalIds.attach(ExtRecordKind.Vendor, 802, bad, trx),
            ),
          ),
        ).rejects.toBeDefined();
      }
    });
  });

  describe('metadata', () => {
    const kind = ExtRecordKind.Bill;
    const write = (recordId: number, value: any) =>
      org.inTenant(() =>
        uow.withTransaction((trx) => metadata.set(kind, recordId, value, trx)),
      );
    const read = (recordId: number) =>
      org.inTenant(() => metadata.get(kind, recordId));

    it('returns exactly what was stored, including nested values and other scripts', async () => {
      const value = {
        note: 'Reçu n° 12 — “paid” 😀 日本語',
        nested: { list: [1, 'two', null, { deep: true }], flag: false },
        amount: 12.5,
        empty: '',
      };
      await write(1, value);
      expect(await read(1)).toEqual(value);
    });

    it('replaces on a second write, keeps on undefined, removes on null', async () => {
      await write(2, { a: 1, b: 2 });
      await write(2, { c: 3 });
      expect(await read(2)).toEqual({ c: 3 });

      await write(2, undefined);
      expect(await read(2)).toEqual({ c: 3 });

      await write(2, null);
      expect(await read(2)).toBeNull();
    });

    it('refuses a value that is not an object, or is too large', async () => {
      await expect(write(3, ['a'])).rejects.toMatchObject({
        errorType: 'METADATA_NOT_SERIALIZABLE',
      });
      await expect(write(3, 'text')).rejects.toMatchObject({
        errorType: 'METADATA_NOT_SERIALIZABLE',
      });
      await expect(write(3, { big: 'x'.repeat(70_000) })).rejects.toMatchObject(
        {
          errorType: 'METADATA_NOT_SERIALIZABLE',
        },
      );
      expect(await read(3)).toBeNull();
    });

    it('reads many records at once and keeps kinds apart', async () => {
      await write(10, { n: 10 });
      await write(11, { n: 11 });
      await org.inTenant(() =>
        uow.withTransaction((trx) =>
          metadata.set(ExtRecordKind.SaleInvoice, 10, { other: true }, trx),
        ),
      );
      const many = await org.inTenant(() =>
        metadata.getMany(kind, [10, 11, 12]),
      );
      expect(Object.fromEntries(many)).toEqual({
        10: { n: 10 },
        11: { n: 11 },
      });
    });
  });

  describe('documents', () => {
    const kind = ExtRecordKind.Bill;

    it('keeps the exact timestamp and updates only what is given', async () => {
      await org.inTenant(() =>
        uow.withTransaction((trx) =>
          documents.upsert(
            kind,
            21,
            {
              transactedOn: '2031-06-30',
              paymentMethod: 'check',
              reference: 'REF-1',
              memo: 'first',
            },
            trx,
          ),
        ),
      );
      await org.inTenant(() =>
        uow.withTransaction((trx) =>
          documents.upsert(kind, 21, { memo: 'second' }, trx),
        ),
      );
      expect(await org.inTenant(() => documents.get(kind, 21))).toEqual({
        kind,
        recordId: 21,
        transactedOn: '2031-06-30',
        paymentMethod: 'check',
        reference: 'REF-1',
        memo: 'second',
        createdBy: null,
        // The row's version starts at 1. Writing its fields does not raise it:
        // the change that names a version does.
        version: 1,
        voidedAt: null,
        voidSnapshot: null,
      });
      expect(
        await tableRows(org, 'ext_documents', { kind, recordId: 21 }),
      ).toHaveLength(1);
    });

    it('keeps a voided document readable from its snapshot', async () => {
      const snapshot = {
        id: 22,
        amount: '380.00',
        lines: [{ index: 1, amount: '380.00' }],
      };
      await org.inTenant(() =>
        uow.withTransaction(async (trx) => {
          await documents.upsert(kind, 22, { transactedOn: '2031-08-01' }, trx);
          await documents.markVoided(kind, 22, '2031-08-02', snapshot, trx);
        }),
      );
      const voided = await org.inTenant(() => documents.listVoided(kind));
      expect(voided.map((d) => d.recordId)).toEqual([22]);
      expect(voided[0].voidSnapshot).toEqual(snapshot);
      expect(voided[0].voidedAt).toBe('2031-08-02');
      expect(voided[0].transactedOn).toBe('2031-08-01');
    });
  });

  describe('lines', () => {
    const kind = ExtRecordKind.BillEntry;
    const replace = (recordId: number, input: any[]) =>
      org.inTenant(() =>
        uow.withTransaction((trx) => lines.replace(kind, recordId, input, trx)),
      );

    it('keeps a line id through reorder and edit, and drops removed lines', async () => {
      const created = await replace(31, [
        { entryId: 100, externalId: 'L-a', description: 'first' },
        { entryId: 101, externalId: 'L-b', description: 'second' },
        { entryId: 102, externalId: 'L-c', description: 'third' },
      ]);
      expect(created.map((l) => l.index)).toEqual([1, 2, 3]);
      const [a, b, c] = created;

      // An edit: Bigcapital has replaced every entry row (new entry ids). The
      // caller keeps lines c and a, in that order, drops b and adds a new one.
      const edited = await replace(31, [
        {
          id: c.id,
          entryId: 200,
          externalId: 'L-c',
          description: 'third, edited',
        },
        { id: a.id, entryId: 201, externalId: 'L-a', description: 'first' },
        { entryId: 202, externalId: 'L-d', description: 'new' },
      ]);

      expect(edited.map((l) => l.id).slice(0, 2)).toEqual([c.id, a.id]);
      expect(edited.map((l) => l.index)).toEqual([1, 2, 3]);
      expect(edited.map((l) => l.entryId)).toEqual([200, 201, 202]);
      expect(edited[0].description).toBe('third, edited');
      expect(edited[2].id).not.toBe(b.id);
      expect([a.id, b.id, c.id]).not.toContain(edited[2].id);
      expect(await tableRows(org, 'ext_lines', { id: b.id })).toHaveLength(0);
      expect(
        await tableRows(org, 'ext_lines', { kind, recordId: 31 }),
      ).toHaveLength(3);
    });

    it('does not adopt a line id that belongs to another document', async () => {
      const [other] = await replace(32, [{ entryId: 300 }]);
      const [mine] = await replace(33, [{ id: other.id, entryId: 301 }]);

      expect(mine.id).not.toBe(other.id);
      expect(
        await tableRows(org, 'ext_lines', { kind, recordId: 32 }),
      ).toHaveLength(1);
    });
  });

  describe('settings', () => {
    it('stores, replaces and removes values', async () => {
      const set = (key: string, value: unknown) =>
        org.inTenant(() =>
          uow.withTransaction((trx) => settings.set(key, value, trx)),
        );

      await set('reporting_basis', 'cash');
      await set('lock', { at: '2031-06-30' });
      expect(await org.inTenant(() => settings.get('reporting_basis'))).toBe(
        'cash',
      );

      await set('reporting_basis', 'accrual');
      expect(await org.inTenant(() => settings.all())).toEqual({
        reporting_basis: 'accrual',
        lock: { at: '2031-06-30' },
      });

      await set('lock', null);
      expect(await org.inTenant(() => settings.get('lock'))).toBeNull();
      expect(await org.inTenant(() => settings.get('never_set'))).toBeNull();
    });
  });
});
