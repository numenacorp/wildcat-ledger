import { Knex } from 'knex';
import { Inject, Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { TENANCY_DB_CONNECTION } from '@/modules/Tenancy/TenancyDB/TenancyDB.constants';
import { ExtLinesService } from '../common/ExtLines.service';
import {
  LedgerPostingsService,
  Posting,
  PostingContext,
} from '../common/LedgerPostings.service';
import { prorate, toCents } from '../common/money';
import { ExtMarkedAccountsService } from '../Accounts/ExtMarkedAccounts.service';
import { ExtTrackingService } from '../Tracking/ExtTracking.service';
import { LedgerWorkspacesService } from '../Workspaces/LedgerWorkspaces.service';
import { CREDIT_BALANCE_METHOD, TradeConfig } from './trade.config';
import { TradeSide } from './trade.constants';

export const DOCUMENTS_TABLE = 'ext_trade_documents';
export const PAYMENTS_TABLE = 'ext_payments';
export const ALLOCATIONS_TABLE = 'ext_payment_allocations';

/** A document line as a payment sees it. */
export interface SnapshotLine {
  accountId: number;
  /** Whole cents, as a string. */
  cents: string;
  lineIndex: number;
  tracking: Array<{ categoryId: number; optionId: number }>;
}

/**
 * What bills, invoices and their payments post to the ledger.
 *
 * A bill debits each line's account and credits the payable account its
 * total, on the bill's day, on the accrual basis only. An invoice is the
 * mirror: receivable debited, each line's account credited.
 *
 * A bill payment posts, for each bill it pays:
 *  - on the accrual basis, on the BILL's day: payable debited, the paying
 *    account credited;
 *  - on the cash basis, on the day it was paid: the bill's lines debited in
 *    proportion to what was paid, as they stood when the payment was made,
 *    and the paying account credited.
 * What it pays beyond its bills is an expense on the day it was paid, on
 * both bases.
 *
 * An invoice payment posts everything on the day it was paid:
 *  - on the accrual basis: the receiving account debited, receivable
 *    credited;
 *  - on the cash basis: the receiving account debited and the invoice's
 *    lines, as they stand now, credited in proportion.
 * A payment that redeems a credit balance moves no cash: it debits the
 * account the balance is held in, and on the cash basis the sales account
 * instead. What it brings in beyond its invoices is income on that day, on
 * both bases.
 */
@Injectable()
export class TradeLedgerService {
  constructor(
    @Inject(TENANCY_DB_CONNECTION)
    private readonly tenantKnex: () => Knex,
    private readonly cls: ClsService,
    private readonly postings: LedgerPostingsService,
    private readonly lines: ExtLinesService,
    private readonly tracking: ExtTrackingService,
    private readonly marked: ExtMarkedAccountsService,
    private readonly workspaces: LedgerWorkspacesService,
  ) {}

  /**
   * The lines of a document as a payment made now would see them.
   */
  public async snapshot(
    config: TradeConfig,
    documentId: number,
    trx: Knex.Transaction,
  ): Promise<SnapshotLine[]> {
    const lines = await this.lines.list(config.lineKind, documentId, trx);
    const tracking = await this.tracking.ofLines(
      lines.map((line) => line.id),
      trx,
    );
    return lines.map((line) => ({
      accountId: line.accountId,
      cents: toCents(line.amount ?? '0').toString(),
      lineIndex: line.index,
      tracking: (tracking.get(line.id) ?? []).map((t) => ({
        categoryId: t.categoryId,
        optionId: t.optionId,
      })),
    }));
  }

  /**
   * What is paid on a document by payments that have not been deleted,
   * leaving out one payment when it is the one being replaced.
   */
  public async paidOn(
    config: TradeConfig,
    documentId: number,
    trx?: Knex.Transaction,
    exceptPaymentId?: number,
  ): Promise<bigint> {
    const query = (trx ?? this.tenantKnex())(`${ALLOCATIONS_TABLE} as a`)
      .join(`${PAYMENTS_TABLE} as p`, 'p.id', 'a.payment_id')
      .where('a.document_id', documentId)
      .where('p.kind', config.paymentKind)
      .whereNull('p.deleted_at')
      .select('a.amount as amount');
    if (exceptPaymentId !== undefined) query.whereNot('p.id', exceptPaymentId);

    const rows = await query;
    return rows.reduce(
      (sum: bigint, row: any) => sum + toCents(String(row.amount)),
      0n,
    );
  }

  /**
   * Writes the ledger rows of a document as it now stands. A voided document
   * has none.
   */
  public async postDocument(
    config: TradeConfig,
    documentId: number,
    trx: Knex.Transaction,
  ): Promise<void> {
    const document = await trx(DOCUMENTS_TABLE)
      .where({ id: documentId, kind: config.documentKind })
      .first();

    if (!document || document.voidedAt) {
      await this.postings.remove(config.documentReference, documentId, trx);
      return;
    }
    // A bill's lines are debits and its control account a credit; an
    // invoice's are the other way round.
    const sign = config.side === TradeSide.Payable ? 1n : -1n;
    const lines = await this.snapshot(config, documentId, trx);
    const total = lines.reduce((sum, line) => sum + BigInt(line.cents), 0n);
    const postings: Posting[] = lines.map((line) => ({
      accountId: line.accountId,
      cents: sign * BigInt(line.cents),
      postedAt: document.postedAt,
      basis: 'accrual',
      lineIndex: line.lineIndex,
      tracking: line.tracking,
    }));

    if (total !== 0n) {
      postings.push({
        accountId: await this.controlAccountId(config, trx),
        cents: -sign * total,
        postedAt: document.postedAt,
        basis: 'accrual',
        contactId: Number(document.partyId),
      });
    }
    await this.postings.replace(
      await this.context(
        config.documentReference,
        documentId,
        document.number,
        document.reference,
      ),
      postings,
      trx,
    );
  }

  /**
   * Writes the ledger rows of a payment as it now stands. A deleted payment
   * has none.
   */
  public async postPayment(
    config: TradeConfig,
    paymentId: number,
    trx: Knex.Transaction,
  ): Promise<void> {
    const payment = await trx(PAYMENTS_TABLE)
      .where({ id: paymentId, kind: config.paymentKind })
      .first();

    if (!payment || payment.deletedAt) {
      await this.postings.remove(config.paymentReference, paymentId, trx);
      return;
    }
    const parts = await trx(ALLOCATIONS_TABLE)
      .where({ paymentId })
      .orderBy('index');
    // A part pays a document, or is paid to an account in its place.
    const allocations = parts.filter((part: any) => part.documentId !== null);
    const accountParts = parts.filter((part: any) => part.documentId === null);
    const documents = allocations.length
      ? await trx(DOCUMENTS_TABLE).whereIn(
          'id',
          allocations.map((a: any) => a.documentId),
        )
      : [];
    const documentById = new Map(
      documents.map((document: any) => [Number(document.id), document]),
    );
    const amount = toCents(String(payment.amount));
    const allocated = parts.reduce(
      (sum: bigint, a: any) => sum + toCents(String(a.amount)),
      0n,
    );
    const postings: Posting[] =
      amount === 0n
        ? []
        : config.side === TradeSide.Payable
          ? await this.billPaymentPostings(
              config,
              payment,
              allocations,
              documentById,
              amount - allocated,
              trx,
            )
          : await this.invoicePaymentPostings(
              config,
              payment,
              allocations,
              documentById,
              amount - allocated,
              trx,
              accountParts,
            );

    await this.postings.replace(
      await this.context(
        config.paymentReference,
        paymentId,
        null,
        payment.reference,
      ),
      postings,
      trx,
    );
  }

  /**
   * Writes again the rows of every live payment of a document, after the
   * document changed in a way its payments' rows depend on.
   */
  public async repostPaymentsOf(
    config: TradeConfig,
    documentId: number,
    trx: Knex.Transaction,
  ): Promise<void> {
    const rows = await trx(`${ALLOCATIONS_TABLE} as a`)
      .join(`${PAYMENTS_TABLE} as p`, 'p.id', 'a.payment_id')
      .where('a.document_id', documentId)
      .where('p.kind', config.paymentKind)
      .distinct('p.id as id');
    // The payments are locked and read again, lowest id first. A delete of
    // one of them that is under way is waited for, and is then seen: read
    // without the lock, its rows would be written back after it removed them.
    const live = rows.length
      ? await trx(PAYMENTS_TABLE)
          .whereIn(
            'id',
            rows.map((row: any) => Number(row.id)),
          )
          .orderBy('id')
          .forUpdate()
      : [];

    for (const payment of live) {
      if (!payment.deletedAt) {
        await this.postPayment(config, Number(payment.id), trx);
      }
    }
  }

  private async billPaymentPostings(
    config: TradeConfig,
    payment: any,
    allocations: any[],
    billById: Map<number, any>,
    excess: bigint,
    trx: Knex.Transaction,
  ): Promise<Posting[]> {
    const postings: Posting[] = [];
    const from =
      payment.accountId !== null && payment.accountId !== undefined
        ? Number(payment.accountId)
        : await this.marked.get('payments-out-clearing', trx);
    const payable = allocations.length
      ? await this.controlAccountId(config, trx)
      : 0;

    for (const allocation of allocations) {
      const cents = toCents(String(allocation.amount));
      const bill = billById.get(Number(allocation.documentId));
      const lines: SnapshotLine[] = JSON.parse(allocation.lines);

      // Accrual: payable down and the paying account down, on the bill's day.
      postings.push(
        {
          accountId: payable,
          cents,
          postedAt: bill.postedAt,
          basis: 'accrual',
          contactId: Number(bill.partyId),
        },
        {
          accountId: from,
          cents: -cents,
          postedAt: bill.postedAt,
          basis: 'accrual',
        },
      );
      // Cash: the bill's lines in proportion, on the day it was paid.
      prorate(
        cents,
        lines.map((line) => BigInt(line.cents)),
      ).forEach((share, n) =>
        postings.push({
          accountId: lines[n].accountId,
          cents: share,
          postedAt: payment.paidAt,
          basis: 'cash',
          lineIndex: lines[n].lineIndex,
          tracking: lines[n].tracking,
        }),
      );
      postings.push({
        accountId: from,
        cents: -cents,
        postedAt: payment.paidAt,
        basis: 'cash',
      });
    }
    if (excess !== 0n) {
      postings.push(
        {
          accountId: await this.marked.get('uncategorized-expense', trx),
          cents: excess,
          postedAt: payment.paidAt,
          basis: null,
        },
        {
          accountId: from,
          cents: -excess,
          postedAt: payment.paidAt,
          basis: null,
        },
      );
    }
    return postings;
  }

  private async invoicePaymentPostings(
    config: TradeConfig,
    payment: any,
    allocations: any[],
    invoiceById: Map<number, any>,
    excess: bigint,
    trx: Knex.Transaction,
    accountParts: any[] = [],
  ): Promise<Posting[]> {
    const postings: Posting[] = [];
    const paidAt: string = payment.paidAt;
    const redeemed = payment.method === CREDIT_BALANCE_METHOD;
    const named = redeemed ? payment.redemptionAccountId : payment.accountId;
    const into =
      named !== null && named !== undefined
        ? Number(named)
        : await this.marked.get(
            redeemed ? 'unearned-revenue' : 'payments-in-clearing',
            trx,
          );
    const receivable = allocations.length
      ? await this.controlAccountId(config, trx)
      : 0;
    // A redeemed credit balance moves no cash: on the cash basis the income
    // it recognises comes out of the sales account.
    const cashInto =
      redeemed && allocations.length
        ? await this.marked.get('sales', trx)
        : into;

    for (const allocation of allocations) {
      const cents = toCents(String(allocation.amount));
      const invoice = invoiceById.get(Number(allocation.documentId));
      // The invoice's lines as they stand now.
      const lines = await this.snapshot(config, Number(invoice.id), trx);

      postings.push(
        { accountId: into, cents, postedAt: paidAt, basis: 'accrual' },
        {
          accountId: receivable,
          cents: -cents,
          postedAt: paidAt,
          basis: 'accrual',
          contactId: Number(invoice.partyId),
        },
        { accountId: cashInto, cents, postedAt: paidAt, basis: 'cash' },
      );
      prorate(
        cents,
        lines.map((line) => BigInt(line.cents)),
      ).forEach((share, n) =>
        postings.push({
          accountId: lines[n].accountId,
          cents: -share,
          postedAt: paidAt,
          basis: 'cash',
          lineIndex: lines[n].lineIndex,
          tracking: lines[n].tracking,
        }),
      );
    }
    // A part paid to an account credits it on both bases, against the
    // account the money came into.
    for (const part of accountParts) {
      const cents = toCents(String(part.amount));

      postings.push(
        { accountId: into, cents, postedAt: paidAt, basis: null },
        {
          accountId: Number(part.accountId),
          cents: -cents,
          postedAt: paidAt,
          basis: null,
          note: part.memo ?? undefined,
        },
      );
    }
    if (excess !== 0n) {
      postings.push(
        { accountId: into, cents: excess, postedAt: paidAt, basis: null },
        {
          accountId: await this.marked.get('uncategorized-income', trx),
          cents: -excess,
          postedAt: paidAt,
          basis: null,
        },
      );
    }
    return postings;
  }

  /** The one payable, or receivable, account of the presented chart. */
  private async controlAccountId(
    config: TradeConfig,
    trx: Knex.Transaction,
  ): Promise<number> {
    const account = await trx('accounts as a')
      .join('ext_account_tree as n', 'n.account_id', 'a.id')
      .where(
        'a.account_type',
        config.side === TradeSide.Payable
          ? 'accounts-payable'
          : 'accounts-receivable',
      )
      .orderBy('a.id')
      .first('a.id as id');
    return Number(account.id);
  }

  private async context(
    referenceType: string,
    referenceId: number,
    number?: string | null,
    reference?: string | null,
  ): Promise<PostingContext> {
    const workspace = await this.workspaces.findByOrganization(
      this.cls.get('organizationId'),
    );
    return {
      referenceType,
      referenceId,
      timezone: workspace?.timezone || 'UTC',
      currencyCode: workspace?.baseCurrency,
      number: number ?? null,
      reference: reference ?? null,
    };
  }
}
