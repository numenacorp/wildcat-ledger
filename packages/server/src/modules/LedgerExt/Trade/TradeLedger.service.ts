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
import { shareOut, toCents } from '../common/money';
import { ServiceError } from '@/modules/Items/ServiceError';
import { OPENING_EQUITY_SLUG } from '../Books/books.constants';
import { MARKED_ACCOUNT_ERRORS } from '../Accounts/markedAccounts';
import { ExtMarkedAccountsService } from '../Accounts/ExtMarkedAccounts.service';
import { ExtTrackingService } from '../Tracking/ExtTracking.service';
import { LedgerWorkspacesService } from '../Workspaces/LedgerWorkspaces.service';
import { CREDIT_BALANCE_METHOD, TradeConfig, creditsOf } from './trade.config';
import { TradeSide } from './trade.constants';

export const DOCUMENTS_TABLE = 'ext_trade_documents';
export const PAYMENTS_TABLE = 'ext_payments';
export const ALLOCATIONS_TABLE = 'ext_payment_allocations';
export const APPLICATIONS_TABLE = 'ext_credit_applications';

/** A document line as a payment sees it. */
export interface SnapshotLine {
  /** The line's own id, by which a later payment finds what it was paid. */
  lineId?: number;
  accountId: number;
  /** Whole cents, as a string. */
  cents: string;
  lineIndex: number;
  tracking: Array<{ categoryId: number; optionId: number }>;
  /**
   * What the payment that holds this snapshot paid of the line, in whole
   * cents, as a string. Settled when the payment is written, and kept.
   */
  share?: string;
}

/**
 * What bills, invoices and their payments post to the ledger.
 *
 * A bill debits each line's account and credits the payable account its
 * total, on the bill's day, on the accrual basis only. An invoice is the
 * mirror: receivable debited, each line's account credited.
 *
 * A payment posts everything on the day it was paid. A bill payment, for
 * each bill it pays:
 *  - on the accrual basis: payable debited, the paying account credited;
 *  - on the cash basis: each line of the bill debited its share of the
 *    payment, and the paying account credited.
 * What it pays beyond its bills is a credit with the vendor: on the accrual
 * basis it debits payables, with the vendor; on the cash basis it is an
 * expense on that day, in the account marked for unapplied cash.
 *
 * An invoice payment is the mirror:
 *  - on the accrual basis: the receiving account debited, receivable
 *    credited;
 *  - on the cash basis: the receiving account debited and each line of the
 *    invoice credited its share.
 *
 * A line's share of a payment is settled when the payment is written and
 * does not change after: the payment is shared out over what is still
 * unpaid on each line (`sharedSnapshot`). So the payment that settles a
 * document leaves each line paid exactly its amount, and no later payment
 * moves an entry already posted. A document's day, party and lines' accounts
 * and amounts cannot be edited while anything is paid on it or applied.
 *
 * A payment that redeems a credit balance moves no cash: it debits the
 * account the balance is held in, and on the cash basis the sales account
 * instead. What it brings in beyond its invoices is a credit with the
 * customer: receivables credited on the accrual basis, and income on that
 * day on the cash basis, in the account marked for unapplied cash.
 *
 * A credit document is its side's document with the signs turned: a vendor
 * credit debits payables and credits its lines.
 *
 * An application sets money a payment left over, or a credit document,
 * against a document. On the accrual basis it posts nothing: both sides are
 * on the control account already. On the cash basis, on its own day, the
 * document's lines take their shares; the other side is the unapplied cash
 * account for a payment, and the credit's own lines for a credit.
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
      lineId: line.id,
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
   * The lines of a document, each with its share of a payment of the given
   * amount made now.
   *
   * The payment is shared out over what is still unpaid on each line: the
   * line less the shares that live payments and applications already hold
   * of it. The lines of a document cannot change while anything is paid on
   * it or applied, so each share is still of the line it was made on. Where
   * nothing is unpaid on the lines taken together, the payment is shared
   * over the lines' own amounts.
   *
   * The rows of the payment being written must already be out of the way,
   * and its earlier parts on the same document already in.
   */
  public async sharedSnapshot(
    config: TradeConfig,
    documentId: number,
    cents: bigint,
    trx: Knex.Transaction,
  ): Promise<SnapshotLine[]> {
    const lines = await this.snapshot(config, documentId, trx);
    const unpaid = lines.map((line) => BigInt(line.cents));
    // What holds shares of the lines already: for a credit, the
    // applications made from it; otherwise the payments of the document and
    // the applications to it.
    const earlier = config.credit
      ? await trx(APPLICATIONS_TABLE)
          .where({ sourceKind: config.documentKind, sourceId: documentId })
          .whereNull('deleted_at')
          .select('amount as amount', 'source_lines as lines')
      : [
          ...(await trx(`${ALLOCATIONS_TABLE} as a`)
            .join(`${PAYMENTS_TABLE} as p`, 'p.id', 'a.payment_id')
            .where('a.document_id', documentId)
            .where('p.kind', config.paymentKind)
            .whereNull('p.deleted_at')
            .select('a.amount as amount', 'a.lines as lines')),
          ...(await trx(APPLICATIONS_TABLE)
            .where({ documentId })
            .whereNull('deleted_at')
            .select('amount as amount', 'lines as lines')),
        ];

    for (const allocation of earlier) {
      for (const paid of this.shares(allocation)) {
        // A share kept before lines carried their ids is found by its place.
        const at = lines.findIndex((line) =>
          paid.lineId !== undefined
            ? line.lineId === paid.lineId
            : line.lineIndex === paid.lineIndex,
        );
        if (at !== -1) unpaid[at] -= BigInt(paid.share);
      }
    }
    const left = unpaid.reduce((sum, line) => sum + line, 0n);
    const shares = shareOut(
      cents,
      left === 0n ? lines.map((line) => BigInt(line.cents)) : unpaid,
    );
    return lines.map((line, n) => ({ ...line, share: shares[n].toString() }));
  }

  /**
   * The lines a part of a payment holds, each with the share of the part it
   * was paid. A part written before shares were kept is shared over its
   * lines' amounts.
   */
  private shares(allocation: any): Array<SnapshotLine & { share: string }> {
    const lines: SnapshotLine[] = JSON.parse(allocation.lines || '[]');
    if (lines.every((line) => line.share !== undefined)) {
      return lines as Array<SnapshotLine & { share: string }>;
    }
    const shares = shareOut(
      toCents(String(allocation.amount)),
      lines.map((line) => BigInt(line.cents)),
    );
    return lines.map((line, n) => ({ ...line, share: shares[n].toString() }));
  }

  /**
   * The cash-basis lines of a part of a payment: each line's account and its
   * share, with the tags the line carries now. A line the document no
   * longer has keeps the tags it had when it was paid.
   */
  private async cashLines(
    config: TradeConfig,
    allocation: any,
    trx: Knex.Transaction,
  ): Promise<Array<SnapshotLine & { share: string }>> {
    const held = this.shares(allocation);
    const current = await this.snapshot(
      config,
      Number(allocation.documentId),
      trx,
    );
    const tagsNow = new Map(
      current.map((line) => [line.lineId, line.tracking]),
    );

    return held.map((line) =>
      line.lineId !== undefined && tagsNow.has(line.lineId)
        ? { ...line, tracking: tagsNow.get(line.lineId) }
        : line,
    );
  }

  /**
   * What is settled on a document: paid by payments that have not been
   * deleted, leaving out one payment when it is the one being replaced, and
   * applied to it from credits. For a credit: what is applied from it.
   */
  public async paidOn(
    config: TradeConfig,
    documentId: number,
    trx?: Knex.Transaction,
    exceptPaymentId?: number,
  ): Promise<bigint> {
    const knex = trx ?? this.tenantKnex();
    const applied = await knex(APPLICATIONS_TABLE)
      .where(
        config.credit
          ? { sourceKind: config.documentKind, sourceId: documentId }
          : { documentId },
      )
      .whereNull('deleted_at')
      .select('amount as amount');
    const query = knex(`${ALLOCATIONS_TABLE} as a`)
      .join(`${PAYMENTS_TABLE} as p`, 'p.id', 'a.payment_id')
      .where('a.document_id', documentId)
      .where('p.kind', config.paymentKind)
      .whereNull('p.deleted_at')
      .select('a.amount as amount');
    if (exceptPaymentId !== undefined) query.whereNot('p.id', exceptPaymentId);

    const rows = config.credit ? applied : [...(await query), ...applied];
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
    // invoice's are the other way round, and a credit's the other way again.
    const sign =
      (config.side === TradeSide.Payable ? 1n : -1n) *
      (config.credit ? -1n : 1n);
    const lines = await this.snapshot(config, documentId, trx);
    const total = lines.reduce((sum, line) => sum + BigInt(line.cents), 0n);
    const postedOn = await this.entryDay(document);
    // An opening document's lines are not posted: the books it came from
    // took them. Its total stands against opening balance equity.
    const postings: Posting[] = document.opening
      ? total === 0n
        ? []
        : [
            {
              accountId: await this.openingEquityAccountId(trx),
              cents: sign * total,
              postedOn,
              basis: 'accrual',
            },
          ]
      : lines.map((line) => ({
          accountId: line.accountId,
          cents: sign * BigInt(line.cents),
          postedOn,
          basis: 'accrual',
          lineIndex: line.lineIndex,
          tracking: line.tracking,
        }));

    if (total !== 0n) {
      postings.push({
        accountId: await this.controlAccountId(config, trx),
        cents: -sign * total,
        postedOn,
        basis: 'accrual',
        contactId: Number(document.partyId),
      });
    }
    if (config.credit) {
      // Cash basis: an applied credit counts as a payment. The document's
      // lines take their shares and the credit's own lines the opposite,
      // both on the day of the application.
      for (const application of await this.applicationsFrom(
        config.documentKind,
        documentId,
        trx,
      )) {
        const to = await this.cashLines(config.appliesTo, application, trx);
        const from = await this.cashLines(
          config,
          {
            lines: application.sourceLines,
            amount: application.amount,
            documentId,
          },
          trx,
        );
        for (const [lines, direction] of [
          [to, -sign],
          [from, sign],
        ] as const) {
          for (const line of lines) {
            postings.push({
              accountId: line.accountId,
              cents: direction * BigInt(line.share),
              postedOn: application.appliedOn,
              basis: 'cash',
              lineIndex: line.lineIndex,
              tracking: line.tracking,
            });
          }
        }
      }
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
    const applications = await this.applicationsFrom(
      config.paymentKind,
      paymentId,
      trx,
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
              applications,
            )
          : await this.invoicePaymentPostings(
              config,
              payment,
              allocations,
              documentById,
              amount - allocated,
              trx,
              accountParts,
              applications,
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
    // What is applied to the document posts with its source: a payment, or
    // a credit document.
    const applied = await trx(APPLICATIONS_TABLE)
      .where({ documentId })
      .whereNull('deleted_at')
      .distinct('source_kind as kind', 'source_id as id');
    const credits = creditsOf(config);

    for (const source of applied) {
      if (source.kind === config.paymentKind) rows.push({ id: source.id });
      else if (source.kind === credits.documentKind) {
        await this.postDocument(credits, Number(source.id), trx);
      }
    }
    // The payments are locked and read again, lowest id first. A delete of
    // one of them that is under way is waited for, and is then seen: read
    // without the lock, its rows would be written back after it removed them.
    const live = rows.length
      ? await trx(PAYMENTS_TABLE)
          .whereIn('id', [...new Set(rows.map((row: any) => Number(row.id)))])
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
    applications: any[] = [],
  ): Promise<Posting[]> {
    const postings: Posting[] = [];
    const from =
      payment.accountId !== null && payment.accountId !== undefined
        ? Number(payment.accountId)
        : await this.marked.get('payments-out-clearing', trx);
    const payable =
      allocations.length || excess !== 0n
        ? await this.controlAccountId(config, trx)
        : 0;

    for (const allocation of allocations) {
      const cents = toCents(String(allocation.amount));
      const bill = billById.get(Number(allocation.documentId));

      // Accrual: payable down and the paying account down.
      postings.push(
        {
          accountId: payable,
          cents,
          postedOn: payment.paidOn,
          basis: 'accrual',
          contactId: Number(bill.partyId),
        },
        {
          accountId: from,
          cents: -cents,
          postedOn: payment.paidOn,
          basis: 'accrual',
        },
      );
      // Cash: each line of the bill, its share.
      for (const line of await this.cashLines(config, allocation, trx)) {
        postings.push({
          accountId: line.accountId,
          cents: BigInt(line.share),
          postedOn: payment.paidOn,
          basis: 'cash',
          lineIndex: line.lineIndex,
          tracking: line.tracking,
        });
      }
      postings.push({
        accountId: from,
        cents: -cents,
        postedOn: payment.paidOn,
        basis: 'cash',
      });
    }
    if (excess !== 0n || applications.length) {
      const unapplied = await this.unappliedAccountId(config, trx);
      const paidOn: string = payment.paidOn;

      if (excess !== 0n) {
        postings.push(
          // Accrual: a credit with the vendor, on payables.
          {
            accountId: payable,
            cents: excess,
            postedOn: paidOn,
            basis: 'accrual',
            contactId: this.partyOf(payment),
          },
          {
            accountId: from,
            cents: -excess,
            postedOn: paidOn,
            basis: 'accrual',
          },
          // Cash: an expense on the day the money left.
          {
            accountId: unapplied,
            cents: excess,
            postedOn: paidOn,
            basis: 'cash',
          },
          { accountId: from, cents: -excess, postedOn: paidOn, basis: 'cash' },
        );
      }
      // Cash: what is applied moves to the bill's own lines.
      for (const application of applications) {
        for (const line of await this.cashLines(config, application, trx)) {
          postings.push({
            accountId: line.accountId,
            cents: BigInt(line.share),
            postedOn: application.appliedOn,
            basis: 'cash',
            lineIndex: line.lineIndex,
            tracking: line.tracking,
          });
        }
        postings.push({
          accountId: unapplied,
          cents: -toCents(String(application.amount)),
          postedOn: application.appliedOn,
          basis: 'cash',
        });
      }
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
    applications: any[] = [],
  ): Promise<Posting[]> {
    const postings: Posting[] = [];
    const paidOn: string = payment.paidOn;
    const redeemed = payment.method === CREDIT_BALANCE_METHOD;
    const named = redeemed ? payment.redemptionAccountId : payment.accountId;
    const into =
      named !== null && named !== undefined
        ? Number(named)
        : await this.marked.get(
            redeemed ? 'unearned-revenue' : 'payments-in-clearing',
            trx,
          );
    const receivable =
      allocations.length || excess !== 0n
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

      postings.push(
        { accountId: into, cents, postedOn: paidOn, basis: 'accrual' },
        {
          accountId: receivable,
          cents: -cents,
          postedOn: paidOn,
          basis: 'accrual',
          contactId: Number(invoice.partyId),
        },
        { accountId: cashInto, cents, postedOn: paidOn, basis: 'cash' },
      );
      for (const line of await this.cashLines(config, allocation, trx)) {
        postings.push({
          accountId: line.accountId,
          cents: -BigInt(line.share),
          postedOn: paidOn,
          basis: 'cash',
          lineIndex: line.lineIndex,
          tracking: line.tracking,
        });
      }
    }
    // A part paid to an account credits it on both bases, against the
    // account the money came into.
    for (const part of accountParts) {
      const cents = toCents(String(part.amount));

      postings.push(
        { accountId: into, cents, postedOn: paidOn, basis: null },
        {
          accountId: Number(part.accountId),
          cents: -cents,
          postedOn: paidOn,
          basis: null,
          note: part.memo ?? undefined,
        },
      );
    }
    if (excess !== 0n || applications.length) {
      const unapplied = await this.unappliedAccountId(config, trx);

      if (excess !== 0n) {
        postings.push(
          // Accrual: a credit with the customer, on receivables.
          {
            accountId: into,
            cents: excess,
            postedOn: paidOn,
            basis: 'accrual',
          },
          {
            accountId: receivable,
            cents: -excess,
            postedOn: paidOn,
            basis: 'accrual',
            contactId: this.partyOf(payment),
          },
          // Cash: income on the day the money came in.
          { accountId: into, cents: excess, postedOn: paidOn, basis: 'cash' },
          {
            accountId: unapplied,
            cents: -excess,
            postedOn: paidOn,
            basis: 'cash',
          },
        );
      }
      // Cash: what is applied moves to the invoice's own lines.
      for (const application of applications) {
        postings.push({
          accountId: unapplied,
          cents: toCents(String(application.amount)),
          postedOn: application.appliedOn,
          basis: 'cash',
        });
        for (const line of await this.cashLines(config, application, trx)) {
          postings.push({
            accountId: line.accountId,
            cents: -BigInt(line.share),
            postedOn: application.appliedOn,
            basis: 'cash',
            lineIndex: line.lineIndex,
            tracking: line.tracking,
          });
        }
      }
    }
    return postings;
  }

  /** The live applications made from a payment or a credit document. */
  private async applicationsFrom(
    sourceKind: string,
    sourceId: number,
    trx: Knex.Transaction,
  ): Promise<any[]> {
    return trx(APPLICATIONS_TABLE)
      .where({ sourceKind, sourceId })
      .whereNull('deleted_at')
      .orderBy('id');
  }

  /** The party a payment's unapplied money is a credit with. */
  private partyOf(payment: any): number | undefined {
    return payment.partyId === null || payment.partyId === undefined
      ? undefined
      : Number(payment.partyId);
  }

  /**
   * The account unapplied money shows in on the cash basis. A chart that
   * marks none for it uses its uncategorized account.
   */
  private async unappliedAccountId(
    config: TradeConfig,
    trx: Knex.Transaction,
  ): Promise<number> {
    const payable = config.side === TradeSide.Payable;
    const marked = await this.marked.find(
      payable ? 'unapplied-cash-expense' : 'unapplied-cash-income',
      trx,
    );
    return (
      marked ??
      this.marked.get(
        payable ? 'uncategorized-expense' : 'uncategorized-income',
        trx,
      )
    );
  }

  /**
   * The day a document's own entry lands on: its day, or for an opening
   * document the day the books start, where the opening balances are.
   */
  public async entryDay(document: {
    opening?: boolean | number | null;
    postedOn: string;
  }): Promise<string> {
    if (!document.opening) return document.postedOn;

    const workspace = await this.workspaces.findByOrganization(
      this.cls.get('organizationId'),
    );
    return workspace?.booksStartOn ?? document.postedOn;
  }

  private async openingEquityAccountId(trx: Knex.Transaction): Promise<number> {
    const account = await trx('accounts')
      .where({ slug: OPENING_EQUITY_SLUG })
      .first('id');

    if (!account) {
      throw new ServiceError(
        MARKED_ACCOUNT_ERRORS.ACCOUNT_NOT_MARKED,
        `The chart marks no account as "${OPENING_EQUITY_SLUG}", which this write posts to.`,
        { slug: OPENING_EQUITY_SLUG },
      );
    }
    return Number(account.id);
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
      currencyCode: workspace?.baseCurrency,
      number: number ?? null,
      reference: reference ?? null,
    };
  }
}
