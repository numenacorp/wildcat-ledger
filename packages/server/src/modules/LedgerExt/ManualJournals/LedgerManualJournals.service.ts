import { Knex } from 'knex';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ServiceError } from '@/modules/Items/ServiceError';
import { TENANCY_DB_CONNECTION } from '@/modules/Tenancy/TenancyDB/TenancyDB.constants';
import { CreateManualJournalService } from '@/modules/ManualJournals/commands/CreateManualJournal.service';
import { EditManualJournal } from '@/modules/ManualJournals/commands/EditManualJournal.service';
import { DeleteManualJournalService } from '@/modules/ManualJournals/commands/DeleteManualJournal.service';
import { ERRORS as JOURNAL_ERRORS } from '@/modules/ManualJournals/constants';
import { ExtAuditService } from '../common/ExtAudit.service';
import { ExtUnitOfWork } from '../common/ExtUnitOfWork.service';
import { ExternalIdsService } from '../common/ExternalIds.service';
import { ExtMetadataService } from '../common/ExtMetadata.service';
import { ExtDocumentsService } from '../common/ExtDocuments.service';
import { ExtLinesService } from '../common/ExtLines.service';
import { ExtSequencesService } from '../common/ExtSequences.service';
import { ExtServiceLocator } from '../common/ExtServiceLocator.service';
import { LedgerRowsService } from '../common/LedgerRows.service';
import { fromThousandths, toThousandths } from '../common/decimal';
import { toPlainDate } from '../common/timestamps';
import {
  raiseVersion,
  refusingStale,
  requireVersion,
} from '../common/versions';
import { ERRORS, ExtRecordKind } from '../LedgerExt.constants';
import { ExtAccountTreeService } from '../Accounts/ExtAccountTree.service';
import { ACCOUNT_ERRORS } from '../Accounts/LedgerAccounts.constants';
import { ExtLockService } from '../Lock/ExtLock.service';
import {
  ExtTrackingService,
  TrackingAssignment,
} from '../Tracking/ExtTracking.service';
import { LedgerAccountsService } from '../Accounts/LedgerAccounts.service';
import { ExtPartiesService } from '../Trade/ExtParties.service';
import {
  LedgerManualJournalDto,
  ListLedgerManualJournalsQueryDto,
} from './LedgerManualJournal.dto';

const SEQUENCE = 'manual_journal';

/** Journals written in a transaction, each with the id of its audit row. */
type Logged = Array<[journalId: number, auditId: number]>;

export const LEDGER_JOURNAL_ERRORS = {
  /** A line to the receivable account names no customer, or one to the payable account no vendor. */
  JOURNAL_LINE_PARTY_REQUIRED: 'JOURNAL_LINE_PARTY_REQUIRED',
  /** A line names both a customer and a vendor. */
  JOURNAL_LINE_NAMES_ONE_PARTY: 'JOURNAL_LINE_NAMES_ONE_PARTY',
};

export interface LedgerManualJournalView {
  id: number;
  externalId: string | null;
  /** Raised by every edit of the journal. */
  version: number;
  journalNumber: string;
  postedOn: string;
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
    /** The customer or the vendor the line names; one at most. */
    customerId: number | null;
    customerExternalId: string | null;
    vendorId: number | null;
    vendorExternalId: string | null;
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
  postedOn: string;
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
    private readonly sequences: ExtSequencesService,
    private readonly tree: ExtAccountTreeService,
    private readonly tracking: ExtTrackingService,
    private readonly lock: ExtLockService,
    private readonly locator: ExtServiceLocator,
    private readonly ledgerRows: LedgerRowsService,
    private readonly accounts: LedgerAccountsService,
    private readonly parties: ExtPartiesService,
    private readonly audit: ExtAuditService,
  ) {}

  /**
   * Adds to the audit rows of journals just written what each journal
   * became, once their transaction has committed.
   */
  private async finishAudit(logged: Logged): Promise<void> {
    if (logged.length === 0) return;
    const views = await this.views(logged.map(([journalId]) => journalId));

    for (const [journalId, auditId] of logged) {
      await this.audit.finish(auditId, views.get(journalId) ?? null);
    }
  }

  /** What the journal holding an external id is now, for a conflict's answer. */
  private describe = async (journalId: number) => ({
    state: 'live' as const,
    version:
      (await this.documents.get(ExtRecordKind.ManualJournal, journalId))
        ?.version ?? 1,
  });

  /**
   * Creates a journal. A create carrying the external id of an existing
   * journal is a retry when its body is the one the journal was made with,
   * and is answered with the journal; otherwise, and for the id of a deleted
   * journal, it is refused.
   * @throws {ServiceError} EXTERNAL_ID_IN_USE
   */
  public async create(dto: LedgerManualJournalDto): Promise<{
    journal: LedgerManualJournalView;
    created: boolean;
    replayed: boolean;
  }> {
    const kind = ExtRecordKind.ManualJournal;
    const { version: _version, ...body } = dto;

    if (dto.externalId) {
      // A repeat is answered before anything about the body is checked: a
      // retry must not fail on what has changed since, a lock above all.
      const held = await this.externalIds.findRecordId(kind, dto.externalId);

      if (held !== null) {
        await this.externalIds.createOnce({
          kind,
          externalId: dto.externalId,
          body,
          describe: this.describe,
          create: async () => held,
          read: async (id) => id,
        });
        return {
          journal: await this.get(held),
          created: false,
          replayed: true,
        };
      }
    }
    const [prepared] = await this.prepare([dto]);
    const number = await this.sequences.next(SEQUENCE);

    const logged: Logged = [];
    const { recordId, created, replayed } = await this.externalIds.createOnce({
      kind,
      externalId: dto.externalId,
      body,
      describe: this.describe,
      create: (trx) => {
        logged.length = 0;
        return this.createInTransaction(prepared, number, trx, logged);
      },
      read: async (id) => id,
    });
    // When lost to a simultaneous create of the same id and body, nothing was written.
    if (created) await this.finishAudit(logged);
    return { journal: await this.get(recordId), created, replayed };
  }

  /**
   * Creates several journals in one transaction: all of them, or none. A
   * journal whose external id already exists is answered as on a single
   * create: with the journal when the body is the same, and otherwise with a
   * refusal, which refuses the whole request.
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
    // A repeat is answered before anything about its body is checked, as on
    // a single create: a retry must not fail on what has changed since, a
    // lock above all. A repeat with another body refuses the whole request.
    const heldIds = new Map<number, number>();
    for (let i = 0; i < dtos.length; i += 1) {
      const { version: _version, ...body } = dtos[i];
      if (!body.externalId) continue;

      const held = await this.externalIds.findRecordId(kind, body.externalId);
      if (held === null) continue;

      await this.externalIds.createOnce({
        kind,
        externalId: body.externalId,
        body,
        describe: this.describe,
        create: async () => held,
        read: async (id) => id,
      });
      heldIds.set(i, held);
    }
    const fresh = dtos
      .map((dto, i) => ({ dto, i }))
      .filter(({ i }) => !heldIds.has(i));
    const prepared = await this.prepare(fresh.map(({ dto }) => dto));
    const firstNumber =
      prepared.length > 0
        ? await this.sequences.next(SEQUENCE, prepared.length)
        : 0;

    const logged: Logged = [];
    const madeIds = await this.uow.withTransaction(async (trx) => {
      const written: number[] = [];
      // The work may run again after a deadlock: its log starts over with it.
      logged.length = 0;

      for (let i = 0; i < prepared.length; i += 1) {
        const { externalId } = prepared[i].dto;
        const number = firstNumber + i;

        const { version: _version, ...body } = prepared[i].dto;
        const { recordId } = await this.externalIds.createOnce({
          kind,
          externalId,
          body,
          describe: this.describe,
          create: (innerTrx) =>
            this.createInTransaction(prepared[i], number, innerTrx, logged),
          read: async (id) => id,
          trx,
        });
        written.push(recordId);
      }
      return written;
    });
    await this.finishAudit(logged);
    // Each journal in the place it was sent in.
    const ids = dtos.map((_dto, i) =>
      heldIds.has(i)
        ? heldIds.get(i)
        : madeIds[fresh.findIndex((entry) => entry.i === i)],
    );
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
    const version = requireVersion(dto.version);
    const [prepared] = await this.prepare(
      [dto],
      await this.tracking.carriedBy(
        ExtRecordKind.ManualJournalEntry,
        journalId,
      ),
    );

    const logged: Logged = [];
    await refusingStale(
      () =>
        this.uow.withTransaction((trx) => {
          logged.length = 0;
          return this.editInTransaction(
            journalId,
            prepared,
            trx,
            version,
            logged,
          );
        }),
      () => this.get(journalId),
    );
    await this.finishAudit(logged);
    return this.get(journalId);
  }

  private async editInTransaction(
    journalId: number,
    prepared: PreparedJournal,
    trx: Knex.Transaction,
    version: number,
    logged?: Logged,
  ): Promise<void> {
    const kind = ExtRecordKind.ManualJournal;
    const { dto } = prepared;
    const old = await this.rowOrThrow(journalId, trx);
    await this.raise(journalId, version, trx);
    const oldDocument = await this.documents.get(kind, journalId, trx);
    // Read outside the transaction, so as it stood before this edit.
    const before = (await this.views([journalId])).get(journalId) ?? null;

    // The journal as it stands must be open too: an edit cannot move a
    // journal out of the closed period.
    await this.lock.assertOpen(
      [oldDocument?.transactedOn, prepared.postedOn],
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
      // An external id is the journal's for ever: an edit may give one to
      // a journal that has none, and may not change or remove one.
      if (current === null && dto.externalId) {
        await this.externalIds.attach(kind, journalId, dto.externalId, trx);
      } else if (current !== null && current !== (dto.externalId ?? null)) {
        throw new ServiceError(
          ERRORS.EXTERNAL_ID_FIXED,
          'The external id of a record cannot be changed or removed.',
          { externalId: current },
        );
      }
    }
    // The body the journal now holds is the one a repeat of its external id
    // is a retry of.
    const { version: _version, ...held } = dto;
    await this.externalIds.rehash(
      kind,
      journalId,
      (externalId) => ({ ...held, externalId }),
      trx,
    );
    await this.writeCompanions(journalId, prepared, trx, {
      keepLineIds: true,
    });
    const auditId = await this.audit.record(
      {
        action: 'edit',
        subject: kind,
        subjectId: journalId,
        number: old.journalNumber ?? null,
        before,
      },
      trx,
    );
    logged?.push([journalId, auditId]);
  }

  /**
   * Checks the version an edit or a delete names against the journal's, and
   * raises it. A journal Bigcapital made has no row of the extension's yet:
   * one is made for it, at version 1.
   */
  private async raise(
    journalId: number,
    version: number,
    trx: Knex.Transaction,
  ): Promise<void> {
    const kind = ExtRecordKind.ManualJournal;

    await this.documents.upsert(kind, journalId, {}, trx);
    await raiseVersion(
      trx,
      'ext_documents',
      { kind, recordId: journalId },
      version,
    );
  }

  /**
   * Deletes a journal. Its external id stays its own: it is not used again.
   */
  public async delete(
    journalId: number,
    expected?: number | string | null,
  ): Promise<void> {
    await this.rowOrThrow(journalId);
    const version = requireVersion(expected);
    const document = await this.documents.get(
      ExtRecordKind.ManualJournal,
      journalId,
    );
    await this.lock.assertOpen([document?.transactedOn]);
    // The journal as it stood, kept by the log: once deleted it is read no more.
    const before = (await this.views([journalId])).get(journalId) ?? null;

    const deleteJournal = await this.locator.resolve(
      DeleteManualJournalService,
    );

    await refusingStale(
      () =>
        this.uow.withTransaction(async (trx) => {
          await this.rowOrThrow(journalId, trx);
          await this.raise(journalId, version, trx);
          // Checked again where the closing instant can no longer change.
          await this.lock.assertOpen([document?.transactedOn], trx);
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
          await this.documents.remove(
            ExtRecordKind.ManualJournal,
            journalId,
            trx,
          );
          await this.metadata.remove(
            ExtRecordKind.ManualJournal,
            journalId,
            trx,
          );
          await this.metadata.remove(
            ExtRecordKind.ManualJournalEntry,
            lines.map((line) => line.id),
            trx,
          );
          await this.tracking.removeLineLinks(
            lines.map((line) => line.id),
            trx,
          );
          await this.lines.remove(
            ExtRecordKind.ManualJournalEntry,
            journalId,
            trx,
          );
          await this.audit.record(
            {
              action: 'delete',
              subject: ExtRecordKind.ManualJournal,
              subjectId: journalId,
              number: before?.journalNumber ?? null,
              before,
            },
            trx,
          );
        }),
      () => this.get(journalId),
    );
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
        builder.where('d.transacted_on', '>=', toPlainDate(query.from));
      if (query.to)
        builder.where('d.transacted_on', '<=', toPlainDate(query.to));
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
    // The placeholder contact of an older journal is no party, and shows
    // as none.
    const contactIds = [
      ...new Set(
        entries
          .map((entry: any) => entry.contactId)
          .filter((id: unknown) => id !== null && id !== undefined)
          .map(Number),
      ),
    ];
    const partyKindOf = await this.parties.kindsOf(contactIds);
    const idsOfKind = (kind: ExtRecordKind) =>
      contactIds.filter((id) => partyKindOf.get(id) === kind);
    const [customerExternalIds, vendorExternalIds] = await Promise.all([
      this.externalIds.findExternalIds(
        ExtRecordKind.Customer,
        idsOfKind(ExtRecordKind.Customer),
      ),
      this.externalIds.findExternalIds(
        ExtRecordKind.Vendor,
        idsOfKind(ExtRecordKind.Vendor),
      ),
    ]);

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
        postedOn: document?.transactedOn ?? String(journal.date).slice(0, 10),
        version: document?.version ?? 1,
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
              customerId:
                partyKindOf.get(Number(entry.contactId)) ===
                ExtRecordKind.Customer
                  ? Number(entry.contactId)
                  : null,
              customerExternalId:
                customerExternalIds.get(Number(entry.contactId)) ?? null,
              vendorId:
                partyKindOf.get(Number(entry.contactId)) ===
                ExtRecordKind.Vendor
                  ? Number(entry.contactId)
                  : null,
              vendorExternalId:
                vendorExternalIds.get(Number(entry.contactId)) ?? null,
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
   * opened: accounts, balance, the lock, the party of each line and tracking.
   */
  private async prepare(
    dtos: LedgerManualJournalDto[],
    carried: Array<{ category: string; option: string }> = [],
  ): Promise<PreparedJournal[]> {
    const days = dtos.map((dto) => toPlainDate(dto.postedOn));

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
    // Refusals come in this order: an account not found, one that takes no
    // line, debits that differ from credits, a closed period, then a line
    // that does not name its party.
    await this.accounts.assertPostable(accountIds);
    dtos.forEach((dto) => this.assertBalanced(dto));
    await this.lock.assertOpen(days);

    // What is owed by customers and to vendors is kept party by party, so a
    // line on the receivable account names its customer and a line on the
    // payable account its vendor.
    // A party is named by its id or by the caller's own id of it.
    const named = (value: unknown): boolean =>
      value !== null && value !== undefined;
    const customerIds = new Set<number>();
    const vendorIds = new Set<number>();
    const customerExternalIds = new Set<string>();
    const vendorExternalIds = new Set<string>();

    dtos.forEach((dto) =>
      dto.entries.forEach((entry, index) => {
        const slug = slugById.get(entry.accountId);
        const refuse = (type: string, message: string) => {
          throw new ServiceError(type, message, {
            index: index + 1,
            accountId: entry.accountId,
          });
        };
        const customer =
          named(entry.customerId) || named(entry.customerExternalId);
        const vendor = named(entry.vendorId) || named(entry.vendorExternalId);

        if (
          (customer && vendor) ||
          (named(entry.customerId) && named(entry.customerExternalId)) ||
          (named(entry.vendorId) && named(entry.vendorExternalId))
        ) {
          refuse(
            LEDGER_JOURNAL_ERRORS.JOURNAL_LINE_NAMES_ONE_PARTY,
            'A journal line names one party, a customer or a vendor, and names it once.',
          );
        }
        if (slug === 'accounts-receivable' && !customer) {
          refuse(
            LEDGER_JOURNAL_ERRORS.JOURNAL_LINE_PARTY_REQUIRED,
            'A journal line to the receivable account names its customer.',
          );
        }
        if (slug === 'accounts-payable' && !vendor) {
          refuse(
            LEDGER_JOURNAL_ERRORS.JOURNAL_LINE_PARTY_REQUIRED,
            'A journal line to the payable account names its vendor.',
          );
        }
        if (named(entry.customerId)) customerIds.add(entry.customerId);
        if (named(entry.vendorId)) vendorIds.add(entry.vendorId);
        if (named(entry.customerExternalId)) {
          customerExternalIds.add(entry.customerExternalId);
        }
        if (named(entry.vendorExternalId)) {
          vendorExternalIds.add(entry.vendorExternalId);
        }
      }),
    );
    for (const id of customerIds) {
      await this.parties.get(ExtRecordKind.Customer, id);
    }
    for (const id of vendorIds) {
      await this.parties.get(ExtRecordKind.Vendor, id);
    }
    const customerIdOf = new Map<string, number>();
    const vendorIdOf = new Map<string, number>();

    for (const externalId of customerExternalIds) {
      const id = await this.parties.findByExternalId(
        ExtRecordKind.Customer,
        externalId,
      );
      if (id === null) {
        this.parties.notFound(ExtRecordKind.Customer, { externalId });
      }
      customerIdOf.set(externalId, id);
    }
    // A vendor named by an id not seen before is made, as a bill makes one.
    // It is made before the journal's transaction opens: Bigcapital checks a
    // line's contact outside that transaction and would not see it.
    for (const externalId of vendorExternalIds) {
      vendorIdOf.set(
        externalId,
        await this.uow.withTransaction((trx) =>
          this.parties.ensure(ExtRecordKind.Vendor, externalId, trx),
        ),
      );
    }
    const contactOf = (entry: LedgerManualJournalDto['entries'][number]) =>
      entry.customerId ??
      entry.vendorId ??
      (named(entry.customerExternalId)
        ? customerIdOf.get(entry.customerExternalId)
        : undefined) ??
      (named(entry.vendorExternalId)
        ? vendorIdOf.get(entry.vendorExternalId)
        : undefined) ??
      undefined;
    const resolvedTracking = await this.tracking.resolve(
      dtos.flatMap((dto) =>
        dto.entries.flatMap((entry) => entry.tracking ?? []),
      ),
      carried,
    );

    return dtos.map((dto, i) => ({
      dto,
      postedOn: days[i],
      date: days[i],
      entries: dto.entries.map((entry, index) => ({
        index: index + 1,
        accountId: entry.accountId,
        debit: Number(entry.debit),
        credit: Number(entry.credit),
        note: entry.note,
        contactId: contactOf(entry),
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

  private async createInTransaction(
    prepared: PreparedJournal,
    number: number,
    trx: Knex.Transaction,
    logged?: Logged,
  ): Promise<number> {
    // Checked again where the closing instant can no longer change.
    await this.lock.assertOpen([prepared.postedOn], trx);

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
    const journalId = journal.id;

    await this.writeCompanions(journalId, prepared, trx, {
      keepLineIds: false,
    });
    const auditId = await this.audit.record(
      {
        action: 'create',
        subject: ExtRecordKind.ManualJournal,
        subjectId: journalId,
        number: `JE-${String(number).padStart(6, '0')}`,
      },
      trx,
    );
    logged?.push([journalId, auditId]);
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
        transactedOn: prepared.postedOn,
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
