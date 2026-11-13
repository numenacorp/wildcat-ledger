import { Knex } from 'knex';
import { Inject, Injectable } from '@nestjs/common';
import { TENANCY_DB_CONNECTION } from '@/modules/Tenancy/TenancyDB/TenancyDB.constants';
import { ExternalIdsService } from '../common/ExternalIds.service';
import { ExtMetadataService } from '../common/ExtMetadata.service';
import { fromCents, toCents } from '../common/money';
import {
  LedgerAccountBrief,
  LedgerAccountsService,
} from '../Accounts/LedgerAccounts.service';
import {
  ApplicationView,
  CreditApplicationsService,
} from './CreditApplications.service';
import { ExtPartiesService, PartyKind, PartyView } from './ExtParties.service';
import { ALLOCATIONS_TABLE, PAYMENTS_TABLE } from './TradeLedger.service';
import { TradeConfig } from './trade.config';

/** A payment of bills or of invoices, before it is put in either's words. */
export interface TradePaymentView {
  id: number;
  externalId: string | null;
  /** Raised when the payment is deleted. */
  version: number;
  paidOn: string;
  method: string | null;
  processor: string | null;
  amount: string;
  /**
   * What the payment has left: its amount less its parts and what has been
   * applied from it since. A credit with its party.
   */
  unapplied: string;
  /** The account the request named, or null when it named none. */
  account: LedgerAccountBrief | null;
  /** The account a redeemed credit balance was taken from, when named. */
  redemptionAccount: LedgerAccountBrief | null;
  /** The party the payment named, when payments of its kind name one. */
  party: PartyView | null;
  reference: string | null;
  note: string | null;
  metadata: Record<string, unknown> | null;
  /** Empty once the payment is deleted. */
  /**
   * The parts that pay documents, then the parts paid to an account, each in
   * the order sent.
   */
  allocations: Array<{
    id: number;
    documentId: number | null;
    accountId: number | null;
    memo: string | null;
    amount: string;
  }>;
  /** What was applied from the payment after it was made, oldest first. */
  applications: ApplicationView[];
  createdAt: string | null;
}

export const toIso = (value: unknown): string | null =>
  value ? new Date(value as any).toISOString() : null;

/**
 * Reads payments as callers see them.
 */
@Injectable()
export class TradePaymentViewsService {
  constructor(
    @Inject(TENANCY_DB_CONNECTION)
    private readonly tenantKnex: () => Knex,
    private readonly externalIds: ExternalIdsService,
    private readonly metadata: ExtMetadataService,
    private readonly accounts: LedgerAccountsService,
    private readonly parties: ExtPartiesService,
    private readonly applications: CreditApplicationsService,
  ) {}

  /**
   * Payments of one side keyed by id, deleted ones included.
   */
  public async payments(
    config: TradeConfig,
    paymentIds: number[],
  ): Promise<Map<number, TradePaymentView>> {
    const ids = [...new Set(paymentIds)];
    const views = new Map<number, TradePaymentView>();
    if (ids.length === 0) return views;

    const kind = config.paymentKind;
    const knex = this.tenantKnex();
    const [payments, allocations, externalIds, metadata, applications] =
      await Promise.all([
        knex(PAYMENTS_TABLE).where({ kind }).whereIn('id', ids),
        knex(ALLOCATIONS_TABLE)
          .whereIn('paymentId', ids)
          .orderBy(['paymentId', 'index']),
        this.externalIds.findExternalIds(kind, ids),
        this.metadata.getMany(kind, ids),
        this.applications.fromSources(kind, ids),
      ]);
    const present = (value: unknown) => value !== null && value !== undefined;
    const [briefs, parties] = await Promise.all([
      this.accounts.briefs(
        payments
          .flatMap((p: any) => [p.accountId, p.redemptionAccountId])
          .filter(present)
          .map(Number),
      ),
      this.parties.views(
        config.partyKind as PartyKind,
        payments
          .map((p: any) => p.partyId)
          .filter(present)
          .map(Number),
      ),
    ]);
    for (const payment of payments) {
      const id = Number(payment.id);
      const deleted = Boolean(payment.deletedAt);
      const applied = applications.filter((a) => a.sourceId === id);
      const used = [
        ...allocations.filter((a: any) => Number(a.paymentId) === id),
        ...applied,
      ].reduce((sum, a: any) => sum + toCents(String(a.amount)), 0n);

      views.set(id, {
        id,
        // A deleted payment keeps its external id, and is shown with it.
        externalId: deleted
          ? await this.externalIds.findLastExternalId(kind, id)
          : (externalIds.get(id) ?? null),
        version: Number(payment.version),
        paidOn: payment.paidOn,
        method: payment.method ?? null,
        processor: payment.processor ?? null,
        amount: fromCents(toCents(String(payment.amount))),
        // A deleted payment has nothing left to apply.
        unapplied: fromCents(
          deleted ? 0n : toCents(String(payment.amount)) - used,
        ),
        account: present(payment.accountId)
          ? (briefs.get(Number(payment.accountId)) ?? null)
          : null,
        redemptionAccount: present(payment.redemptionAccountId)
          ? (briefs.get(Number(payment.redemptionAccountId)) ?? null)
          : null,
        party: present(payment.partyId)
          ? (parties.get(Number(payment.partyId)) ?? null)
          : null,
        reference: payment.reference ?? null,
        note: payment.note ?? null,
        metadata: metadata.get(id) ?? null,
        allocations: deleted
          ? []
          : allocations
              .filter((a: any) => Number(a.paymentId) === id)
              .sort(
                (a: any, b: any) =>
                  Number(a.documentId === null) - Number(b.documentId === null),
              )
              .map((a: any) => ({
                id: Number(a.id),
                documentId: a.documentId === null ? null : Number(a.documentId),
                accountId: a.accountId === null ? null : Number(a.accountId),
                memo: a.memo ?? null,
                amount: fromCents(toCents(String(a.amount))),
              })),
        applications: applied,
        createdAt: toIso(payment.createdAt),
      });
    }
    return views;
  }
}
