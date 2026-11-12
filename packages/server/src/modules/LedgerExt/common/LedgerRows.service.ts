import { Knex } from 'knex';
import { Inject, Injectable } from '@nestjs/common';
import { TENANCY_DB_CONNECTION } from '@/modules/Tenancy/TenancyDB/TenancyDB.constants';
import { ExtRecordKind } from '../LedgerExt.constants';

/**
 * Bigcapital's name for the document a ledger row belongs to, against the
 * extension's record kind for it.
 */
export const REFERENCE_TYPE_KINDS: Record<string, ExtRecordKind> = {
  Journal: ExtRecordKind.ManualJournal,
  Bill: ExtRecordKind.Bill,
  BillPayment: ExtRecordKind.BillPayment,
  SaleInvoice: ExtRecordKind.SaleInvoice,
  PaymentReceive: ExtRecordKind.PaymentReceived,
};

const POSTED_TABLE = 'ext_posted_accounts';

export interface LedgerRange {
  /** An instant, inclusive. */
  from?: string | null;
  /** An instant, exclusive. */
  to?: string | null;
  /** An instant: rows before it are left out, whatever `from` says. */
  notBefore?: string | null;
  basis: 'accrual' | 'cash';
  /**
   * When given, only rows carrying one of these tracking options count. An
   * empty list counts no row.
   */
  trackingOptionIds?: number[] | null;
}

export interface AccountBalance {
  debit: string;
  credit: string;
}

/**
 * Reads Bigcapital's ledger rows (`accounts_transactions`) for the extension.
 *
 * Bigcapital dates a ledger row by calendar day. The extension keeps the exact
 * instant of each document it creates, or of each row where a document posts
 * on more than one day, and ranges here are ranges of those instants. A row
 * the extension knows no instant for is placed at the start of its day.
 *
 * A row carries the basis it belongs to, or none when it counts on both.
 */
@Injectable()
export class LedgerRowsService {
  constructor(
    @Inject(TENANCY_DB_CONNECTION)
    private readonly tenantKnex: () => Knex,
  ) {}

  /**
   * The ledger rows joined to the instant of their document, as `posted_at`.
   */
  public rows(trx?: Knex.Transaction): Knex.QueryBuilder {
    const knex = trx ?? this.tenantKnex();
    const kindCase = Object.entries(REFERENCE_TYPE_KINDS)
      .map(([referenceType, kind]) => `WHEN '${referenceType}' THEN '${kind}'`)
      .join(' ');

    return knex('accounts_transactions as t')
      .leftJoin('ext_documents as d', function joinDocument() {
        this.on('d.record_id', '=', 't.reference_id').andOn(
          'd.kind',
          '=',
          // Identifiers in raw SQL go through `??`, so that they are written
          // the way the connection maps table and column names.
          knex.raw(`CASE ?? ${kindCase} ELSE NULL END`, ['t.reference_type']),
        );
      })
      .leftJoin('ext_row_instants as r', 'r.account_transaction_id', 't.id');
  }

  /** The SQL expression of a row's instant. */
  public postedAt(knex: Knex | Knex.Transaction): Knex.Raw {
    return knex.raw(
      "COALESCE(??, ??, CONCAT(DATE_FORMAT(??, '%Y-%m-%d'), 'T00:00:00.000Z'))",
      ['r.posted_at', 'd.transacted_at', 't.date'],
    );
  }

  public applyRange(
    query: Knex.QueryBuilder,
    range: LedgerRange,
    trx?: Knex.Transaction,
  ): Knex.QueryBuilder {
    const knex = trx ?? this.tenantKnex();
    const postedAt = this.postedAt(knex);

    query.where(function basis() {
      this.whereNull('t.basis').orWhere('t.basis', range.basis);
    });
    if (range.from) query.where(postedAt, '>=', range.from);
    if (range.notBefore) query.where(postedAt, '>=', range.notBefore);
    if (range.to) query.where(postedAt, '<', range.to);
    if (range.trackingOptionIds) {
      query.whereIn(
        't.id',
        knex('account_transaction_tracking_categories')
          // An id no option has, so that an empty list matches nothing.
          .whereIn('optionId', [0, ...range.trackingOptionIds])
          .select('accountTransactionId'),
      );
    }
    return query;
  }

  /**
   * Total debits and credits of each account in a range, keyed by account id.
   * Accounts with no rows in the range are absent.
   */
  public async balances(
    range: LedgerRange,
    trx?: Knex.Transaction,
  ): Promise<Map<number, AccountBalance>> {
    const knex = trx ?? this.tenantKnex();
    const rows = await this.applyRange(this.rows(trx), range, trx)
      .groupBy('t.account_id')
      .select(
        't.account_id as accountId',
        knex.raw('CAST(COALESCE(SUM(??), 0) AS CHAR) as ??', [
          't.debit',
          'debit',
        ]),
        knex.raw('CAST(COALESCE(SUM(??), 0) AS CHAR) as ??', [
          't.credit',
          'credit',
        ]),
      );
    return new Map(
      rows.map((row: any) => [
        Number(row.accountId),
        { debit: String(row.debit), credit: String(row.credit) },
      ]),
    );
  }

  /**
   * The ids of every account that has ever been posted to: those with a
   * ledger row on any basis, and those remembered from documents since
   * deleted or edited away.
   */
  public async postedAccountIds(trx?: Knex.Transaction): Promise<Set<number>> {
    const knex = trx ?? this.tenantKnex();
    const [rows, remembered] = await Promise.all([
      knex('accounts_transactions')
        .distinct('accountId')
        .whereNotNull('accountId'),
      knex(POSTED_TABLE).select('accountId'),
    ]);
    return new Set(
      [...rows, ...remembered].map((row: any) => Number(row.accountId)),
    );
  }

  /**
   * Remembers that the given accounts were posted to, for good.
   */
  public async rememberPosted(
    accountIds: number[],
    trx: Knex.Transaction,
  ): Promise<void> {
    const ids = [...new Set(accountIds)].sort((a, b) => a - b);
    if (ids.length === 0) return;

    await trx(POSTED_TABLE)
      .insert(ids.map((accountId) => ({ accountId })))
      .onConflict('accountId')
      .ignore();
  }
}
