import { Knex } from 'knex';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ServiceError } from '@/modules/Items/ServiceError';
import { TENANCY_DB_CONNECTION } from '@/modules/Tenancy/TenancyDB/TenancyDB.constants';
import { chunks } from '../common/chunks';
import { ExtUnitOfWork } from '../common/ExtUnitOfWork.service';
import { ExternalIdsService } from '../common/ExternalIds.service';
import { ExtMetadataService } from '../common/ExtMetadata.service';
import { ExtLinesService } from '../common/ExtLines.service';
import { ExtSequencesService } from '../common/ExtSequences.service';
import { fromCents, lineCents, toCents } from '../common/money';
import {
  POSTING_ERRORS,
  POSTING_MAX_CENTS,
} from '../common/LedgerPostings.service';
import { toInstant } from '../common/timestamps';
import {
  LedgerAccountBrief,
  LedgerAccountsService,
} from '../Accounts/LedgerAccounts.service';
import { ExtLockService } from '../Lock/ExtLock.service';
import {
  ExtTrackingService,
  TrackingAssignment,
  TrackingInput,
} from '../Tracking/ExtTracking.service';
import { ExtPartiesService, PartyKind, PartyView } from './ExtParties.service';
import {
  ALLOCATIONS_TABLE,
  DOCUMENTS_TABLE,
  PAYMENTS_TABLE,
  TradeLedgerService,
} from './TradeLedger.service';
import {
  TradePaymentView,
  TradePaymentViewsService,
  toIso,
} from './TradePaymentViews.service';
import { TradeConfig } from './trade.config';
import {
  DOCUMENT_LIST_MAX_PAGE_SIZE,
  DocumentStatus,
  TRADE_ERRORS,
  documentStatus,
} from './trade.constants';

const DUE_ON_RECEIPT = 'due_on_receipt';
const NUMBER_SEQUENCE = 'trade_document_number';

/** A bill or an invoice as a caller sends it, in neither's words. */
export interface TradeDocumentInput {
  externalId?: string | null;
  partyId?: number | null;
  partyExternalId?: string | null;
  postedAt: string;
  dueAt?: string | null;
  terms?: string | null;
  reference?: string | null;
  note?: string | null;
  number?: string | null;
  metadata?: Record<string, unknown> | null;
  entries?: Array<{
    externalId?: string | null;
    accountId: number;
    item?: string | null;
    description?: string | null;
    rate: string;
    quantity?: string | null;
    metadata?: Record<string, unknown> | null;
    tracking?: TrackingInput[];
  }>;
}

export interface TradeDocumentListQuery {
  status?: string;
  externalId?: string;
  partyId?: string | number;
  from?: string;
  to?: string;
  page?: string | number;
  pageSize?: string | number;
}

/** A bill or an invoice as it is answered, in neither's words. */
export interface TradeDocumentView {
  id: number;
  externalId: string | null;
  status: DocumentStatus;
  postedAt: string;
  dueAt: string | null;
  terms: string | null;
  /** The latest payment's instant, once nothing is owed. */
  paidAt: string | null;
  voidedAt: string | null;
  number: string | null;
  reference: string | null;
  note: string | null;
  metadata: Record<string, unknown> | null;
  amount: string;
  balance: string;
  party: PartyView | null;
  entries: Array<{
    id: number;
    externalId: string | null;
    accountId: number;
    account: LedgerAccountBrief | null;
    item: string | null;
    description: string | null;
    rate: string;
    quantity: string;
    amount: string;
    metadata: Record<string, unknown> | null;
    tracking: Array<{
      id: number;
      category: string;
      option: string;
      optionName: string;
    }>;
  }>;
  payments: Array<{
    id: number;
    paymentId: number;
    amount: string;
    payment: TradePaymentView;
  }>;
  createdAt: string | null;
  updatedAt: string | null;
}

/** A document checked and priced, before its transaction opens. */
interface PreparedDocument {
  input: TradeDocumentInput;
  postedAt: string;
  dueAt: string | null;
  amount: bigint;
  /** The party when it is already known; otherwise it is made on sight. */
  partyId: number | null;
  lines: Array<{
    externalId: string | null;
    accountId: number;
    item: string | null;
    description: string | null;
    rate: string;
    quantity: string;
    cents: bigint;
    metadata: Record<string, unknown> | null;
    tracking: TrackingAssignment[];
  }>;
}

/**
 * Bills and invoices: what a party is owed or owes, line by line, each line
 * to an account.
 *
 * A document is never deleted: voiding takes its entry out of the books and
 * leaves the document. Where a bill and an invoice follow different rules,
 * the rule is in the `TradeConfig` each call is given.
 */
@Injectable()
export class TradeDocumentsService {
  constructor(
    @Inject(TENANCY_DB_CONNECTION)
    private readonly tenantKnex: () => Knex,
    private readonly uow: ExtUnitOfWork,
    private readonly externalIds: ExternalIdsService,
    private readonly metadata: ExtMetadataService,
    private readonly lines: ExtLinesService,
    private readonly sequences: ExtSequencesService,
    private readonly accounts: LedgerAccountsService,
    private readonly tracking: ExtTrackingService,
    private readonly lock: ExtLockService,
    private readonly parties: ExtPartiesService,
    private readonly ledger: TradeLedgerService,
    private readonly paymentViews: TradePaymentViewsService,
  ) {}

  /**
   * Creates a document. A create carrying the external id of an existing
   * document replaces it with the one given, under the rules of an edit.
   */
  public async create(
    config: TradeConfig,
    input: TradeDocumentInput,
  ): Promise<{ document: TradeDocumentView; created: boolean }> {
    const replace = async (id: number) => ({
      document: await this.edit(config, id, input, { repeat: true }),
      created: false,
    });
    if (input.externalId) {
      const existingId = await this.externalIds.findRecordId(
        config.documentKind,
        input.externalId,
      );
      if (existingId !== null) return replace(existingId);
    }
    const prepared = await this.prepare(config, input);
    await this.lock.assertOpen([prepared.postedAt]);

    const number = config.numbered
      ? (input.number ??
        `INV-${String(await this.sequences.next(NUMBER_SEQUENCE)).padStart(6, '0')}`)
      : null;
    const { recordId, created } = await this.externalIds.createOnce({
      kind: config.documentKind,
      externalId: input.externalId,
      create: (trx) => this.write(config, null, prepared, number, trx),
      read: async (id) => id,
    });
    // Lost to a simultaneous create of the same external id: replace it.
    if (!created) return replace(recordId);

    return { document: await this.get(config, recordId), created };
  }

  /**
   * Replaces a document with the one given. Its id is kept, and so is the id
   * of each line that carries the external id of a line it already had.
   */
  public async edit(
    config: TradeConfig,
    documentId: number,
    input: TradeDocumentInput,
    options: { repeat?: boolean } = {},
  ): Promise<TradeDocumentView> {
    const old = await this.rowOrThrow(config, documentId);

    // A repeated create may give a voided document a new body; an edit by
    // id may not, where the rule says so.
    if (old.voidedAt && !config.voidedEditable && !options.repeat) {
      throw new ServiceError(
        TRADE_ERRORS.INVOICE_VOIDED,
        `The ${config.nouns.document} is voided and cannot be edited.`,
        { [config.idKeys.document]: documentId },
      );
    }
    const prepared = await this.prepare(config, input);

    await this.uow.withTransaction((trx) =>
      this.write(config, documentId, prepared, input.number ?? null, trx),
    );
    return this.get(config, documentId);
  }

  /**
   * Voids a document: its entry leaves the books and the document stays.
   * Voiding a voided document changes nothing.
   */
  public async void(
    config: TradeConfig,
    documentId: number,
  ): Promise<TradeDocumentView> {
    await this.rowOrThrow(config, documentId);

    await this.uow.withTransaction(async (trx) => {
      const document = await this.rowOrThrow(config, documentId, trx);
      if (document.voidedAt) return;

      if ((await this.ledger.paidOn(config, documentId, trx)) > 0n) {
        throw new ServiceError(
          config.errors.hasPayments,
          `The ${config.nouns.document} has payments and cannot be voided.`,
          { [config.idKeys.document]: documentId },
        );
      }
      await this.lock.assertOpen([document.postedAt], trx);
      await trx(DOCUMENTS_TABLE).where({ id: documentId }).update({
        voidedAt: new Date().toISOString(),
        updatedAt: trx.fn.now(),
      });
      await this.ledger.postDocument(config, documentId, trx);
    });
    return this.get(config, documentId);
  }

  public async get(
    config: TradeConfig,
    documentId: number,
  ): Promise<TradeDocumentView> {
    await this.rowOrThrow(config, documentId);
    return (await this.views(config, [documentId])).get(documentId);
  }

  /**
   * Lists documents by their instant, oldest first, voided ones included.
   */
  public async list(
    config: TradeConfig,
    query: TradeDocumentListQuery,
  ): Promise<{
    data: TradeDocumentView[];
    pagination: { total: number; page: number; pageSize: number };
  }> {
    const page = Math.max(1, Number(query.page) || 1);
    const pageSize = Math.min(
      Math.max(1, Number(query.pageSize) || 50),
      DOCUMENT_LIST_MAX_PAGE_SIZE,
    );
    const knex = this.tenantKnex();
    const statuses = query.status ? query.status.split(',') : null;

    const scope = () => {
      const paid = knex(`${ALLOCATIONS_TABLE} as a`)
        .join(`${PAYMENTS_TABLE} as p`, 'p.id', 'a.payment_id')
        .whereRaw('?? = ??', ['a.document_id', 'd.id'])
        .whereNull('p.deleted_at')
        .select(knex.raw('COALESCE(SUM(??), 0)', ['a.amount']));
      const documents = knex(`${DOCUMENTS_TABLE} as d`)
        .where('d.kind', config.documentKind)
        .select(
          'd.id as id',
          'd.posted_at as postedAt',
          'd.amount as amount',
          'd.voided_at as voidedAt',
          paid.as('paid'),
        );
      if (query.from)
        documents.where('d.posted_at', '>=', toInstant(query.from));
      if (query.to) documents.where('d.posted_at', '<=', toInstant(query.to));
      if (query.partyId !== undefined) {
        documents.where('d.party_id', Number(query.partyId));
      }
      if (query.externalId !== undefined) {
        documents.whereIn(
          'd.id',
          knex('ext_external_ids')
            .where({
              kind: config.documentKind,
              live: 1,
              externalId: query.externalId,
            })
            .whereNull('deletedAt')
            .select('recordId'),
        );
      }
      const listed = knex.from(documents.as('x'));

      if (statuses) {
        // The same rule as `documentStatus`.
        listed.whereIn(
          knex.raw(
            `CASE WHEN ?? IS NOT NULL THEN 'voided'
                  WHEN ?? = 0 OR (?? > 0 AND ?? - ?? = 0) THEN 'paid'
                  WHEN ?? > 0 THEN 'partially_paid'
                  ELSE 'open' END`,
            [
              'x.voidedAt',
              'x.amount',
              'x.amount',
              'x.amount',
              'x.paid',
              'x.paid',
            ],
          ) as any,
          statuses,
        );
      }
      return listed;
    };
    const [{ total }] = await scope().count({ total: '*' });
    const rows = await scope()
      .orderBy([
        { column: 'x.postedAt', order: 'asc' },
        { column: 'x.id', order: 'asc' },
      ])
      .limit(pageSize)
      .offset((page - 1) * pageSize)
      .select('x.id as id');
    const ids = rows.map((row: any) => Number(row.id));
    const views = await this.views(config, ids);

    return {
      data: ids.map((id) => views.get(id)),
      pagination: { total: Number(total), page, pageSize },
    };
  }

  /**
   * Reads a document's row. Inside a transaction the row is locked, so that
   * writes to one document, and payments of it, run one after the other.
   */
  public async rowOrThrow(
    config: TradeConfig,
    documentId: number,
    trx?: Knex.Transaction,
  ): Promise<any> {
    let row = null;

    if (Number.isInteger(documentId)) {
      const query = (trx ?? this.tenantKnex())(DOCUMENTS_TABLE)
        .where({ id: documentId, kind: config.documentKind })
        .first();
      row = await (trx ? query.forUpdate() : query);
    }
    if (!row) {
      throw new ServiceError(
        config.errors.documentNotFound,
        `The ${config.nouns.document} was not found.`,
        { [config.idKeys.document]: documentId },
        HttpStatus.NOT_FOUND,
      );
    }
    return row;
  }

  /**
   * Builds the documents of the given ids.
   */
  public async views(
    config: TradeConfig,
    documentIds: number[],
  ): Promise<Map<number, TradeDocumentView>> {
    const views = new Map<number, TradeDocumentView>();

    for (const run of chunks(documentIds)) {
      (await this.viewsOf(config, run)).forEach((view, id) =>
        views.set(id, view),
      );
    }
    return views;
  }

  private async viewsOf(
    config: TradeConfig,
    documentIds: number[],
  ): Promise<Map<number, TradeDocumentView>> {
    const views = new Map<number, TradeDocumentView>();
    if (documentIds.length === 0) return views;

    const knex = this.tenantKnex();
    const kind = config.documentKind;
    const [documents, lines, externalIds, metadata, allocations] =
      await Promise.all([
        knex(DOCUMENTS_TABLE).where({ kind }).whereIn('id', documentIds),
        this.lines.listMany(config.lineKind, documentIds),
        this.externalIds.findExternalIds(kind, documentIds),
        this.metadata.getMany(kind, documentIds),
        knex(`${ALLOCATIONS_TABLE} as a`)
          .join(`${PAYMENTS_TABLE} as p`, 'p.id', 'a.payment_id')
          .whereIn('a.document_id', documentIds)
          .where('p.kind', config.paymentKind)
          .whereNull('p.deleted_at')
          .orderBy(['p.paid_at', 'a.id'])
          .select(
            'a.id as id',
            'a.document_id as documentId',
            'a.payment_id as paymentId',
            'a.amount as amount',
            'p.paid_at as paidAt',
          ),
      ]);
    const allLines = [...lines.values()].flat();
    const lineIds = allLines.map((line) => line.id);
    const [lineMetadata, tracking, briefs, parties, payments] =
      await Promise.all([
        this.metadata.getMany(config.lineKind, lineIds),
        this.tracking.ofLines(lineIds),
        this.accounts.briefs(allLines.map((line) => line.accountId)),
        this.parties.views(
          config.partyKind as PartyKind,
          documents.map((document: any) => Number(document.partyId)),
        ),
        this.paymentViews.payments(
          config,
          allocations.map((a: any) => Number(a.paymentId)),
        ),
      ]);

    documents.forEach((document: any) => {
      const id = Number(document.id);
      const amount = toCents(String(document.amount));
      const own = allocations.filter((a: any) => Number(a.documentId) === id);
      const paid = own.reduce(
        (sum: bigint, a: any) => sum + toCents(String(a.amount)),
        0n,
      );
      const settled = amount - paid === 0n && own.length > 0;

      views.set(id, {
        id,
        externalId: externalIds.get(id) ?? null,
        status: documentStatus(amount, paid, Boolean(document.voidedAt)),
        postedAt: document.postedAt,
        dueAt: document.dueAt ?? null,
        terms: document.terms ?? null,
        paidAt: settled
          ? own
              .map((a: any) => a.paidAt as string)
              .sort()
              .pop()
          : null,
        voidedAt: document.voidedAt ?? null,
        number: document.number ?? null,
        reference: document.reference ?? null,
        note: document.note ?? null,
        metadata: metadata.get(id) ?? null,
        amount: fromCents(amount),
        balance: fromCents(amount - paid),
        party: parties.get(Number(document.partyId)) ?? null,
        entries: (lines.get(id) ?? []).map((line) => ({
          id: line.id,
          externalId: line.externalId,
          accountId: line.accountId,
          account: briefs.get(line.accountId) ?? null,
          item: line.item,
          description: line.description,
          rate: line.rate,
          quantity: line.quantity,
          amount: fromCents(toCents(line.amount ?? '0')),
          metadata: lineMetadata.get(line.id) ?? null,
          tracking: (tracking.get(line.id) ?? []).map((t) => ({
            id: t.id,
            category: t.category,
            option: t.option,
            optionName: t.optionName,
          })),
        })),
        payments: own.map((a: any) => ({
          id: Number(a.id),
          paymentId: Number(a.paymentId),
          amount: fromCents(toCents(String(a.amount))),
          payment: payments.get(Number(a.paymentId)),
        })),
        createdAt: toIso(document.createdAt),
        updatedAt: toIso(document.updatedAt),
      });
    });
    return views;
  }

  /**
   * Checks a document and resolves what it names, before any transaction
   * opens: its party, its accounts, its tracking, and the price of each line.
   */
  private async prepare(
    config: TradeConfig,
    input: TradeDocumentInput,
  ): Promise<PreparedDocument> {
    const partyKind = config.partyKind as PartyKind;
    const hasId = input.partyId !== null && input.partyId !== undefined;
    const hasExternalId = Boolean(input.partyExternalId);
    const { party } = config.nouns;

    if (hasId === hasExternalId) {
      throw new ServiceError(
        config.errors.partyRequired,
        `A ${config.nouns.document} names its ${party} by ${party}_id or by ${party}_external_id, one of the two.`,
      );
    }
    let partyId: number | null = null;

    if (hasId) {
      partyId = (await this.parties.get(partyKind, input.partyId)).id;
    } else if (!config.partyMadeOnSight) {
      partyId = await this.parties.findByExternalId(
        partyKind,
        input.partyExternalId,
      );
      if (partyId === null) {
        this.parties.notFound(partyKind, {
          externalId: input.partyExternalId,
        });
      }
    }
    const entries = input.entries ?? [];
    await this.accounts.assertPresented(entries.map((e) => e.accountId));

    const resolved = await this.tracking.resolve(
      entries.flatMap((entry) => entry.tracking ?? []),
    );
    const postedAt = toInstant(input.postedAt);
    const lines = entries.map((entry) => {
      const quantity = entry.quantity ?? '1';

      return {
        externalId: entry.externalId ?? null,
        accountId: entry.accountId,
        item: entry.item ?? null,
        description: entry.description ?? null,
        rate: entry.rate,
        quantity,
        cents: lineCents(entry.rate, quantity),
        metadata: entry.metadata ?? null,
        tracking: (entry.tracking ?? []).map((t) =>
          resolved.get(this.tracking.key(t)),
        ),
      };
    });
    const amount = lines.reduce((sum, line) => sum + line.cents, 0n);
    const within = (cents: bigint) =>
      cents <= POSTING_MAX_CENTS && cents >= -POSTING_MAX_CENTS;

    // A rate times a quantity can come to more than a ledger row holds.
    if (!within(amount) || lines.some((line) => !within(line.cents))) {
      throw new ServiceError(
        POSTING_ERRORS.AMOUNT_TOO_LARGE,
        `An amount is larger than the ledger holds, which is ${fromCents(POSTING_MAX_CENTS)}.`,
        { max: fromCents(POSTING_MAX_CENTS) },
      );
    }

    if (amount < 0n && !config.negativeTotalAllowed) {
      throw new ServiceError(
        TRADE_ERRORS.INVOICE_AMOUNT_NEGATIVE,
        `The ${config.nouns.document} would total ${fromCents(amount)}; it may not total less than zero.`,
        { amount: fromCents(amount) },
      );
    }
    return {
      input,
      postedAt,
      // Due on receipt means due on the document's own day, whatever was sent.
      dueAt:
        input.terms === DUE_ON_RECEIPT
          ? postedAt
          : input.dueAt
            ? toInstant(input.dueAt)
            : null,
      amount,
      partyId,
      lines,
    };
  }

  /**
   * Writes a new document, or the given document over an existing one, with
   * its lines and its ledger entry.
   * @returns The id of the document.
   */
  private async write(
    config: TradeConfig,
    documentId: number | null,
    prepared: PreparedDocument,
    number: string | null,
    trx: Knex.Transaction,
  ): Promise<number> {
    const { input } = prepared;
    const kind = config.documentKind;
    const old =
      documentId === null
        ? null
        : await this.rowOrThrow(config, documentId, trx);

    if (old) {
      const paid = await this.ledger.paidOn(config, documentId, trx);

      if (prepared.amount < paid) {
        throw new ServiceError(
          config.errors.amountBelowPaid,
          `The ${config.nouns.document} would total ${fromCents(prepared.amount)}, less than the ${fromCents(paid)} paid on it.`,
          {
            [config.idKeys.document]: documentId,
            amount: fromCents(prepared.amount),
            paid: fromCents(paid),
          },
        );
      }
      // The document as it stands must be open too: an edit cannot move a
      // document out of the closed period.
      await this.lock.assertOpen([prepared.postedAt, old.postedAt], trx);
    }
    // Checked where the closing instant can no longer change.
    await this.lock.assertOpen([prepared.postedAt], trx);

    const partyId =
      prepared.partyId ??
      (await this.parties.ensure(
        config.partyKind as PartyKind,
        input.partyExternalId,
        trx,
      ));
    const columns = {
      partyId,
      postedAt: prepared.postedAt,
      dueAt: prepared.dueAt,
      terms: input.terms ?? null,
      reference: input.reference ?? null,
      note: input.note ?? null,
      // An edit that sends no number keeps the one the document has.
      number: number ?? old?.number ?? null,
      amount: fromCents(prepared.amount),
      updatedAt: trx.fn.now(),
    };
    let id = documentId;

    if (old) {
      await trx(DOCUMENTS_TABLE).where({ id }).update(columns);
    } else {
      [id] = await trx(DOCUMENTS_TABLE).insert({
        kind,
        ...columns,
        createdAt: trx.fn.now(),
      });
    }
    await this.writeLines(config, id, prepared, trx);
    await this.metadata.set(kind, id, input.metadata ?? null, trx);

    if (old && input.externalId !== undefined) {
      const current = await this.externalIds.findExternalId(kind, id, trx);

      if (current !== (input.externalId ?? null)) {
        await this.externalIds.release(kind, id, trx);
        if (input.externalId) {
          await this.externalIds.attach(kind, id, input.externalId, trx);
        }
      }
    }
    await this.ledger.postDocument(config, id, trx);

    // What a payment posted may depend on the document: its day, where the
    // payment's entry is dated on it, and its lines, where payments are
    // shared over the lines as they now stand.
    const dayMoved =
      old &&
      config.paymentDatedOnDocument &&
      old.postedAt !== prepared.postedAt;

    // A payment's row on the control account names the document's party.
    const partyMoved = old && Number(old.partyId) !== Number(partyId);

    if (old && (dayMoved || partyMoved || !config.paymentsKeepSplit)) {
      await this.ledger.repostPaymentsOf(config, id, trx);
    }
    return id;
  }

  /**
   * Replaces the lines of a document. A line keeps its id when it carries
   * the external id of a line the document already had.
   */
  private async writeLines(
    config: TradeConfig,
    documentId: number,
    prepared: PreparedDocument,
    trx: Knex.Transaction,
  ): Promise<void> {
    const lineKind = config.lineKind;
    const existing = await this.lines.list(lineKind, documentId, trx);
    const idByExternalId = new Map<string, number>();

    existing.forEach((line) => {
      if (line.externalId && !idByExternalId.has(line.externalId)) {
        idByExternalId.set(line.externalId, line.id);
      }
    });
    const stored = await this.lines.replace(
      lineKind,
      documentId,
      prepared.lines.map((line) => {
        const keptId = line.externalId
          ? idByExternalId.get(line.externalId)
          : undefined;
        // An id is kept once: a second line with the same external id is new.
        if (line.externalId) idByExternalId.delete(line.externalId);

        return {
          id: keptId,
          externalId: line.externalId,
          description: line.description,
          accountId: line.accountId,
          item: line.item,
          rate: line.rate,
          quantity: line.quantity,
          amount: fromCents(line.cents),
        };
      }),
      trx,
    );
    const storedIds = new Set(stored.map((line) => line.id));
    const removedIds = existing
      .map((line) => line.id)
      .filter((id) => !storedIds.has(id));

    await this.metadata.remove(lineKind, removedIds, trx);
    await this.tracking.removeLineLinks(removedIds, trx);

    for (let i = 0; i < stored.length; i += 1) {
      await this.metadata.set(
        lineKind,
        stored[i].id,
        prepared.lines[i].metadata,
        trx,
      );
      await this.tracking.setLineLinks(
        stored[i].id,
        prepared.lines[i].tracking,
        trx,
      );
    }
  }
}
