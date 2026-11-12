import { Knex } from 'knex';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ServiceError } from '@/modules/Items/ServiceError';
import { TENANCY_DB_CONNECTION } from '@/modules/Tenancy/TenancyDB/TenancyDB.constants';
import { CreateManualJournalService } from '@/modules/ManualJournals/commands/CreateManualJournal.service';
import { EditManualJournal } from '@/modules/ManualJournals/commands/EditManualJournal.service';
import { DeleteManualJournalService } from '@/modules/ManualJournals/commands/DeleteManualJournal.service';
import { ERRORS as JOURNAL_ERRORS } from '@/modules/ManualJournals/constants';
import { ExtUnitOfWork } from '../common/ExtUnitOfWork.service';
import { ExternalIdsService } from '../common/ExternalIds.service';
import { ExtMetadataService } from '../common/ExtMetadata.service';
import { ExtDocumentsService } from '../common/ExtDocuments.service';
import { ExtLinesService } from '../common/ExtLines.service';
import { ExtSettingsService } from '../common/ExtSettings.service';
import { ExtSequencesService } from '../common/ExtSequences.service';
import { ExtServiceLocator } from '../common/ExtServiceLocator.service';
import { LedgerRowsService } from '../common/LedgerRows.service';
import { fromThousandths, toThousandths } from '../common/decimal';
import { toInstant, toLocalDay } from '../common/timestamps';
import { ERRORS, ExtRecordKind } from '../LedgerExt.constants';
import { ExtAccountTreeService } from '../Accounts/ExtAccountTree.service';
import { ACCOUNT_ERRORS } from '../Accounts/LedgerAccounts.constants';
import { ExtLockService } from '../Lock/ExtLock.service';
import {
  ExtTrackingService,
  TrackingAssignment,
} from '../Tracking/ExtTracking.service';
import { WORKSPACE_SETTINGS } from '../Workspaces/LedgerWorkspaces.constants';
import {
  LedgerManualJournalDto,
  ListLedgerManualJournalsQueryDto,
} from './LedgerManualJournal.dto';

const SEQUENCE = 'manual_journal';

export interface LedgerManualJournalView {
  id: number;
  externalId: string | null;
  journalNumber: string;
  postedAt: string;
  description: string | null;
  reference: string | null;
  createdBy: string | null;
  metadata: Record<string, unknown> | null;
  entries: Array<{
    id: number;
    externalId: string | null;
    accountId: number;
    account: { id: number; code: string | null; name: string };
    debit: string;
    credit: string;
    note: string | null;
    tracking: Array<{
      id: number;
      category: string;
      option: string;
      optionName: string;
    }>;
  }>;
}

/** What a journal needs resolved before its transaction opens. */
interface PreparedJournal {
  dto: LedgerManualJournalDto;
  postedAt: string;
  date: string;
  entries: Array<{
    index: number;
    accountId: number;
    debit: number;
    credit: number;
    note?: string;
    contactId?: number;
    trackingCategories: TrackingAssignment[];
  }>;
}

/**
 * Manual journals of the extension: published at once, carrying an exact
 * instant, an external id, metadata and tracking by name, with lines whose
 * ids survive edits. Each write is one transaction.
 */
@Injectable()
export class LedgerManualJournalsService {
  constructor(
    @Inject(TENANCY_DB_CONNECTION)
    private readonly tenantKnex: () => Knex,
    private readonly uow: ExtUnitOfWork,
    private readonly externalIds: ExternalIdsService,
    private readonly metadata: ExtMetadataService,
    private readonly documents: ExtDocumentsService,
    private readonly lines: ExtLinesService,
    private readonly settings: ExtSettingsService,
    private readonly sequences: ExtSequencesService,
    private readonly tree: ExtAccountTreeService,
    private readonly tracking: ExtTrackingService,
    private readonly lock: ExtLockService,
    private readonly locator: ExtServiceLocator,
    private readonly ledgerRows: LedgerRowsService,
  ) {}

  /**
   * Creates a journal. A create carrying the external id of an existing
   * journal replaces that journal with the one given, and one carrying the
   * external id of a deleted journal brings it back under its old id.
   */
  public async create(
    dto: LedgerManualJournalDto,
  ): Promise<{ journal: LedgerManualJournalView; created: boolean }> {
    const kind = ExtRecordKind.ManualJournal;

    if (dto.externalId) {
      const existingId = await this.externalIds.findRecordId(
        kind,
        dto.externalId,
      );
      if (existingId !== null) {
        return { journal: await this.edit(existingId, dto), created: false };
      }
      const deletedId = await this.externalIds.findDeletedRecordId(
        kind,
        dto.externalId,
      );
      if (deletedId !== null) {
        const [revived] = await this.prepare([dto]);
        const revivedNumber = await this.sequences.next(SEQUENCE);
        const broughtBack = await this.uow.withTransaction(async (trx) => {
          if (!(await this.externalIds.revive(kind, dto.externalId, trx))) {
            return false;
          }
          await this.createInTransaction(
            revived,
            revivedNumber,
            trx,
            deletedId,
          );
          return true;
        });
        // Another request brought it back first: this one replaces it.
        if (!broughtBack) return this.create(dto);

        return { journal: await this.get(deletedId), created: false };
      }
    }
    const [prepared] = await this.prepare([dto]);
    const number = await this.sequences.next(SEQUENCE);

    const { recordId, created } = await this.externalIds.createOnce({
      kind,
      externalId: dto.externalId,
      create: (trx) => this.createInTransaction(prepared, number, trx),
      read: async (id) => id,
    });
    // Lost to a simultaneous create of the same external id: replace it.
    if (!created) {
      return { journal: await this.edit(recordId, dto), created: false };
    }
    return { journal: await this.get(recordId), created };
  }

  /**
   * Creates several journals in one transaction: all of them, or none. A
   * journal whose external id already exists replaces that journal, as on a
   * single create.
   */
  public async createBulk(
    dtos: LedgerManualJournalDto[],
  ): Promise<LedgerManualJournalView[]> {
    const kind = ExtRecordKind.ManualJournal;
    const seen = new Set<string>();

    dtos.forEach((dto) => {
      if (!dto.externalId) return;
      if (seen.has(dto.externalId)) {
        throw new ServiceError(
          ERRORS.EXTERNAL_ID_IN_USE,
          'Two journals of the request carry the same external id.',
          { externalId: dto.externalId },
        );
      }
      seen.add(dto.externalId);
    });
    const prepared = await this.prepare(dtos);
    const firstNumber = await this.sequences.next(SEQUENCE, prepared.length);

    const ids = await this.uow.withTransaction(async (trx) => {
      const written: number[] = [];

      for (let i = 0; i < prepared.length; i += 1) {
        const { externalId } = prepared[i].dto;
        const number = firstNumber + i;

        if (externalId) {
          const existingId = await this.externalIds.findRecordId(
            kind,
            externalId,
            trx,
          );
          if (existingId !== null) {
            await this.editInTransaction(existingId, prepared[i], trx);
            written.push(existingId);
            continue;
          }
          const deletedId = await this.externalIds.findDeletedRecordId(
            kind,
            externalId,
            trx,
          );
          if (
            deletedId !== null &&
            (await this.externalIds.revive(kind, externalId, trx))
          ) {
            await this.createInTransaction(prepared[i], number, trx, deletedId);
            written.push(deletedId);
            continue;
          }
        }
        const { recordId } = await this.externalIds.createOnce({
          kind,
          externalId,
          create: (innerTrx) =>
            this.createInTransaction(prepared[i], number, innerTrx),
          read: async (id) => id,
          trx,
        });
        written.push(recordId);
      }
      return written;
    });
    const views = await this.views(ids);
    return ids.map((id) => views.get(id));
  }

  /**
   * Replaces a journal with the one given. Its id is kept, and so is the id
   * of each line whose position is unchanged.
   */
  public async edit(
    journalId: number,
    dto: LedgerManualJournalDto,
  ): Promise<LedgerManualJournalView> {
    await this.rowOrThrow(journalId);
    const [prepared] = await this.prepare([dto]);

    await this.uow.withTransaction((trx) =>
      this.editInTransaction(journalId, prepared, trx),
    );
    return this.get(journalId);
  }

  private async editInTransaction(
    journalId: number,
    prepared: PreparedJournal,
    trx: Knex.Transaction,
  ): Promise<void> {
    const kind = ExtRecordKind.ManualJournal;
    const { dto } = prepared;
    const old = await this.rowOrThrow(journalId, trx);
    const oldDocument = await this.documents.get(kind, journalId, trx);

    // The journal as it stands must be open too: an edit cannot move a
    // journal out of the closed period.
    await this.lock.assertOpen(
      [oldDocument?.transactedAt, prepared.postedAt],
      trx,
    );

    const editJournal = await this.locator.resolve(EditManualJournal);

    await editJournal.editJournalEntries(
      journalId,
      this.toBigcapitalDto(prepared, old.journalNumber) as any,
      trx,
    );
    if (dto.externalId !== undefined) {
      const current = await this.externalIds.findExternalId(
        kind,
        journalId,
        trx,
      );
      if (current !== (dto.externalId ?? null)) {
        await this.externalIds.release(kind, journalId, trx);
        if (dto.externalId) {
          await this.externalIds.attach(kind, journalId, dto.externalId, trx);
        }
      }
    }
    await this.writeCompanions(journalId, prepared, trx, {
      keepLineIds: true,
    });
  }

  /**
   * Deletes a journal. Its external id stays held, so that a create carrying
   * it brings the journal back under the same id.
   */
  public async delete(journalId: number): Promise<void> {
    await this.rowOrThrow(journalId);
    const document = await this.documents.get(
      ExtRecordKind.ManualJournal,
      journalId,
    );
    await this.lock.assertOpen([document?.transactedAt]);

    const deleteJournal = await this.locator.resolve(
      DeleteManualJournalService,
    );

    await this.uow.withTransaction(async (trx) => {
      await this.rowOrThrow(journalId, trx);
      // Checked again where the closing instant can no longer change.
      await this.lock.assertOpen([document?.transactedAt], trx);
      const lines = await this.lines.list(
        ExtRecordKind.ManualJournalEntry,
        journalId,
        trx,
      );
      await deleteJournal.deleteManualJournal(journalId, trx);
      await this.externalIds.markDeleted(
        ExtRecordKind.ManualJournal,
        journalId,
        trx,
      );
      await this.documents.remove(ExtRecordKind.ManualJournal, journalId, trx);
      await this.metadata.remove(ExtRecordKind.ManualJournal, journalId, trx);
      await this.metadata.remove(
        ExtRecordKind.ManualJournalEntry,
        lines.map((line) => line.id),
        trx,
      );
      await this.tracking.removeLineLinks(
        lines.map((line) => line.id),
        trx,
      );
      await this.lines.remove(ExtRecordKind.ManualJournalEntry, journalId, trx);
    });
  }

  public async get(journalId: number): Promise<LedgerManualJournalView> {
    await this.rowOrThrow(journalId);
    return (await this.views([journalId])).get(journalId);
  }

  /**
   * Lists journals, oldest first by creation.
   */
  public async list(query: ListLedgerManualJournalsQueryDto): Promise<{
    data: LedgerManualJournalView[];
    pagination: { total: number; page: number; pageSize: number };
  }> {
    const page = Math.max(1, Number(query.page) || 1);
    const pageSize = Math.min(Math.max(1, Number(query.pageSize) || 50), 200);
    const knex = this.tenantKnex();

    const scope = () => {
      const builder = knex('manual_journals as j').leftJoin(
        'ext_documents as d',
        function joinDocument() {
          this.on('d.record_id', '=', 'j.id').andOn(
            'd.kind',
            '=',
            knex.raw('?', [ExtRecordKind.ManualJournal]),
          );
        },
      );
      if (query.from)
        builder.where('d.transacted_at', '>=', toInstant(query.from));
      if (query.to) builder.where('d.transacted_at', '<=', toInstant(query.to));
      if (query.externalIds !== undefined) {
        const externalIds = query.externalIds
          .split(',')
          .map((id) => id.trim())
          .filter(Boolean);

        builder.whereIn(
          'j.id',
          knex('ext_external_ids')
            .where({ kind: ExtRecordKind.ManualJournal, live: 1 })
            .whereIn('externalId', externalIds.length ? externalIds : [''])
            .select('recordId'),
        );
      }
      return builder;
    };
    const [{ total }] = await scope().count({ total: '*' });
    const rows = await scope()
      .orderBy('j.id', 'asc')
      .limit(pageSize)
      .offset((page - 1) * pageSize)
      .select('j.id');
    const ids = rows.map((row: any) => Number(row.id));
    const views = await this.views(ids);

    return {
      data: ids.map((id) => views.get(id)),
      pagination: { total: Number(total), page, pageSize },
    };
  }

  /**
   * Builds the journals of the given ids from Bigcapital's rows and the
   * extension's companion rows.
   */
  public async views(
    journalIds: number[],
  ): Promise<Map<number, LedgerManualJournalView>> {
    const views = new Map<number, LedgerManualJournalView>();
    if (journalIds.length === 0) return views;

    const knex = this.tenantKnex();
    const kind = ExtRecordKind.ManualJournal;
    const [journals, entries, externalIds, documents, metadata, lines, nodes] =
      await Promise.all([
        knex('manual_journals').whereIn('id', journalIds),
        knex('manual_journals_entries')
          .whereIn('manualJournalId', journalIds)
          .orderBy(['manualJournalId', 'index']),
        this.externalIds.findExternalIds(kind, journalIds),
        this.documents.getMany(kind, journalIds),
        this.metadata.getMany(kind, journalIds),
        this.lines.listMany(ExtRecordKind.ManualJournalEntry, journalIds),
        this.tree.list(),
      ]);
    const tracking = await this.tracking.ofLines(
      [...lines.values()].flatMap((list) => list.map((line) => line.id)),
    );
    const nodeById = new Map(nodes.map((node) => [node.accountId, node]));

    journals.forEach((journal: any) => {
      const id = Number(journal.id);
      const document = documents.get(id);
      const lineByIndex = new Map(
        (lines.get(id) ?? []).map((line) => [line.index, line]),
      );
      views.set(id, {
        id,
        externalId: externalIds.get(id) ?? null,
        journalNumber: journal.journalNumber,
        postedAt:
          document?.transactedAt ??
          `${String(journal.date).slice(0, 10)}T00:00:00.000Z`,
        description: journal.description ?? null,
        reference: journal.reference ?? null,
        createdBy: document?.createdBy ?? null,
        metadata: metadata.get(id) ?? null,
        entries: entries
          .filter((entry: any) => Number(entry.manualJournalId) === id)
          .map((entry: any) => {
            const line = lineByIndex.get(Number(entry.index));
            const node = nodeById.get(Number(entry.accountId));
            return {
              // The stable line id; Bigcapital's own entry id for a journal
              // the extension did not create.
              id: line?.id ?? Number(entry.id),
              externalId: line?.externalId ?? null,
              accountId: Number(entry.accountId),
              account: {
                id: Number(entry.accountId),
                code: node?.code ?? null,
                name: node?.name ?? null,
              },
              debit: fromThousandths(toThousandths(String(entry.debit ?? 0))),
              credit: fromThousandths(toThousandths(String(entry.credit ?? 0))),
              note: entry.note ?? null,
              tracking: (line ? (tracking.get(line.id) ?? []) : []).map(
                (t) => ({
                  id: t.id,
                  category: t.category,
                  option: t.option,
                  optionName: t.optionName,
                }),
              ),
            };
          }),
      });
    });
    return views;
  }

  /**
   * Checks journals and resolves what they name, before any transaction is
   * opened: balance, the lock, accounts, placeholder contacts and tracking.
   */
  private async prepare(
    dtos: LedgerManualJournalDto[],
  ): Promise<PreparedJournal[]> {
    const timezone = await this.lock.timezone();
    const instants = dtos.map((dto) => toInstant(dto.postedAt));

    const accountIds = [
      ...new Set(dtos.flatMap((dto) => dto.entries.map((e) => e.accountId))),
    ];
    const knex = this.tenantKnex();
    const [accounts, nodes] = await Promise.all([
      knex('accounts').whereIn('id', accountIds).select('id', 'slug'),
      this.tree.list(),
    ]);
    const presented = new Set(nodes.map((node) => node.accountId));
    const slugById = new Map(
      accounts.map((account: any) => [Number(account.id), account.slug]),
    );
    const missing = accountIds.filter(
      (id) => !slugById.has(id) || !presented.has(id),
    );
    if (missing.length > 0) {
      throw new ServiceError(
        ACCOUNT_ERRORS.ACCOUNT_NOT_FOUND,
        'An account of the journal was not found.',
        { accountIds: missing },
        HttpStatus.NOT_FOUND,
      );
    }
    // Refusals come in this order: an account not found, debits that differ
    // from credits, then a closed period.
    dtos.forEach((dto) => this.assertBalanced(dto));
    await this.lock.assertOpen(instants);

    // A line on the receivable or payable account must name a contact in
    // Bigcapital. A journal names none, so the placeholders stand in.
    const [placeholderCustomerId, placeholderVendorId] = await Promise.all([
      this.settings.get<number>(WORKSPACE_SETTINGS.PLACEHOLDER_CUSTOMER_ID),
      this.settings.get<number>(WORKSPACE_SETTINGS.PLACEHOLDER_VENDOR_ID),
    ]);
    const contactOf = (accountId: number): number | undefined => {
      const slug = slugById.get(accountId);
      if (slug === 'accounts-receivable')
        return placeholderCustomerId ?? undefined;
      if (slug === 'accounts-payable') return placeholderVendorId ?? undefined;
      return undefined;
    };
    const resolvedTracking = await this.tracking.resolve(
      dtos.flatMap((dto) =>
        dto.entries.flatMap((entry) => entry.tracking ?? []),
      ),
    );

    return dtos.map((dto, i) => ({
      dto,
      postedAt: instants[i],
      date: toLocalDay(instants[i], timezone),
      entries: dto.entries.map((entry, index) => ({
        index: index + 1,
        accountId: entry.accountId,
        debit: Number(entry.debit),
        credit: Number(entry.credit),
        note: entry.note,
        contactId: contactOf(entry.accountId),
        trackingCategories: (entry.tracking ?? []).map((t) =>
          resolvedTracking.get(this.tracking.key(t)),
        ),
      })),
    }));
  }

  /**
   * Debits must equal credits exactly, and each line is a debit or a credit.
   * Bigcapital compares totals rounded to two decimals; this is exact.
   */
  private assertBalanced(dto: LedgerManualJournalDto) {
    let debits = 0n;
    let credits = 0n;

    dto.entries.forEach((entry, index) => {
      const debit = toThousandths(entry.debit);
      const credit = toThousandths(entry.credit);

      if (debit !== 0n && credit !== 0n) {
        throw new ServiceError(
          JOURNAL_ERRORS.CREDIT_DEBIT_NOT_EQUAL,
          'A journal line is either a debit or a credit, not both.',
          { index: index + 1 },
        );
      }
      debits += debit;
      credits += credit;
    });
    if (debits !== credits) {
      throw new ServiceError(
        JOURNAL_ERRORS.CREDIT_DEBIT_NOT_EQUAL,
        `Credits (${fromThousandths(credits)}) and debits (${fromThousandths(debits)}) must balance.`,
      );
    }
  }

  private toBigcapitalDto(prepared: PreparedJournal, journalNumber: string) {
    return {
      date: prepared.date,
      journalNumber,
      reference: prepared.dto.reference,
      description: prepared.dto.description,
      publish: true,
      entries: prepared.entries,
    };
  }

  /**
   * Creates the journal, under the id of a deleted journal when it is one
   * being brought back.
   */
  private async createInTransaction(
    prepared: PreparedJournal,
    number: number,
    trx: Knex.Transaction,
    asId?: number,
  ): Promise<number> {
    // Checked again where the closing instant can no longer change.
    await this.lock.assertOpen([prepared.postedAt], trx);

    const createJournal = await this.locator.resolve(
      CreateManualJournalService,
    );
    const journal = await createJournal.makeJournalEntries(
      this.toBigcapitalDto(
        prepared,
        `JE-${String(number).padStart(6, '0')}`,
      ) as any,
      trx,
    );
    const journalId = asId ?? journal.id;

    if (journalId !== journal.id) {
      // Ids are issued in rising order and never again, so the old id is free.
      // The entries refer to their journal by a foreign key, so the journal
      // is copied to the old id before they are moved to it.
      const row = await trx('manual_journals')
        .where({ id: journal.id })
        .first();
      await trx('manual_journals').insert({ ...row, id: journalId });
      await trx('manual_journals_entries')
        .where({ manualJournalId: journal.id })
        .update({ manualJournalId: journalId });
      await trx('manual_journals').where({ id: journal.id }).delete();
      await trx('accounts_transactions')
        .where({ referenceType: 'Journal', referenceId: journal.id })
        .update({ referenceId: journalId });
    }
    await this.writeCompanions(journalId, prepared, trx, {
      keepLineIds: false,
    });
    return journalId;
  }

  /**
   * Writes the extension's rows of a journal: its instant, its metadata, and
   * a stable line for each entry.
   */
  private async writeCompanions(
    journalId: number,
    prepared: PreparedJournal,
    trx: Knex.Transaction,
    options: { keepLineIds: boolean },
  ): Promise<void> {
    const { dto } = prepared;

    await this.ledgerRows.rememberPosted(
      prepared.entries.map((entry) => entry.accountId),
      trx,
    );
    await this.documents.upsert(
      ExtRecordKind.ManualJournal,
      journalId,
      {
        transactedAt: prepared.postedAt,
        ...(dto.createdBy !== undefined ? { createdBy: dto.createdBy } : {}),
      },
      trx,
    );
    await this.metadata.set(
      ExtRecordKind.ManualJournal,
      journalId,
      dto.metadata,
      trx,
    );

    const entries = await trx('manual_journals_entries')
      .where({ manualJournalId: journalId })
      .orderBy('index');
    const before = await this.lines.list(
      ExtRecordKind.ManualJournalEntry,
      journalId,
      trx,
    );
    const existing = options.keepLineIds ? before : [];
    const existingByIndex = new Map(existing.map((line) => [line.index, line]));

    const stored = await this.lines.replace(
      ExtRecordKind.ManualJournalEntry,
      journalId,
      dto.entries.map((entry, i) => ({
        // A line keeps its id when its position is unchanged.
        id: existingByIndex.get(i + 1)?.id,
        entryId: Number(entries[i]?.id) || null,
        externalId: entry.externalId ?? null,
      })),
      trx,
    );
    const storedIds = new Set(stored.map((line) => line.id));

    await this.tracking.removeLineLinks(
      before.map((line) => line.id).filter((id) => !storedIds.has(id)),
      trx,
    );
    await this.tracking.syncJournalLinks(stored, trx);
  }

  /**
   * Reads Bigcapital's row of a journal. Inside a transaction the row is
   * locked, so that two writes to one journal run one after the other:
   * Bigcapital replaces a journal's ledger rows by deleting and inserting,
   * and two edits at once would each insert theirs.
   */
  private async rowOrThrow(
    journalId: number,
    trx?: Knex.Transaction,
  ): Promise<any> {
    let row = null;

    if (Number.isInteger(journalId)) {
      const query = (trx ?? this.tenantKnex())('manual_journals')
        .where({ id: journalId })
        .first();
      row = await (trx ? query.forUpdate() : query);
    }
    if (!row) {
      throw new ServiceError(
        JOURNAL_ERRORS.NOT_FOUND,
        'The manual journal was not found.',
        { journalId },
        HttpStatus.NOT_FOUND,
      );
    }
    return row;
  }
}
