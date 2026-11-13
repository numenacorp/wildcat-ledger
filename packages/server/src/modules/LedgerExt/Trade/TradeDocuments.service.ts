import { Knex } from 'knex';
import { ERRORS } from '../LedgerExt.constants';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ServiceError } from '@/modules/Items/ServiceError';
import { TENANCY_DB_CONNECTION } from '@/modules/Tenancy/TenancyDB/TenancyDB.constants';
import { chunks } from '../common/chunks';
import { ExtAuditService } from '../common/ExtAudit.service';
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
import { toPlainDate } from '../common/timestamps';
import {
  raiseVersion,
  refusingStale,
  requireVersion,
} from '../common/versions';
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
import {
  ApplicationView,
  CreditApplicationsService,
} from './CreditApplications.service';
import { ExtPartiesService, PartyKind, PartyView } from './ExtParties.service';
import {
  ALLOCATIONS_TABLE,
  APPLICATIONS_TABLE,
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
import { presentDocument } from './tradePresenters';
import {
  DOCUMENT_LIST_MAX_PAGE_SIZE,
  CREDIT_STATUSES,
  DocumentStatus,
  TRADE_ERRORS,
  documentStatus,
} from './trade.constants';

const DUE_ON_RECEIPT = 'due_on_receipt';

/** A decimal that is zero, however it is written. */
const ZERO = /^-?0*(\.0*)?$/;

/** A rate with its sign turned. */
const turned = (rate: string): string =>
  ZERO.test(rate) ? rate : rate.startsWith('-') ? rate.slice(1) : `-${rate}`;

/** A bill or an invoice as a caller sends it, in neither's words. */
export interface TradeDocumentInput {
  /** On an edit: the version of the document the edit was made from. */
  version?: number | null;
  externalId?: string | null;
  /** On a create: the document was open when the books began. */
  opening?: boolean | null;
  partyId?: number | null;
  partyExternalId?: string | null;
  postedOn: string;
  dueOn?: string | null;
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
  /** The kind of the document: a bill, an invoice, or a credit of either. */
  kind: string;
  /** Open when the books began: its total stands against opening equity. */
  opening: boolean;
  id: number;
  externalId: string | null;
  status: DocumentStatus;
  postedOn: string;
  dueOn: string | null;
  terms: string | null;
  /** The latest payment's instant, once nothing is owed. */
  paidOn: string | null;
  voidedAt: string | null;
  /**
   * Raised by every change to the document, a payment on it and an
   * application to or from it included.
   */
  version: number;
  number: string | null;
  reference: string | null;
  note: string | null;
  metadata: Record<string, unknown> | null;
  amount: string;
  /**
   * What the document still owes: its amount less what is paid on it and
   * applied to it. For a credit, what it has left to apply.
   */
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
  /**
   * The applications to the document, oldest first; for a credit, the
   * applications made from it.
   */
  applications: ApplicationView[];
  createdAt: string | null;
  updatedAt: string | null;
}

/** A document checked and priced, before its transaction opens. */
interface PreparedDocument {
  input: TradeDocumentInput;
  opening: boolean;
  postedOn: string;
  dueOn: string | null;
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
 * leaves the document, frozen: no edit, no payment, a balance of zero.
 *
 * A credit is a document of its own kind, stored positive: a vendor credit
 * or a customer credit note. A bill sent with a total below zero is stored
 * as a vendor credit, its signs turned. A credit is paid by nothing; it is
 * applied to the documents of its party.
 *
 * An opening document is one still open when the books began. It is dated
 * on or before the day the books start and keeps its own day, due day, party
 * and lines, so it ages and is paid as any other. Its entry lands on the day
 * the books start, with the opening balances. Its lines' accounts are not
 * posted to: the books it came from already took the expense or the income.
 * Any other document is dated after the day the books start.
 * Where a bill and an invoice follow different rules, the rule is in the
 * `TradeConfig` each call is given.
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
    private readonly audit: ExtAuditService,
    private readonly applications: CreditApplicationsService,
  ) {}

  /**
   * Creates a document. A create carrying the external id of an existing
   * document is a retry when its body is the one the document was made
   * with, and is answered with the document; otherwise it is refused.
   * @throws {ServiceError} EXTERNAL_ID_IN_USE
   */
  public async create(
    config: TradeConfig,
    input: TradeDocumentInput,
  ): Promise<{
    document: TradeDocumentView;
    created: boolean;
    replayed: boolean;
  }> {
    // A total below zero is a credit: it is stored as one, signs turned.
    // Decided before anything else, so that a retry is answered as one.
    const becomes = config.negativeTotalBecomes?.();
    const total = (input.entries ?? []).reduce(
      (sum, entry) => sum + lineCents(entry.rate, entry.quantity ?? '1'),
      0n,
    );
    // An id held by a credit is a credit's, whatever is sent under it now:
    // the create is answered as a repeat of that credit, or refused.
    const heldByCredit =
      becomes && input.externalId
        ? (await this.externalIds.findRecordId(
            config.documentKind,
            input.externalId,
          )) === null &&
          (await this.externalIds.findRecordId(
            becomes.documentKind,
            input.externalId,
          )) !== null
        : false;
    if (becomes && (total < 0n || heldByCredit)) {
      return this.create(becomes, {
        ...input,
        entries: input.entries.map((entry) => ({
          ...entry,
          rate: turned(entry.rate),
        })),
      });
    }
    const { version: _version, ...body } = input;
    const describe = async (id: number) => {
      const row = await this.rowOrThrow(config, id);
      return {
        state: row.voidedAt ? ('voided' as const) : ('live' as const),
        version: Number(row.version),
      };
    };
    if (input.externalId) {
      // A repeat is answered before anything about the body is checked: a
      // retry must not fail on what has changed since, a lock above all.
      const held = await this.externalIds.findRecordId(
        config.documentKind,
        input.externalId,
      );
      if (held !== null) {
        const { recordId } = await this.externalIds.createOnce({
          kind: config.documentKind,
          externalId: input.externalId,
          body,
          describe,
          create: async () => held,
          read: async (id) => id,
        });
        return {
          document: await this.get(config, recordId),
          created: false,
          replayed: true,
        };
      }
    }
    const prepared = await this.prepare(config, input, Boolean(input.opening));
    await this.lock.assertOpen([await this.ledger.entryDay(prepared)]);

    const number = config.numbered
      ? (input.number ??
        `${config.numberPrefix}${String(await this.sequences.next(config.numberSequence)).padStart(6, '0')}`)
      : null;
    let logged: number | null = null;
    const { recordId, created, replayed } = await this.externalIds.createOnce({
      kind: config.documentKind,
      externalId: input.externalId,
      body,
      describe,
      create: async (trx) => {
        const id = await this.write(config, null, prepared, number, trx);
        logged = await this.audit.record(
          {
            action: 'create',
            subject: config.documentKind,
            subjectId: id,
            number: number ?? input.reference ?? null,
            index: true,
          },
          trx,
        );
        return id;
      },
      read: async (id) => id,
    });
    const document = await this.get(config, recordId);
    // Lost to a simultaneous create of the same id and body: nothing was written.
    if (!created) return { document, created, replayed };

    await this.audit.finish(logged, presentDocument(config, document));
    return { document, created, replayed };
  }

  /**
   * Replaces a document with the one given. Its id is kept, and so is the id
   * of each line that carries the external id of a line it already had.
   */
  public async edit(
    config: TradeConfig,
    documentId: number,
    input: TradeDocumentInput,
  ): Promise<TradeDocumentView> {
    const row = await this.rowOrThrow(config, documentId);
    this.assertNotVoided(config, row);
    const version = requireVersion(input.version);
    // Whether a document is an opening one is settled when it is made.
    const prepared = await this.prepare(
      config,
      input,
      Boolean(row.opening),
      await this.tracking.carriedBy(config.lineKind, documentId),
    );
    const before = await this.get(config, documentId);

    const logged = await refusingStale(
      () =>
        this.uow.withTransaction(async (trx) => {
          await this.write(
            config,
            documentId,
            prepared,
            input.number ?? null,
            trx,
            version,
          );
          return this.audit.record(
            {
              action: 'edit',
              subject: config.documentKind,
              subjectId: documentId,
              number: before.number ?? before.reference,
              before: presentDocument(config, before),
              index: true,
            },
            trx,
          );
        }),
      async () => presentDocument(config, await this.get(config, documentId)),
    );
    const document = await this.get(config, documentId);
    await this.audit.finish(logged, presentDocument(config, document));
    return document;
  }

  /** A voided document is frozen: it takes no edit. */
  private assertNotVoided(config: TradeConfig, row: any): void {
    if (!row.voidedAt) return;
    throw new ServiceError(
      config.errors.voided,
      `The ${config.nouns.document} is voided and cannot be edited.`,
      { [config.idKeys.document]: Number(row.id) },
    );
  }

  /**
   * Voids a document: its entry leaves the books and the document stays.
   * Voiding a voided document changes nothing.
   */
  public async void(
    config: TradeConfig,
    documentId: number,
    expected?: number | null,
  ): Promise<TradeDocumentView> {
    const before = await this.get(config, documentId);
    // Voiding a voided document changes nothing, whatever version it names.
    if (before.voidedAt) return before;
    const version = requireVersion(expected);

    const logged = await refusingStale(
      () =>
        this.uow.withTransaction(async (trx) => {
          const document = await this.rowOrThrow(config, documentId, trx);
          if (document.voidedAt) return null;
          await raiseVersion(trx, DOCUMENTS_TABLE, { id: documentId }, version);

          if ((await this.ledger.paidOn(config, documentId, trx)) > 0n) {
            throw new ServiceError(
              config.errors.hasPayments,
              `The ${config.nouns.document} has ${config.nouns.settlements} and cannot be voided.`,
              { [config.idKeys.document]: documentId },
            );
          }
          await this.lock.assertOpen(
            [await this.ledger.entryDay(document)],
            trx,
          );
          await trx(DOCUMENTS_TABLE).where({ id: documentId }).update({
            voidedAt: new Date().toISOString(),
            updatedAt: trx.fn.now(),
          });
          await this.ledger.postDocument(config, documentId, trx);
          return this.audit.record(
            {
              action: 'void',
              subject: config.documentKind,
              subjectId: documentId,
              number: before.number ?? before.reference,
              before: presentDocument(config, before),
              index: true,
            },
            trx,
          );
        }),
      async () => presentDocument(config, await this.get(config, documentId)),
    );
    const voided = await this.get(config, documentId);
    await this.audit.finish(logged, presentDocument(config, voided));
    return voided;
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
    // A credit's statuses are asked for in its own words.
    const statuses = query.status
      ? query.status
          .split(',')
          .map((status) =>
            config.credit
              ? (Object.entries(CREDIT_STATUSES).find(
                  ([, own]) => own === status,
                )?.[0] ?? status)
              : status,
          )
      : null;

    const scope = () => {
      const paidBy = knex(`${ALLOCATIONS_TABLE} as a`)
        .join(`${PAYMENTS_TABLE} as p`, 'p.id', 'a.payment_id')
        .whereRaw('?? = ??', ['a.document_id', 'd.id'])
        .whereNull('p.deleted_at')
        .select(knex.raw('COALESCE(SUM(??), 0)', ['a.amount']));
      // Applied to the document; for a credit, applied from it.
      const applied = knex(`${APPLICATIONS_TABLE} as c`)
        .whereRaw('?? = ??', [
          config.credit ? 'c.source_id' : 'c.document_id',
          'd.id',
        ])
        .whereNull('c.deleted_at')
        .select(knex.raw('COALESCE(SUM(??), 0)', ['c.amount']));
      if (config.credit) applied.where('c.source_kind', config.documentKind);
      const paid = knex.raw('(?) + (?)', [paidBy, applied]);
      const documents = knex(`${DOCUMENTS_TABLE} as d`)
        .where('d.kind', config.documentKind)
        .select(
          'd.id as id',
          'd.posted_on as postedOn',
          'd.amount as amount',
          'd.voided_at as voidedAt',
          knex.raw('? as ??', [paid, 'paid']),
        );
      if (query.from)
        documents.where('d.posted_on', '>=', toPlainDate(query.from));
      if (query.to) documents.where('d.posted_on', '<=', toPlainDate(query.to));
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
        { column: 'x.postedOn', order: 'asc' },
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
    const [documents, lines, externalIds, metadata, allocations, applications] =
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
          .orderBy(['p.paid_on', 'a.id'])
          .select(
            'a.id as id',
            'a.document_id as documentId',
            'a.payment_id as paymentId',
            'a.amount as amount',
            'p.paid_on as paidOn',
          ),
        config.credit
          ? this.applications.fromSources(kind, documentIds)
          : this.applications.toDocuments(documentIds),
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
      const applied = applications.filter(
        (a) => (config.credit ? a.sourceId : a.documentId) === id,
      );
      const paid = [...own, ...applied].reduce(
        (sum: bigint, a: any) => sum + toCents(String(a.amount)),
        0n,
      );
      const settled = amount - paid === 0n && own.length + applied.length > 0;

      views.set(id, {
        kind,
        opening: Boolean(document.opening),
        id,
        externalId: externalIds.get(id) ?? null,
        status: documentStatus(amount, paid, Boolean(document.voidedAt)),
        postedOn: document.postedOn,
        dueOn: document.dueOn ?? null,
        terms: document.terms ?? null,
        paidOn: settled
          ? [
              ...own.map((a: any) => a.paidOn as string),
              ...applied.map((a) => a.appliedOn),
            ]
              .sort()
              .pop()
          : null,
        voidedAt: document.voidedAt ?? null,
        version: Number(document.version),
        number: document.number ?? null,
        reference: document.reference ?? null,
        note: document.note ?? null,
        metadata: metadata.get(id) ?? null,
        amount: fromCents(amount),
        // A voided document owes nothing.
        balance: fromCents(document.voidedAt ? 0n : amount - paid),
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
        applications: applied,
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
    opening: boolean,
    carried: TrackingInput[] = [],
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
    await this.accounts.assertPostable(entries.map((e) => e.accountId));

    const resolved = await this.tracking.resolve(
      entries.flatMap((entry) => entry.tracking ?? []),
      carried,
    );
    const postedOn = toPlainDate(input.postedOn);
    const { booksStartOn } = await this.accounts.ledgerDefaults();

    // The day the books start is their opening day: opening balances land
    // on it, and so does the entry of an opening document. What the books
    // do themselves is dated after it.
    if (opening && (!booksStartOn || postedOn > booksStartOn)) {
      throw new ServiceError(
        TRADE_ERRORS.OPENING_DOCUMENT_AFTER_START,
        booksStartOn
          ? `An opening ${config.nouns.document} is dated on or before the day the books start, which is ${booksStartOn}.`
          : `The books have no start day, so they take no opening ${config.nouns.document}.`,
        { postedOn, booksStartOn },
      );
    }
    if (!opening && booksStartOn && postedOn <= booksStartOn) {
      throw new ServiceError(
        TRADE_ERRORS.DOCUMENT_BEFORE_BOOKS_START,
        `The ${config.nouns.document} is dated on or before the day the books start, which is ${booksStartOn}. One still open on that day is brought in as an opening ${config.nouns.document}.`,
        { postedOn, booksStartOn },
      );
    }
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

    if (amount < 0n) {
      throw new ServiceError(
        config.errors.amountNegative,
        `The ${config.nouns.document} would total ${fromCents(amount)}; it may not total less than zero.`,
        { amount: fromCents(amount) },
      );
    }
    return {
      input,
      opening,
      postedOn,
      // Due on receipt means due on the document's own day, whatever was sent.
      dueOn:
        input.terms === DUE_ON_RECEIPT
          ? postedOn
          : input.dueOn
            ? toPlainDate(input.dueOn)
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
    expectedVersion?: number,
  ): Promise<number> {
    const { input } = prepared;
    const kind = config.documentKind;
    const old =
      documentId === null
        ? null
        : await this.rowOrThrow(config, documentId, trx);

    const partyId =
      prepared.partyId ??
      (await this.parties.ensure(
        config.partyKind as PartyKind,
        input.partyExternalId,
        trx,
      ));
    // While anything is paid on a document or applied to it, or applied
    // from a credit, what the books hold of it is fixed.
    let settled = false;

    if (old) {
      // Checked again where the document can no longer be voided meanwhile.
      this.assertNotVoided(config, old);
      const paid = await this.ledger.paidOn(config, documentId, trx);

      if (paid > 0n) {
        await this.assertBooksUnchanged(
          config,
          old,
          prepared,
          partyId,
          paid,
          trx,
        );
        settled = true;
      }
      // The document as it stands must be open too: an edit cannot move a
      // document out of the closed period.
      await this.lock.assertOpen(
        [await this.ledger.entryDay(prepared), await this.ledger.entryDay(old)],
        trx,
      );
    }
    // Checked where the closing instant can no longer change.
    await this.lock.assertOpen([await this.ledger.entryDay(prepared)], trx);

    const columns = {
      partyId,
      postedOn: prepared.postedOn,
      dueOn: prepared.dueOn,
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
      await raiseVersion(trx, DOCUMENTS_TABLE, { id }, expectedVersion);
      await trx(DOCUMENTS_TABLE).where({ id }).update(columns);
    } else {
      [id] = await trx(DOCUMENTS_TABLE).insert({
        kind,
        opening: prepared.opening,
        ...columns,
        createdAt: trx.fn.now(),
      });
    }
    await this.writeLines(config, id, prepared, trx, settled);
    await this.metadata.set(kind, id, input.metadata ?? null, trx);

    if (old && input.externalId !== undefined) {
      const current = await this.externalIds.findExternalId(kind, id, trx);

      // An external id is the document's for ever: an edit may give one to
      // a document that has none, and may not change or remove one.
      if (current === null && input.externalId) {
        await this.externalIds.attach(kind, id, input.externalId, trx);
      } else if (current !== null && current !== (input.externalId ?? null)) {
        throw new ServiceError(
          ERRORS.EXTERNAL_ID_FIXED,
          'The external id of a record cannot be changed or removed.',
          { externalId: current },
        );
      }
    }
    if (old) {
      // The body the document now holds is the one a repeat of its external
      // id is a retry of.
      const { version: _version, ...held } = input;
      await this.externalIds.rehash(
        kind,
        id,
        (externalId) => ({ ...held, externalId }),
        trx,
      );
    }
    await this.ledger.postDocument(config, id, trx);

    // A payment's entries do not depend on the document's day or its lines
    // as they now stand. Its row on the control account names the
    // document's party, and its cash-basis rows carry the lines' tags.
    // Both may have changed, so its payments' rows are written again; what
    // each line was paid does not.
    if (old) {
      await this.ledger.repostPaymentsOf(config, id, trx);
    }
    return id;
  }

  /**
   * Refuses an edit that would change what the books hold of a document
   * with something paid on it or applied: its day, its party, or the
   * account or amount of any line, in order. What describes it stays open:
   * reference, note, terms, due day, number, metadata, and each line's
   * item, description, tags and how its amount is made up.
   * @throws {ServiceError} BILL_EDIT_HAS_PAYMENTS and its twins
   */
  private async assertBooksUnchanged(
    config: TradeConfig,
    old: any,
    prepared: PreparedDocument,
    partyId: number,
    paid: bigint,
    trx: Knex.Transaction,
  ): Promise<void> {
    const lines = await this.lines.list(config.lineKind, Number(old.id), trx);
    const changed: string[] = [];

    if (prepared.postedOn !== old.postedOn) changed.push('posted_on');
    if (partyId !== Number(old.partyId)) changed.push(config.nouns.party);
    if (
      lines.length !== prepared.lines.length ||
      lines.some(
        (line, n) =>
          line.accountId !== prepared.lines[n].accountId ||
          toCents(line.amount ?? '0') !== prepared.lines[n].cents,
      )
    ) {
      changed.push('entries');
    }
    if (changed.length === 0) return;

    const { document, settlements } = config.nouns;
    throw new ServiceError(
      config.errors.editHasSettlements,
      `The ${document} has ${settlements}, so its day, its ${config.nouns.party} and the accounts and amounts of its lines cannot change. Remove the ${settlements} first.`,
      {
        [config.idKeys.document]: Number(old.id),
        paid: fromCents(paid),
        changed,
      },
    );
  }

  /**
   * Replaces the lines of a document. A line keeps its id when it carries
   * the external id of a line the document already had. With something
   * paid or applied, the lines are the same lines in the same order, and
   * each keeps its id by its place: what a payment holds of a line stays
   * with it.
   */
  private async writeLines(
    config: TradeConfig,
    documentId: number,
    prepared: PreparedDocument,
    trx: Knex.Transaction,
    byPlace = false,
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
      prepared.lines.map((line, n) => {
        const keptId = byPlace
          ? existing[n].id
          : line.externalId
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
