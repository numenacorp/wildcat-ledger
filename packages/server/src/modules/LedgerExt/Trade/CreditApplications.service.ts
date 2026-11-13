import { Knex } from 'knex';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ServiceError } from '@/modules/Items/ServiceError';
import { TENANCY_DB_CONNECTION } from '@/modules/Tenancy/TenancyDB/TenancyDB.constants';
import { ExtRecordKind } from '../LedgerExt.constants';
import { ExtAuditService } from '../common/ExtAudit.service';
import { ExtUnitOfWork } from '../common/ExtUnitOfWork.service';
import { ExternalIdsService } from '../common/ExternalIds.service';
import { fromCents, toCents } from '../common/money';
import {
  raiseVersion,
  refusingStale,
  requireVersion,
} from '../common/versions';
import { ExtLockService } from '../Lock/ExtLock.service';
import {
  ALLOCATIONS_TABLE,
  APPLICATIONS_TABLE,
  DOCUMENTS_TABLE,
  PAYMENTS_TABLE,
  TradeLedgerService,
} from './TradeLedger.service';
import {
  BILLS,
  CREDIT_NOTES,
  INVOICES,
  TradeConfig,
  VENDOR_CREDITS,
} from './trade.config';
import { TRADE_ERRORS } from './trade.constants';

const KIND = ExtRecordKind.CreditApplication;

const toIso = (value: unknown): string | null =>
  value ? new Date(value as any).toISOString() : null;

/** The config an application's source kind is posted by. */
const SOURCES: Record<string, TradeConfig> = {
  [ExtRecordKind.BillPayment]: BILLS,
  [ExtRecordKind.PaymentReceived]: INVOICES,
  [ExtRecordKind.VendorCredit]: VENDOR_CREDITS,
  [ExtRecordKind.CreditNote]: CREDIT_NOTES,
};

/**
 * What an application is made from: a payment of the given side, or a credit
 * document (`config.credit`).
 */
export interface ApplicationSource {
  config: TradeConfig;
  id: number;
}

export interface ApplicationInput {
  externalId?: string | null;
  documentId: number;
  amount: string;
  /** The version of the payment or credit the application is made from. */
  version?: number | null;
}

export interface ApplicationView {
  id: number;
  externalId: string | null;
  /** Raised when the application is deleted. */
  version: number;
  sourceKind: string;
  sourceId: number;
  documentId: number;
  amount: string;
  /** The later of the source's day and the document's. */
  appliedOn: string;
  deletedAt: string | null;
  createdAt: string | null;
}

/**
 * Applications: money a payment left unapplied, or a credit document, set
 * against a bill or an invoice of the same party. No money moves. An
 * application is not edited: it is deleted, and another made.
 */
@Injectable()
export class CreditApplicationsService {
  constructor(
    @Inject(TENANCY_DB_CONNECTION)
    private readonly tenantKnex: () => Knex,
    private readonly uow: ExtUnitOfWork,
    private readonly externalIds: ExternalIdsService,
    private readonly lock: ExtLockService,
    private readonly ledger: TradeLedgerService,
    private readonly audit: ExtAuditService,
  ) {}

  /**
   * Applies an amount of a payment or a credit to a document. A repeat of
   * the external id with the same body answers the application; with
   * another body it is refused.
   * @param current Reads the source as its route answers it, for the answer
   *   to a stale version.
   */
  public async apply(
    source: ApplicationSource,
    input: ApplicationInput,
    current: () => Promise<unknown>,
  ): Promise<{ application: ApplicationView; replayed: boolean }> {
    const sourceKind = this.sourceKind(source.config);
    const { version: _version, ...sent } = input;
    const body = { ...sent, sourceKind, sourceId: source.id };
    const describe = async (id: number) => {
      const row = await this.rowOrThrow(id);
      return {
        state: 'live' as const,
        version: row.deletedAt ? null : Number(row.version),
      };
    };
    if (input.externalId) {
      // A repeat is answered before anything is checked: a retry must not
      // fail on what has changed since.
      const held = await this.externalIds.findRecordId(KIND, input.externalId);

      if (held !== null) {
        await this.externalIds.createOnce({
          kind: KIND,
          externalId: input.externalId,
          body,
          describe,
          create: async () => held,
          read: async (id) => id,
        });
        return { application: await this.get(held), replayed: true };
      }
    }
    const version = requireVersion(input.version);
    const cents = toCents(input.amount);

    if (cents <= 0n) {
      throw new ServiceError(
        TRADE_ERRORS.APPLICATION_AMOUNT_NOT_POSITIVE,
        'An application is of an amount above zero.',
        { amount: fromCents(cents) },
      );
    }
    let logged: number | null = null;
    const { recordId, created, replayed } = await refusingStale(
      () =>
        this.externalIds.createOnce({
          kind: KIND,
          externalId: input.externalId,
          body,
          describe,
          create: async (trx) => {
            const id = await this.write(source, input, cents, version, trx);
            logged = await this.audit.record(
              { action: 'create', subject: KIND, subjectId: id, index: true },
              trx,
            );
            return id;
          },
          read: async (id) => id,
        }),
      current,
    );
    const application = await this.get(recordId);
    if (created) await this.audit.finish(logged, application);
    return { application, replayed };
  }

  public async get(id: number): Promise<ApplicationView> {
    return this.view(await this.rowOrThrow(id));
  }

  /**
   * Deletes an application: its document owes the amount again and its
   * source has it back. Deleting a deleted application changes nothing.
   */
  public async delete(
    id: number,
    expected?: number | string | null,
  ): Promise<ApplicationView> {
    const found = await this.rowOrThrow(id);
    if (found.deletedAt) return this.view(found);

    const version = requireVersion(expected);
    const before = await this.view(found);

    await refusingStale(
      () =>
        this.uow.withTransaction(async (trx) => {
          const row = await this.rowOrThrow(id, trx);
          if (row.deletedAt) return;

          await raiseVersion(trx, APPLICATIONS_TABLE, { id }, version);
          await this.lock.assertOpen([row.appliedOn], trx);
          await this.remove(row, trx);
          await this.repost(row.sourceKind, Number(row.sourceId), trx);
          await this.audit.record(
            {
              action: 'delete',
              subject: KIND,
              subjectId: id,
              before,
              index: true,
            },
            trx,
          );
        }),
      () => this.get(id),
    );
    return this.get(id);
  }

  /**
   * Takes every live application of a payment out, as part of deleting the
   * payment. The payment's rows are written by the caller.
   */
  public async removeOfPayment(
    config: TradeConfig,
    paymentId: number,
    trx: Knex.Transaction,
  ): Promise<void> {
    const rows = await trx(APPLICATIONS_TABLE)
      .where({ sourceKind: config.paymentKind, sourceId: paymentId })
      .whereNull('deleted_at')
      .orderBy('id')
      .forUpdate();

    await this.lock.assertOpen(
      rows.map((row: any) => row.appliedOn),
      trx,
    );
    for (const row of rows) await this.remove(row, trx);
  }

  /** The applications made from sources of one kind, deleted ones left out. */
  public async fromSources(
    sourceKind: string,
    sourceIds: number[],
  ): Promise<ApplicationView[]> {
    if (sourceIds.length === 0) return [];
    return this.views(
      await this.tenantKnex()(APPLICATIONS_TABLE)
        .where({ sourceKind })
        .whereIn('sourceId', sourceIds)
        .whereNull('deleted_at')
        .orderBy(['applied_on', 'id']),
    );
  }

  /** The applications made to documents, deleted ones left out. */
  public async toDocuments(documentIds: number[]): Promise<ApplicationView[]> {
    if (documentIds.length === 0) return [];
    return this.views(
      await this.tenantKnex()(APPLICATIONS_TABLE)
        .whereIn('documentId', documentIds)
        .whereNull('deleted_at')
        .orderBy(['applied_on', 'id']),
    );
  }

  /** The kind an application records its source by. */
  private sourceKind(config: TradeConfig): ExtRecordKind {
    return config.credit ? config.documentKind : config.paymentKind;
  }

  private async write(
    source: ApplicationSource,
    input: ApplicationInput,
    cents: bigint,
    version: number,
    trx: Knex.Transaction,
  ): Promise<number> {
    const { config } = source;
    const target = config.credit ? config.appliesTo : config;
    const sourceKind = this.sourceKind(config);
    const documentId = Number(input.documentId);
    const missing = (of: TradeConfig, payment: boolean, id: number): never => {
      throw new ServiceError(
        payment ? of.errors.paymentNotFound : of.errors.documentNotFound,
        `The ${payment ? of.nouns.payment : of.nouns.document} was not found.`,
        { [payment ? of.idKeys.payment : of.idKeys.document]: id },
        HttpStatus.NOT_FOUND,
      );
    };
    // Documents are locked lowest id first, so that two applications
    // between the same two cannot wait on each other.
    const documentIds = [
      ...new Set(config.credit ? [source.id, documentId] : [documentId]),
    ].filter(Number.isInteger);
    const payment = config.credit
      ? null
      : Number.isInteger(source.id)
        ? await trx(PAYMENTS_TABLE)
            .where({ id: source.id, kind: config.paymentKind })
            .forUpdate()
            .first()
        : null;
    const documents = documentIds.length
      ? await trx(DOCUMENTS_TABLE)
          .whereIn('id', documentIds)
          .orderBy('id')
          .forUpdate()
      : [];
    const find = (id: number, kind: string) =>
      documents.find((row: any) => Number(row.id) === id && row.kind === kind);
    const credit = config.credit ? find(source.id, config.documentKind) : null;
    const document = find(documentId, target.documentKind);

    if (config.credit ? !credit : !payment || payment.deletedAt) {
      missing(config, !config.credit, source.id);
    }
    if (!document) missing(target, false, documentId);

    for (const [row, of] of [
      [credit, config],
      [document, target],
    ] as const) {
      if (row?.voidedAt) {
        throw new ServiceError(
          of.errors.voided,
          `The ${of.nouns.document} is voided and takes no application.`,
          { [of.idKeys.document]: Number(row.id) },
        );
      }
    }
    const from = credit ?? payment;

    if (
      from.partyId === null ||
      from.partyId === undefined ||
      Number(from.partyId) !== Number(document.partyId)
    ) {
      throw new ServiceError(
        TRADE_ERRORS.APPLICATION_OF_ANOTHER_PARTY,
        `The ${target.nouns.document} is of another ${target.nouns.party}.`,
        { [target.idKeys.document]: documentId },
      );
    }
    const unapplied = credit
      ? toCents(String(credit.amount)) -
        (await this.ledger.paidOn(config, source.id, trx))
      : await this.unappliedOfPayment(payment, trx);

    if (cents > unapplied) {
      throw new ServiceError(
        TRADE_ERRORS.APPLICATION_EXCEEDS_UNAPPLIED,
        `The application of ${fromCents(cents)} is more than the ${fromCents(unapplied)} left unapplied.`,
        { amount: fromCents(cents), unapplied: fromCents(unapplied) },
      );
    }
    const owed =
      toCents(String(document.amount)) -
      (await this.ledger.paidOn(target, documentId, trx));

    if (cents > owed) {
      throw new ServiceError(
        target.errors.allocationExceedsBalance,
        `The application of ${fromCents(cents)} is to a ${target.nouns.document} that owes ${fromCents(owed)}.`,
        {
          [target.idKeys.document]: documentId,
          allocated: fromCents(cents),
          balance: fromCents(owed),
        },
      );
    }
    // Dated the later of the two days. Plain dates sort as text.
    const sourceDay: string = credit ? credit.postedOn : payment.paidOn;
    const appliedOn =
      sourceDay > document.postedOn ? sourceDay : document.postedOn;

    await this.lock.assertOpen([appliedOn], trx);
    await raiseVersion(
      trx,
      credit ? DOCUMENTS_TABLE : PAYMENTS_TABLE,
      { id: source.id },
      version,
    );
    await raiseVersion(trx, DOCUMENTS_TABLE, { id: documentId });

    const [id] = await trx(APPLICATIONS_TABLE).insert({
      sourceKind,
      sourceId: source.id,
      documentId,
      amount: fromCents(cents),
      appliedOn,
      // The lines as they stand now, each with its share of the amount: what
      // the cash basis posts, whatever either document is edited to later.
      lines: JSON.stringify(
        await this.ledger.sharedSnapshot(target, documentId, cents, trx),
      ),
      sourceLines: credit
        ? JSON.stringify(
            await this.ledger.sharedSnapshot(config, source.id, cents, trx),
          )
        : null,
      createdAt: trx.fn.now(),
      updatedAt: trx.fn.now(),
    });
    await this.repost(sourceKind, source.id, trx);
    return id;
  }

  /** What a payment has left: its amount less its parts and applications. */
  private async unappliedOfPayment(
    payment: any,
    trx: Knex.Transaction,
  ): Promise<bigint> {
    const sum = (rows: any[]) =>
      rows.reduce(
        (total: bigint, row: any) => total + toCents(String(row.amount)),
        0n,
      );
    const parts = await trx(ALLOCATIONS_TABLE)
      .where({ paymentId: payment.id })
      .select('amount as amount');
    const applied = await trx(APPLICATIONS_TABLE)
      .where({ sourceKind: payment.kind, sourceId: payment.id })
      .whereNull('deleted_at')
      .select('amount as amount');

    return toCents(String(payment.amount)) - sum(parts) - sum(applied);
  }

  /** Marks an application deleted, and moves on what it lies between. */
  private async remove(row: any, trx: Knex.Transaction): Promise<void> {
    const id = Number(row.id);
    const payment =
      row.sourceKind === ExtRecordKind.BillPayment ||
      row.sourceKind === ExtRecordKind.PaymentReceived;

    await trx(APPLICATIONS_TABLE).where({ id }).update({
      deletedAt: new Date().toISOString(),
      updatedAt: trx.fn.now(),
    });
    await raiseVersion(trx, payment ? PAYMENTS_TABLE : DOCUMENTS_TABLE, {
      id: Number(row.sourceId),
    });
    await raiseVersion(trx, DOCUMENTS_TABLE, { id: Number(row.documentId) });
    // The application's external id stays its own: it is not used again.
    await this.externalIds.markDeleted(KIND, id, trx);
  }

  /** Writes again the ledger rows of an application's source. */
  private async repost(
    sourceKind: string,
    sourceId: number,
    trx: Knex.Transaction,
  ): Promise<void> {
    const config = SOURCES[sourceKind];

    if (config.credit) await this.ledger.postDocument(config, sourceId, trx);
    else await this.ledger.postPayment(config, sourceId, trx);
  }

  private async rowOrThrow(id: number, trx?: Knex.Transaction): Promise<any> {
    let row = null;

    if (Number.isInteger(id)) {
      const query = (trx ?? this.tenantKnex())(APPLICATIONS_TABLE)
        .where({ id })
        .first();
      row = await (trx ? query.forUpdate() : query);
    }
    if (!row) {
      throw new ServiceError(
        TRADE_ERRORS.CREDIT_APPLICATION_NOT_FOUND,
        'The credit application was not found.',
        { applicationId: id },
        HttpStatus.NOT_FOUND,
      );
    }
    return row;
  }

  private async view(row: any): Promise<ApplicationView> {
    return (await this.views([row]))[0];
  }

  private async views(rows: any[]): Promise<ApplicationView[]> {
    const live = rows
      .filter((row) => !row.deletedAt)
      .map((row) => Number(row.id));
    const externalIds = await this.externalIds.findExternalIds(KIND, live);

    return Promise.all(
      rows.map(async (row) => {
        const id = Number(row.id);

        return {
          id,
          // A deleted application keeps its external id, and is shown with it.
          externalId: row.deletedAt
            ? await this.externalIds.findLastExternalId(KIND, id)
            : (externalIds.get(id) ?? null),
          version: Number(row.version),
          sourceKind: row.sourceKind,
          sourceId: Number(row.sourceId),
          documentId: Number(row.documentId),
          amount: fromCents(toCents(String(row.amount))),
          appliedOn: row.appliedOn,
          deletedAt: row.deletedAt ?? null,
          createdAt: toIso(row.createdAt),
        };
      }),
    );
  }
}
