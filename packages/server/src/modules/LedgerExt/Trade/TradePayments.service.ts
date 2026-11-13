import { Knex } from 'knex';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ServiceError } from '@/modules/Items/ServiceError';
import { TENANCY_DB_CONNECTION } from '@/modules/Tenancy/TenancyDB/TenancyDB.constants';
import { ExtAuditService } from '../common/ExtAudit.service';
import { ExtUnitOfWork } from '../common/ExtUnitOfWork.service';
import { ExternalIdsService } from '../common/ExternalIds.service';
import { ExtMetadataService } from '../common/ExtMetadata.service';
import { fromCents, toCents } from '../common/money';
import { toPlainDate } from '../common/timestamps';
import {
  raiseVersion,
  refusingStale,
  requireVersion,
} from '../common/versions';
import { LedgerAccountsService } from '../Accounts/LedgerAccounts.service';
import { ExtLockService } from '../Lock/ExtLock.service';
import { CreditApplicationsService } from './CreditApplications.service';
import { ExtPartiesService, PartyKind } from './ExtParties.service';
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
} from './TradePaymentViews.service';
import { TradeConfig } from './trade.config';
import { presentPayment } from './tradePresenters';
import { DOCUMENT_LIST_MAX_PAGE_SIZE, TRADE_ERRORS } from './trade.constants';

/** A payment as a caller sends it, in the words of neither side. */
export interface TradePaymentInput {
  externalId?: string | null;
  paidOn: string;
  method?: string | null;
  processor?: string | null;
  amount: string;
  accountId?: number | null;
  redemptionAccountId?: number | null;
  partyId?: number | null;
  reference?: string | null;
  note?: string | null;
  metadata?: Record<string, unknown> | null;
  /** Each part pays a document, or is paid to an account in its place. */
  allocations?: Array<{
    documentId?: number | null;
    accountId?: number | null;
    memo?: string | null;
    amount: string;
  }>;
}

/**
 * Payments of bills and of invoices: money shared over the documents it
 * pays.
 *
 * A payment may be larger than what it allocates: what is left over is a
 * credit with its party, and is applied to that party's documents later. It
 * is never removed: deleting it takes its entries and its applications out
 * of the books and leaves its documents owing again. Its external id stays
 * its own. Where the two sides follow different
 * rules, the rule is in the `TradeConfig` each call is given.
 */
@Injectable()
export class TradePaymentsService {
  constructor(
    @Inject(TENANCY_DB_CONNECTION)
    private readonly tenantKnex: () => Knex,
    private readonly uow: ExtUnitOfWork,
    private readonly externalIds: ExternalIdsService,
    private readonly metadata: ExtMetadataService,
    private readonly accounts: LedgerAccountsService,
    private readonly lock: ExtLockService,
    private readonly parties: ExtPartiesService,
    private readonly ledger: TradeLedgerService,
    private readonly views: TradePaymentViewsService,
    private readonly audit: ExtAuditService,
    private readonly applications: CreditApplicationsService,
  ) {}

  /**
   * Creates a payment. A create carrying the external id of an existing
   * payment is a retry when its body is the one the payment was made with,
   * and is answered with the payment; otherwise it is refused. A payment is
   * not edited: it is deleted, and another made.
   * @throws {ServiceError} EXTERNAL_ID_IN_USE
   */
  public async create(
    config: TradeConfig,
    input: TradePaymentInput,
  ): Promise<{
    payment: TradePaymentView;
    created: boolean;
    replayed: boolean;
  }> {
    const kind = config.paymentKind;
    const describe = async (id: number) => ({
      state: 'live' as const,
      version: Number((await this.rowOrThrow(config, id)).version),
    });
    if (input.externalId) {
      // A repeat is answered before anything about the body is checked: a
      // retry must not fail on what has changed since.
      const held = await this.externalIds.findRecordId(kind, input.externalId);

      if (held !== null) {
        await this.externalIds.createOnce({
          kind,
          externalId: input.externalId,
          body: input,
          describe,
          create: async () => held,
          read: async (id) => id,
        });
        return {
          payment: await this.get(config, held),
          created: false,
          replayed: true,
        };
      }
    }
    await this.check(config, input);

    let logged: number | null = null;
    const { recordId, created, replayed } = await this.externalIds.createOnce({
      kind,
      externalId: input.externalId,
      body: input,
      describe,
      create: async (trx) => {
        const id = await this.write(config, null, input, trx);
        logged = await this.audit.record(
          {
            action: 'create',
            subject: kind,
            subjectId: id,
            number: input.reference ?? null,
            index: true,
          },
          trx,
        );
        return id;
      },
      read: async (id) => id,
    });
    const payment = await this.get(config, recordId);
    // Lost to a simultaneous create of the same id and body: nothing was written.
    if (!created) return { payment, created, replayed };

    await this.audit.finish(logged, presentPayment(config, payment));
    return { payment, created, replayed };
  }

  public async get(
    config: TradeConfig,
    paymentId: number,
  ): Promise<TradePaymentView> {
    const row = await this.rowOrThrow(config, paymentId);

    if (row.deletedAt) this.notFound(config, paymentId);
    return (await this.views.payments(config, [paymentId])).get(paymentId);
  }

  /**
   * Lists the payments of one side that have not been deleted, oldest
   * first; with `unapplied`, only those with money left to apply.
   */
  public async list(
    config: TradeConfig,
    query: {
      unapplied?: string;
      partyId?: string | number;
      page?: string | number;
      pageSize?: string | number;
    },
  ): Promise<{
    data: TradePaymentView[];
    pagination: { total: number; page: number; pageSize: number };
  }> {
    const page = Math.max(1, Number(query.page) || 1);
    const pageSize = Math.min(
      Math.max(1, Number(query.pageSize) || 50),
      DOCUMENT_LIST_MAX_PAGE_SIZE,
    );
    const knex = this.tenantKnex();
    const kind = config.paymentKind;

    const scope = () => {
      const payments = knex(`${PAYMENTS_TABLE} as p`)
        .where('p.kind', kind)
        .whereNull('p.deleted_at');

      if (query.partyId !== undefined) {
        payments.where('p.party_id', Number(query.partyId));
      }
      if (query.unapplied === 'true') {
        const parts = knex(`${ALLOCATIONS_TABLE} as a`)
          .whereRaw('?? = ??', ['a.payment_id', 'p.id'])
          .select(knex.raw('COALESCE(SUM(??), 0)', ['a.amount']));
        const applied = knex(`${APPLICATIONS_TABLE} as c`)
          .whereRaw('?? = ??', ['c.source_id', 'p.id'])
          .where('c.source_kind', kind)
          .whereNull('c.deleted_at')
          .select(knex.raw('COALESCE(SUM(??), 0)', ['c.amount']));
        payments.whereRaw('?? > (?) + (?)', ['p.amount', parts, applied]);
      }
      return payments;
    };
    const [{ total }] = await scope().count({ total: '*' });
    const rows = await scope()
      .orderBy([
        { column: 'p.paid_on', order: 'asc' },
        { column: 'p.id', order: 'asc' },
      ])
      .limit(pageSize)
      .offset((page - 1) * pageSize)
      .select('p.id as id');
    const ids = rows.map((row: any) => Number(row.id));
    const views = await this.views.payments(config, ids);

    return {
      data: ids.map((id) => views.get(id)),
      pagination: { total: Number(total), page, pageSize },
    };
  }

  /**
   * Deletes a payment. Deleting a deleted payment changes nothing; whether
   * it is answered with the payment or as not found is the side's rule.
   */
  public async delete(
    config: TradeConfig,
    paymentId: number,
    expected?: number | string | null,
  ): Promise<TradePaymentView> {
    const found = await this.rowOrThrow(config, paymentId);

    if (found.deletedAt && !config.deletedPaymentStillAnswers) {
      this.notFound(config, paymentId);
    }
    // Deleting a deleted payment changes nothing, whatever version it names.
    const version = found.deletedAt ? undefined : requireVersion(expected);
    // The payment as it stood, kept by the log: once deleted it is read no more.
    const before = found.deletedAt
      ? null
      : (await this.views.payments(config, [paymentId])).get(paymentId);

    await refusingStale(
      () =>
        this.uow.withTransaction(async (trx) => {
          const payment = await this.rowOrThrow(config, paymentId, trx);
          if (payment.deletedAt) return;

          await raiseVersion(trx, PAYMENTS_TABLE, { id: paymentId }, version);
          // What each document owes changes, so each document moves on too.
          await this.raiseDocuments(paymentId, trx);
          await this.lock.assertOpen([payment.paidOn], trx);
          // What the payment left over and was applied since goes with it.
          await this.applications.removeOfPayment(config, paymentId, trx);
          await trx(PAYMENTS_TABLE).where({ id: paymentId }).update({
            deletedAt: new Date().toISOString(),
            updatedAt: trx.fn.now(),
          });
          await this.ledger.postPayment(config, paymentId, trx);
          // The payment's external id stays its own: it is not used again.
          await this.externalIds.markDeleted(
            config.paymentKind,
            paymentId,
            trx,
          );
          await this.audit.record(
            {
              action: 'delete',
              subject: config.paymentKind,
              subjectId: paymentId,
              number: before?.reference ?? null,
              before: presentPayment(config, before),
              index: true,
            },
            trx,
          );
        }),
      async () => presentPayment(config, await this.get(config, paymentId)),
    );
    return (await this.views.payments(config, [paymentId])).get(paymentId);
  }

  /** Raises the version of every document a payment is allocated to. */
  private async raiseDocuments(
    paymentId: number,
    trx: Knex.Transaction,
  ): Promise<void> {
    // The documents its applications are to are raised as each is removed.
    const rows = await trx(ALLOCATIONS_TABLE)
      .where({ paymentId })
      .whereNotNull('documentId')
      .distinct('documentId');

    for (const row of rows) {
      await raiseVersion(trx, DOCUMENTS_TABLE, { id: Number(row.documentId) });
    }
  }

  /**
   * What can be checked before a transaction opens: the amount covers what
   * is allocated, and the accounts and the party named exist.
   */
  private async check(
    config: TradeConfig,
    input: TradePaymentInput,
  ): Promise<void> {
    const amount = toCents(input.amount);
    const allocated = (input.allocations ?? []).reduce(
      (sum, allocation) => sum + toCents(allocation.amount),
      0n,
    );
    if (amount < allocated) {
      throw new ServiceError(
        config.errors.paymentAmountBelowAllocations,
        `The payment of ${fromCents(amount)} is less than the ${fromCents(allocated)} it allocates.`,
        { amount: fromCents(amount), allocated: fromCents(allocated) },
      );
    }
    const parts = input.allocations ?? [];
    const named = (value: unknown) => value !== null && value !== undefined;
    const unclear = parts.findIndex(
      (part) => named(part.documentId) === named(part.accountId),
    );
    if (unclear !== -1) {
      throw new ServiceError(
        TRADE_ERRORS.ALLOCATION_NAMES_ONE_TARGET,
        `A part of a payment names a ${config.nouns.document} or an account, and not both.`,
        { index: unclear },
      );
    }
    await this.accounts.assertPostable(
      [
        input.accountId,
        input.redemptionAccountId,
        ...parts.map((part) => part.accountId),
      ].filter((id): id is number => id !== null && id !== undefined),
    );
    const partyNamed = input.partyId !== null && input.partyId !== undefined;

    if (config.paymentNamesParty && !partyNamed) {
      throw new ServiceError(
        config.errors.partyRequired,
        `A payment names its ${config.nouns.party} by ${config.nouns.party}_id.`,
      );
    }
    if (partyNamed) {
      await this.parties.get(config.partyKind as PartyKind, input.partyId);
    }
  }

  /**
   * Writes a new payment, or the given payment over an existing one, with
   * its allocations and its ledger entries.
   * @returns The id of the payment.
   */
  private async write(
    config: TradeConfig,
    paymentId: number | null,
    input: TradePaymentInput,
    trx: Knex.Transaction,
  ): Promise<number> {
    const { document } = config.nouns;
    const old =
      paymentId === null ? null : await this.rowOrThrow(config, paymentId, trx);
    const parts = (input.allocations ?? []).map((allocation, i) => ({
      index: i + 1,
      documentId: allocation.documentId ?? null,
      accountId: allocation.accountId ?? null,
      memo: allocation.memo ?? null,
      cents: toCents(allocation.amount),
    }));
    const allocations = parts.filter((part) => part.documentId !== null);
    // The documents are locked in one order, so that two payments of the
    // same documents cannot wait on each other.
    const documentIds = [...new Set(allocations.map((a) => a.documentId))].sort(
      (a, b) => a - b,
    );
    const documents = documentIds.length
      ? await trx(DOCUMENTS_TABLE)
          .where({ kind: config.documentKind })
          .whereIn('id', documentIds)
          .orderBy('id')
          .forUpdate()
      : [];
    const documentById = new Map(
      documents.map((row: any) => [Number(row.id), row]),
    );
    const missing = documentIds.filter((id) => !documentById.has(id));

    if (missing.length > 0) {
      throw new ServiceError(
        config.errors.paymentDocumentNotFound,
        `A ${document} the payment allocates to was not found.`,
        { [config.idKeys.documents]: missing },
      );
    }
    for (const documentId of documentIds) {
      const row = documentById.get(documentId);

      if (config.paymentNamesParty && Number(row.partyId) !== input.partyId) {
        throw new ServiceError(
          TRADE_ERRORS.PAYMENT_INVOICE_OF_ANOTHER_CUSTOMER,
          `The payment allocates to an ${document} of another ${config.nouns.party}.`,
          { [config.idKeys.document]: documentId },
        );
      }
      if (row.voidedAt) {
        throw new ServiceError(
          config.errors.voided,
          `The ${document} is voided and cannot be paid.`,
          { [config.idKeys.document]: documentId },
        );
      }
      const paying = allocations
        .filter((a) => a.documentId === documentId)
        .reduce((sum, a) => sum + a.cents, 0n);
      const owed =
        toCents(String(row.amount)) -
        (await this.ledger.paidOn(
          config,
          documentId,
          trx,
          paymentId ?? undefined,
        ));

      if (paying > owed) {
        throw new ServiceError(
          config.errors.allocationExceedsBalance,
          `The payment allocates ${fromCents(paying)} to a ${document} that owes ${fromCents(owed)}.`,
          {
            [config.idKeys.document]: documentId,
            allocated: fromCents(paying),
            balance: fromCents(owed),
          },
        );
      }
    }
    // What a payment leaves unapplied is a credit with a party. A payment
    // that names none has the party of its documents, when they have one.
    let partyId = input.partyId ?? null;
    const unapplied =
      toCents(input.amount) - parts.reduce((sum, part) => sum + part.cents, 0n);

    if (unapplied > 0n && partyId === null) {
      const owners = [
        ...new Set(documents.map((row: any) => Number(row.partyId))),
      ];
      if (owners.length !== 1) {
        throw new ServiceError(
          config.errors.partyRequired,
          `A ${config.nouns.payment} that leaves money unapplied names its ${config.nouns.party} by ${config.nouns.party}_id.`,
          { unapplied: fromCents(unapplied) },
        );
      }
      [partyId] = owners;
    }
    const paidOn = toPlainDate(input.paidOn);

    // Every entry of a payment lands on its own day, so that is the day
    // the lock looks at; and the day it had, when it is being replaced.
    await this.lock.assertOpen([paidOn, ...(old ? [old.paidOn] : [])], trx);
    const columns = {
      paidOn,
      method: input.method ?? null,
      processor: input.processor ?? null,
      amount: fromCents(toCents(input.amount)),
      accountId: input.accountId ?? null,
      redemptionAccountId: input.redemptionAccountId ?? null,
      partyId,
      reference: input.reference ?? null,
      note: input.note ?? null,
      updatedAt: trx.fn.now(),
    };
    let id = paymentId;

    if (old) {
      await trx(PAYMENTS_TABLE).where({ id }).update(columns);
      await trx(ALLOCATIONS_TABLE).where({ paymentId: id }).delete();
    } else {
      [id] = await trx(PAYMENTS_TABLE).insert({
        kind: config.paymentKind,
        ...columns,
        createdAt: trx.fn.now(),
      });
    }
    for (const part of parts) {
      await trx(ALLOCATIONS_TABLE).insert({
        paymentId: id,
        documentId: part.documentId,
        accountId: part.accountId,
        memo: part.documentId === null ? part.memo : null,
        index: part.index,
        amount: fromCents(part.cents),
        // The document's lines as they stand now, each with its share of
        // this part. The cash basis posts those shares, whatever the
        // document is edited to later. A part paid to an account has none.
        lines: JSON.stringify(
          part.documentId === null
            ? []
            : await this.ledger.sharedSnapshot(
                config,
                part.documentId,
                part.cents,
                trx,
              ),
        ),
      });
    }
    await this.metadata.set(
      config.paymentKind,
      id,
      input.metadata ?? null,
      trx,
    );
    await this.ledger.postPayment(config, id, trx);
    // An edit of a document built before this payment must not land after it.
    await this.raiseDocuments(id, trx);
    return id;
  }

  private async rowOrThrow(
    config: TradeConfig,
    paymentId: number,
    trx?: Knex.Transaction,
  ): Promise<any> {
    let row = null;

    if (Number.isInteger(paymentId)) {
      const query = (trx ?? this.tenantKnex())(PAYMENTS_TABLE)
        .where({ id: paymentId, kind: config.paymentKind })
        .first();
      row = await (trx ? query.forUpdate() : query);
    }
    if (!row) this.notFound(config, paymentId);
    return row;
  }

  private notFound(config: TradeConfig, paymentId: number): never {
    throw new ServiceError(
      config.errors.paymentNotFound,
      `The ${config.nouns.payment} was not found.`,
      { [config.idKeys.payment]: paymentId },
      HttpStatus.NOT_FOUND,
    );
  }
}
