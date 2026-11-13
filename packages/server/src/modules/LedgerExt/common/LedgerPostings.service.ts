import { Knex } from 'knex';
import { Inject, Injectable } from '@nestjs/common';
import { TENANCY_DB_CONNECTION } from '@/modules/Tenancy/TenancyDB/TenancyDB.constants';
import { AccountTypesUtils } from '@/modules/Accounts/utils/AccountType.utils';
import { Ledger } from '@/modules/Ledger/Ledger';
import { LedgerStorageService } from '@/modules/Ledger/LedgerStorage.service';
import { ExtServiceLocator } from './ExtServiceLocator.service';
import { inChunks } from './chunks';
import { isOutOfRange } from './dbErrors';
import { ServiceError } from '@/modules/Items/ServiceError';
import { centsToNumber, fromCents } from './money';
import { LedgerRowsService } from './LedgerRows.service';

/**
 * The largest amount one ledger row holds, in cents: Bigcapital keeps debits
 * and credits as decimal(13,3).
 */
export const POSTING_MAX_CENTS = 999_999_999_999n;

export const POSTING_ERRORS = {
  AMOUNT_TOO_LARGE: 'AMOUNT_TOO_LARGE',
};

/** One side of an entry the extension posts. */
export interface Posting {
  accountId: number;
  /** Whole cents: positive for a debit, negative for a credit. */
  cents: bigint;
  /** The day the row is dated, a plain date. */
  postedOn: string;
  /** The basis the row counts on; null counts on both. */
  basis: 'accrual' | 'cash' | null;
  /** The vendor or customer, on a payable or receivable row. */
  contactId?: number | null;
  /** The number of the document line the row came from, when it has one. */
  lineIndex?: number | null;
  tracking?: Array<{ categoryId: number; optionId: number }>;
  note?: string | null;
}

export interface PostingContext {
  /** Bigcapital's name for the kind of document, such as `Bill`. */
  referenceType: string;
  referenceId: number;
  currencyCode: string;
  number?: string | null;
  reference?: string | null;
}

/**
 * Writes the ledger rows of the extension's own documents through
 * Bigcapital's ledger, so that account and contact balances follow. Each row
 * is dated its own day: a document may post rows on more than one.
 */
@Injectable()
export class LedgerPostingsService {
  constructor(
    @Inject(TENANCY_DB_CONNECTION)
    private readonly tenantKnex: () => Knex,
    private readonly locator: ExtServiceLocator,
    private readonly ledgerRows: LedgerRowsService,
  ) {}

  /**
   * Replaces the ledger rows of a document with the given postings. Postings
   * of zero are left out.
   */
  public async replace(
    context: PostingContext,
    postings: Posting[],
    trx: Knex.Transaction,
  ): Promise<void> {
    await this.remove(context.referenceType, context.referenceId, trx);

    const live = postings.filter((posting) => posting.cents !== 0n);
    if (live.length === 0) return;

    const tooLarge = live.find(
      (posting) =>
        posting.cents > POSTING_MAX_CENTS || posting.cents < -POSTING_MAX_CENTS,
    );
    if (tooLarge) {
      throw new ServiceError(
        POSTING_ERRORS.AMOUNT_TOO_LARGE,
        `An amount is larger than the ledger holds, which is ${fromCents(POSTING_MAX_CENTS)}.`,
        { max: fromCents(POSTING_MAX_CENTS) },
      );
    }

    const accountIds = [...new Set(live.map((posting) => posting.accountId))];
    const accounts = await trx('accounts')
      .whereIn('id', accountIds)
      .select('id', 'accountType');
    const normalOf = new Map<number, string>(
      accounts.map((account: any) => [
        Number(account.id),
        AccountTypesUtils.getType(account.accountType, 'normal'),
      ]),
    );
    const ledger = new Ledger(
      live.map((posting, i) => ({
        debit: posting.cents > 0n ? centsToNumber(posting.cents) : 0,
        credit: posting.cents < 0n ? centsToNumber(-posting.cents) : 0,
        currencyCode: context.currencyCode,
        exchangeRate: 1,
        accountId: posting.accountId,
        accountNormal: normalOf.get(posting.accountId),
        contactId: posting.contactId ?? undefined,
        date: posting.postedOn,
        transactionType: context.referenceType,
        transactionId: context.referenceId,
        transactionNumber: context.number ?? undefined,
        referenceNumber: context.reference ?? undefined,
        // A row is found again by its index, which is its place here.
        index: i + 1,
        indexGroup: posting.lineIndex ?? undefined,
        note: posting.note ?? undefined,
        trackingCategories: posting.tracking?.length
          ? posting.tracking
          : undefined,
        basis: posting.basis as any,
      })),
    );
    const storage = await this.locator.resolve(LedgerStorageService);
    try {
      await storage.commit(ledger, trx);
    } catch (error: any) {
      // Bigcapital keeps a running balance of each account and contact, in
      // columns as wide as a ledger row. A write that would carry one past
      // what the column holds is refused by the database.
      if (!isOutOfRange(error)) throw error;

      throw new ServiceError(
        POSTING_ERRORS.AMOUNT_TOO_LARGE,
        `A balance would grow larger than the ledger holds, which is ${fromCents(POSTING_MAX_CENTS)}.`,
        { max: fromCents(POSTING_MAX_CENTS) },
      );
    }

    await this.ledgerRows.rememberPosted(accountIds, trx);
  }

  /**
   * Removes every ledger row of a document.
   */
  public async remove(
    referenceType: string,
    referenceId: number,
    trx: Knex.Transaction,
  ): Promise<void> {
    const rows = await trx('accounts_transactions')
      .where({ referenceType, referenceId })
      .select('id');
    if (rows.length === 0) return;

    const rowIds = rows.map((row: any) => Number(row.id));
    const storage = await this.locator.resolve(LedgerStorageService);

    await storage.deleteByReference(referenceId, referenceType, trx);
    await inChunks(rowIds, (run) =>
      trx('account_transaction_tracking_categories')
        .whereIn('accountTransactionId', run)
        .delete()
        .then(() => []),
    );
  }
}
