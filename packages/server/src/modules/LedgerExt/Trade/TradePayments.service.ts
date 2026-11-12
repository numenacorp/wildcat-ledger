import { Knex } from 'knex';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ServiceError } from '@/modules/Items/ServiceError';
import { TENANCY_DB_CONNECTION } from '@/modules/Tenancy/TenancyDB/TenancyDB.constants';
import { ExtUnitOfWork } from '../common/ExtUnitOfWork.service';
import { ExternalIdsService } from '../common/ExternalIds.service';
import { ExtMetadataService } from '../common/ExtMetadata.service';
import { fromCents, toCents } from '../common/money';
import { toInstant } from '../common/timestamps';
import { LedgerAccountsService } from '../Accounts/LedgerAccounts.service';
import { ExtLockService } from '../Lock/ExtLock.service';
import { ExtPartiesService, PartyKind } from './ExtParties.service';
import {
  ALLOCATIONS_TABLE,
  DOCUMENTS_TABLE,
  PAYMENTS_TABLE,
  TradeLedgerService,
} from './TradeLedger.service';
import {
  TradePaymentView,
  TradePaymentViewsService,
} from './TradePaymentViews.service';
import { TradeConfig } from './trade.config';
import { TRADE_ERRORS } from './trade.constants';

/** A payment as a caller sends it, in the words of neither side. */
export interface TradePaymentInput {
  externalId?: string | null;
  paidAt: string;
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
 * A payment may be larger than what it allocates. It is never removed:
 * deleting it takes its entries out of the books, leaves its documents owing
 * again, and gives up its external id. Where the two sides follow different
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
  ) {}

  /**
   * Creates a payment. A create carrying the external id of an existing
   * payment replaces that payment with the one given.
   */
  public async create(
    config: TradeConfig,
    input: TradePaymentInput,
  ): Promise<{ payment: TradePaymentView; created: boolean }> {
    const kind = config.paymentKind;
    const replace = async (id: number) => {
      await this.check(config, input);
      await this.uow.withTransaction((trx) =>
        this.write(config, id, input, trx),
      );
      return { payment: await this.get(config, id), created: false };
    };
    if (input.externalId) {
      const existingId = await this.externalIds.findRecordId(
        kind,
        input.externalId,
      );
      if (existingId !== null) return replace(existingId);
    }
    await this.check(config, input);

    const { recordId, created } = await this.externalIds.createOnce({
      kind,
      externalId: input.externalId,
      create: (trx) => this.write(config, null, input, trx),
      read: async (id) => id,
    });
    // Lost to a simultaneous create of the same external id: replace it.
    if (!created) return replace(recordId);

    return { payment: await this.get(config, recordId), created };
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
   * Deletes a payment. Deleting a deleted payment changes nothing; whether
   * it is answered with the payment or as not found is the side's rule.
   */
  public async delete(
    config: TradeConfig,
    paymentId: number,
  ): Promise<TradePaymentView> {
    const found = await this.rowOrThrow(config, paymentId);

    if (found.deletedAt && !config.deletedPaymentStillAnswers) {
      this.notFound(config, paymentId);
    }
    await this.uow.withTransaction(async (trx) => {
      const payment = await this.rowOrThrow(config, paymentId, trx);
      if (payment.deletedAt) return;

      await this.lock.assertOpen(
        await this.lockedInstants(config, payment, trx),
        trx,
      );
      await trx(PAYMENTS_TABLE).where({ id: paymentId }).update({
        deletedAt: new Date().toISOString(),
        updatedAt: trx.fn.now(),
      });
      await this.ledger.postPayment(config, paymentId, trx);
      await this.externalIds.release(config.paymentKind, paymentId, trx);
    });
    return (await this.views.payments(config, [paymentId])).get(paymentId);
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
    await this.accounts.assertPresented(
      [
        input.accountId,
        input.redemptionAccountId,
        ...parts.map((part) => part.accountId),
      ].filter((id): id is number => id !== null && id !== undefined),
    );
    if (config.paymentNamesParty) {
      if (input.partyId === null || input.partyId === undefined) {
        throw new ServiceError(
          config.errors.partyRequired,
          `A payment names its ${config.nouns.party} by ${config.nouns.party}_id.`,
        );
      }
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
      if (row.voidedAt && !config.voidedPayable) {
        throw new ServiceError(
          TRADE_ERRORS.INVOICE_VOIDED,
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
    const paidAt = toInstant(input.paidAt);

    // The lock looks at every day an entry lands on: the payment's own day,
    // and each document's day where a payment is dated on its documents;
    // and the same for the payment as it stood.
    await this.lock.assertOpen(
      [
        paidAt,
        ...(config.paymentDatedOnDocument
          ? documents.map((row: any) => row.postedAt as string)
          : []),
        ...(old ? await this.lockedInstants(config, old, trx) : []),
      ],
      trx,
    );
    const columns = {
      paidAt,
      method: input.method ?? null,
      processor: input.processor ?? null,
      amount: fromCents(toCents(input.amount)),
      accountId: input.accountId ?? null,
      redemptionAccountId: input.redemptionAccountId ?? null,
      partyId: input.partyId ?? null,
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
        // The document's lines as they stand now. Where payments keep their
        // split, the cash basis shares this payment out by them, whatever
        // the document is edited to later. A part paid to an account has
        // none.
        lines: JSON.stringify(
          part.documentId === null
            ? []
            : await this.ledger.snapshot(config, part.documentId, trx),
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
    return id;
  }

  /** The instants the lock looks at for a payment as it stands. */
  private async lockedInstants(
    config: TradeConfig,
    payment: any,
    trx: Knex.Transaction,
  ): Promise<string[]> {
    if (!config.paymentDatedOnDocument) return [payment.paidAt];

    const rows = await trx(`${ALLOCATIONS_TABLE} as a`)
      .join(`${DOCUMENTS_TABLE} as d`, 'd.id', 'a.document_id')
      .where('a.payment_id', Number(payment.id))
      .select('d.posted_at as postedAt');
    // Its cash-basis entries, and what it paid beyond its documents, land
    // on its own day.
    return [payment.paidAt, ...rows.map((row: any) => row.postedAt)];
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
