import { Knex } from 'knex';
import { Inject, Injectable } from '@nestjs/common';
import { TENANCY_DB_CONNECTION } from '@/modules/Tenancy/TenancyDB/TenancyDB.constants';
import {
  LedgerRange,
  LedgerRowsService,
  REFERENCE_TYPE_KINDS,
} from '../common/LedgerRows.service';
import { ExtLinesService } from '../common/ExtLines.service';
import { inChunks } from '../common/chunks';
import { fromThousandths, toThousandths } from '../common/decimal';
import { toPlainDate } from '../common/timestamps';
import { ExtRecordKind } from '../LedgerExt.constants';
import { ExtAccountTreeService } from '../Accounts/ExtAccountTree.service';
import { LedgerAccountsService } from '../Accounts/LedgerAccounts.service';

export interface LedgerLineView {
  /** The id of the ledger row. It changes when its document is edited. */
  id: number;
  /** The stable id of the document line the row came from, when it has one. */
  lineId: number | null;
  sourceType: string;
  sourceId: number;
  account: { id: number; code: string | null; name: string | null };
  debit: string;
  credit: string;
  postedOn: string;
  tracking: Array<{ category: string; option: string; optionName: string }>;
}

export interface LedgerEntryView {
  sourceType: string;
  sourceId: number;
  number: string | null;
  postedOn: string;
  description: string | null;
  reference: string | null;
  entries: LedgerLineView[];
}

interface PageQuery {
  page?: string | number;
  pageSize?: string | number;
  order?: string;
  basis?: 'accrual' | 'cash';
  includeBeforeStart?: string;
  /** A plain date, inclusive. */
  from?: string;
  /** A plain date, inclusive. */
  to?: string;
}

/** The most lines of an account one page holds. */
export const LINES_MAX_PAGE_SIZE = 200;

/** The most entries one page of the feed holds: a whole export in one call. */
export const FEED_MAX_PAGE_SIZE = 50000;

/** The tables of the extension's own documents, by Bigcapital's names for them. */
const OWN_DOCUMENT_TABLES: Array<[string, string]> = [
  ['Bill', 'ext_trade_documents'],
  ['SaleInvoice', 'ext_trade_documents'],
  ['VendorCredit', 'ext_trade_documents'],
  ['CreditNote', 'ext_trade_documents'],
  ['BillPayment', 'ext_payments'],
  ['PaymentReceive', 'ext_payments'],
];

/** The kind of the lines of each of those documents that has lines. */
const OWN_DOCUMENT_LINES: Array<[string, ExtRecordKind]> = [
  ['Bill', ExtRecordKind.BillEntry],
  ['SaleInvoice', ExtRecordKind.SaleInvoiceEntry],
  ['VendorCredit', ExtRecordKind.VendorCreditEntry],
  ['CreditNote', ExtRecordKind.CreditNoteEntry],
];

/** A ledger line with what its entry is described by. */
type FeedRow = LedgerLineView & {
  referenceType: string;
  number: string | null;
  reference: string | null;
};

const paging = (query: PageQuery, maxPageSize: number) => ({
  page: Math.max(1, Number(query.page) || 1),
  pageSize: Math.min(Math.max(1, Number(query.pageSize) || 50), maxPageSize),
});

/** Source types that are not their reference type put in snake case. */
const SOURCE_TYPES: Record<string, string> = {
  FixedAssetValueUpdate: 'fixed_asset',
};

/** Names a ledger row's document in the extension's vocabulary. */
const sourceTypeOf = (referenceType: string): string =>
  SOURCE_TYPES[referenceType] ??
  REFERENCE_TYPE_KINDS[referenceType] ??
  String(referenceType)
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .toLowerCase();

/**
 * The ledger as entries: what every document of any kind has posted.
 */
@Injectable()
export class LedgerEntriesService {
  constructor(
    @Inject(TENANCY_DB_CONNECTION)
    private readonly tenantKnex: () => Knex,
    private readonly ledgerRows: LedgerRowsService,
    private readonly lines: ExtLinesService,
    private readonly tree: ExtAccountTreeService,
    private readonly accounts: LedgerAccountsService,
  ) {}

  /**
   * Every ledger entry, one per document, paged, newest first unless asked
   * otherwise. Rows of the other basis only are left out.
   */
  public async feed(query: PageQuery): Promise<{
    data: LedgerEntryView[];
    pagination: { total: number; page: number; pageSize: number };
  }> {
    const { page, pageSize } = paging(query, FEED_MAX_PAGE_SIZE);
    const knex = this.tenantKnex();
    const postedOn = this.ledgerRows.postedOn(knex);
    const direction =
      String(query.order).toLowerCase() === 'asc' ? 'asc' : 'desc';
    const range = await this.rangeOf(query);

    const groups = () =>
      this.ledgerRows
        .applyRange(this.ledgerRows.rows(), range)
        // One entry for each day a document posts on: a payment of bills
        // of two days is two entries.
        .groupBy('t.reference_type', 't.reference_id', postedOn as any)
        .select(
          't.reference_type as referenceType',
          't.reference_id as referenceId',
          knex.raw('? as ??', [postedOn, 'postedOn']),
          // Entries of one day are listed in the order they were written.
          knex.raw('MIN(??) as ??', ['t.id', 'firstRowId']),
        );
    const [{ total }] = await knex.from(groups().as('g')).count({ total: '*' });
    const selected = await knex
      .from(groups().as('g'))
      .orderBy([
        { column: 'postedOn', order: direction },
        { column: 'firstRowId', order: direction },
      ])
      .limit(pageSize)
      .offset((page - 1) * pageSize);

    // The rows of the selected documents, read a run of ids at a time for
    // each kind of document.
    const idSets = new Map<string, Set<number>>();
    selected.forEach((group: any) => {
      const ids = idSets.get(group.referenceType) ?? new Set<number>();

      ids.add(Number(group.referenceId));
      idSets.set(group.referenceType, ids);
    });
    const idsByType = new Map<string, number[]>(
      [...idSets].map(([type, ids]): [string, number[]] => [type, [...ids]]),
    );
    const rowsByKey = new Map<string, FeedRow[]>();

    for (const [referenceType, referenceIds] of idsByType) {
      const rows = await inChunks(referenceIds, (run) =>
        this.lineRows(
          this.ledgerRows
            .applyRange(this.ledgerRows.rows(), range)
            .where('t.reference_type', referenceType)
            .whereIn('t.reference_id', run)
            // A document's rows in the order it posted them.
            .orderBy([
              { column: 't.index', order: 'asc' },
              { column: 't.id', order: 'asc' },
            ]),
        ),
      );
      rows.forEach((row) => {
        const key = `${referenceType}:${row.sourceId}:${row.postedOn}`;
        const list = rowsByKey.get(key);
        if (list) list.push(row);
        else rowsByKey.set(key, [row]);
      });
    }
    const journals = await inChunks(idsByType.get('Journal') ?? [], (run) =>
      knex('manual_journals').whereIn('id', run),
    );
    const journalById = new Map(journals.map((j: any) => [Number(j.id), j]));
    const ownById = new Map<string, any>();

    for (const [referenceType, table] of OWN_DOCUMENT_TABLES) {
      const own = await inChunks(idsByType.get(referenceType) ?? [], (run) =>
        knex(table).whereIn('id', run),
      );
      own.forEach((row: any) =>
        ownById.set(`${referenceType}:${Number(row.id)}`, row),
      );
    }

    const described = await this.descriptions(idsByType);

    const data = selected.map((group: any) => {
      const entries =
        rowsByKey.get(
          `${group.referenceType}:${Number(group.referenceId)}:${group.postedOn}`,
        ) ?? [];
      const own = ownById.get(
        `${group.referenceType}:${Number(group.referenceId)}`,
      );
      const journal =
        group.referenceType === 'Journal'
          ? journalById.get(Number(group.referenceId))
          : undefined;
      return {
        sourceType: sourceTypeOf(group.referenceType),
        sourceId: Number(group.referenceId),
        number:
          journal?.journalNumber ?? own?.number ?? entries[0]?.number ?? null,
        postedOn: group.postedOn,
        description:
          journal?.description ??
          own?.note ??
          described.get(
            `${group.referenceType}:${Number(group.referenceId)}`,
          ) ??
          null,
        reference:
          journal?.reference ?? own?.reference ?? entries[0]?.reference ?? null,
        entries: entries.map(
          ({ referenceType: _r, number: _n, reference: _f, ...line }) => line,
        ),
      };
    });
    return { data, pagination: { total: Number(total), page, pageSize } };
  }

  /**
   * The ledger lines on an account, paged, newest first.
   */
  public async accountLines(
    accountId: number,
    query: PageQuery,
  ): Promise<{
    data: LedgerLineView[];
    pagination: { total: number; page: number; pageSize: number };
  }> {
    await this.accounts.nodeOrThrow(accountId);

    const { page, pageSize } = paging(query, LINES_MAX_PAGE_SIZE);
    const knex = this.tenantKnex();
    const range = await this.rangeOf(query);
    const scope = () =>
      this.ledgerRows
        .applyRange(this.ledgerRows.rows(), range)
        .where('t.account_id', accountId);

    const [{ total }] = await scope().count({ total: '*' });
    const rows = await this.lineRows(
      scope()
        .orderBy([
          { column: this.ledgerRows.postedOn(knex) as any, order: 'desc' },
          { column: 't.id', order: 'desc' },
        ])
        .limit(pageSize)
        .offset((page - 1) * pageSize),
    );
    return {
      data: rows.map(
        ({ referenceType: _r, number: _n, reference: _f, ...line }) => line,
      ),
      pagination: { total: Number(total), page, pageSize },
    };
  }

  /**
   * The rows a read covers: one basis, and nothing before the books' start
   * unless the read asks for it.
   */
  private async rangeOf(query: PageQuery): Promise<LedgerRange> {
    const defaults = await this.accounts.ledgerDefaults();

    return {
      basis: query.basis ?? defaults.basis,
      from: query.from ? toPlainDate(query.from) : null,
      to: query.to ? toPlainDate(query.to) : null,
      notBefore:
        query.includeBeforeStart === 'true' ? null : defaults.booksStartOn,
    };
  }

  /**
   * What the entries of opening balances and of value updates are described
   * by, which their records hold no text for.
   */
  private async descriptions(
    idsByType: Map<string, number[]>,
  ): Promise<Map<string, string>> {
    const knex = this.tenantKnex();
    const described = new Map<string, string>();

    const openings = await inChunks(
      idsByType.get('OpeningBalance') ?? [],
      (run) =>
        knex('ext_opening_balances as o')
          .leftJoin('ext_account_tree as n', 'n.account_id', 'o.account_id')
          .whereIn('o.id', run)
          .select('o.id as id', 'n.name as name'),
    );
    openings.forEach((row: any) =>
      described.set(
        `OpeningBalance:${Number(row.id)}`,
        `Opening balance for ${row.name ?? 'an account'}`,
      ),
    );
    const fundings = await inChunks(
      idsByType.get('RecordFunding') ?? [],
      (run) =>
        knex('ext_opening_balances as o')
          .leftJoin('ext_fixed_assets as a', function joinAsset() {
            this.on('a.id', '=', 'o.source_id').andOnVal(
              'o.source',
              '=',
              'fixed_asset',
            );
          })
          .leftJoin('ext_loans as l', function joinLoan() {
            this.on('l.id', '=', 'o.source_id').andOnVal(
              'o.source',
              '=',
              'loan',
            );
          })
          .whereIn('o.id', run)
          .select(
            'o.id as id',
            'o.source as source',
            'a.name as assetName',
            'l.name as loanName',
          ),
    );
    fundings.forEach((row: any) =>
      described.set(
        `RecordFunding:${Number(row.id)}`,
        row.source === 'loan'
          ? `Proceeds of ${row.loanName ?? 'a loan'}`
          : `Purchase of ${row.assetName ?? 'a fixed asset'}`,
      ),
    );
    const updates = await inChunks(
      idsByType.get('FixedAssetValueUpdate') ?? [],
      (run) =>
        knex('ext_asset_value_updates as u')
          .leftJoin('ext_fixed_assets as a', 'a.id', 'u.asset_id')
          .whereIn('u.id', run)
          .select('u.id as id', 'u.note as note', 'a.name as name'),
    );
    updates.forEach((row: any) =>
      described.set(
        `FixedAssetValueUpdate:${Number(row.id)}`,
        `Depreciation - ${row.name ?? ''}${row.note ? ` (Memo: ${row.note})` : ''}`,
      ),
    );
    return described;
  }

  /**
   * Reads ledger rows as lines, with their accounts, tracking and, for the
   * rows of a manual journal, the stable id of the journal line.
   */
  private async lineRows(query: Knex.QueryBuilder): Promise<FeedRow[]> {
    const knex = this.tenantKnex();
    const rows = await query.select(
      't.id as id',
      't.reference_type as referenceType',
      't.reference_id as referenceId',
      't.account_id as accountId',
      't.index as lineIndex',
      't.index_group as lineGroup',
      't.transaction_number as number',
      't.reference_number as reference',
      knex.raw('CAST(COALESCE(??, 0) AS CHAR) as ??', ['t.debit', 'debit']),
      knex.raw('CAST(COALESCE(??, 0) AS CHAR) as ??', ['t.credit', 'credit']),
      knex.raw('? as ??', [this.ledgerRows.postedOn(knex), 'postedOn']),
    );
    if (rows.length === 0) return [];

    const rowIds = rows.map((row: any) => Number(row.id));
    const journalIds: number[] = [
      ...new Set<number>(
        rows
          .filter((row: any) => row.referenceType === 'Journal')
          .map((row: any) => Number(row.referenceId)),
      ),
    ];
    const idsOf = (referenceType: string): number[] => [
      ...new Set<number>(
        rows
          .filter((row: any) => row.referenceType === referenceType)
          .map((row: any) => Number(row.referenceId)),
      ),
    ];
    const [nodes, journalLines, documentLines, trackingRows] =
      await Promise.all([
        this.tree.list(),
        this.lines.listMany(ExtRecordKind.ManualJournalEntry, journalIds),
        Promise.all(
          OWN_DOCUMENT_LINES.map(async ([referenceType, kind]) => ({
            referenceType,
            lines: await this.lines.listMany(kind, idsOf(referenceType)),
          })),
        ),
        inChunks(rowIds, (run) =>
          knex('account_transaction_tracking_categories as l')
            .join('tracking_categories as c', 'c.id', 'l.category_id')
            .join('tracking_category_options as o', 'o.id', 'l.option_id')
            .leftJoin('ext_tracking_option_names as n', 'n.option_id', 'o.id')
            .whereIn('l.account_transaction_id', run)
            .orderBy('c.name')
            .select(
              'l.account_transaction_id as rowId',
              'c.name as category',
              'o.name as option',
              'n.name as optionName',
            ),
        ),
      ]);
    const lineIdOf = new Map<string, number>();
    journalLines.forEach((lines, journalId) =>
      lines.forEach((line) =>
        lineIdOf.set(`Journal:${journalId}:${line.index}`, line.id),
      ),
    );
    documentLines.forEach(({ referenceType, lines: byDocument }) =>
      byDocument.forEach((lines, documentId) =>
        lines.forEach((line) =>
          lineIdOf.set(`${referenceType}:${documentId}:${line.index}`, line.id),
        ),
      ),
    );
    const nodeById = new Map(nodes.map((node) => [node.accountId, node]));
    const trackingByRow = new Map<number, LedgerLineView['tracking']>();
    trackingRows.forEach((t: any) => {
      const rowId = Number(t.rowId);
      trackingByRow.set(rowId, [
        ...(trackingByRow.get(rowId) ?? []),
        {
          category: t.category,
          option: t.option,
          optionName: t.optionName ?? t.option,
        },
      ]);
    });

    return rows.map((row: any) => {
      const node = nodeById.get(Number(row.accountId));
      // A journal's rows are in the order of its lines; a bill's rows carry
      // the number of the line they came from.
      const lineNumber =
        row.referenceType === 'Journal' ? row.lineIndex : row.lineGroup;
      const lineId = lineIdOf.get(
        `${row.referenceType}:${Number(row.referenceId)}:${Number(lineNumber)}`,
      );
      return {
        id: Number(row.id),
        lineId: lineId ?? null,
        referenceType: row.referenceType,
        sourceType: sourceTypeOf(row.referenceType),
        sourceId: Number(row.referenceId),
        number: row.number ?? null,
        reference: row.reference ?? null,
        account: {
          id: Number(row.accountId),
          code: node?.code ?? null,
          name: node?.name ?? null,
        },
        debit: fromThousandths(toThousandths(String(row.debit))),
        credit: fromThousandths(toThousandths(String(row.credit))),
        postedOn: row.postedOn,
        tracking: trackingByRow.get(Number(row.id)) ?? [],
      };
    });
  }
}
