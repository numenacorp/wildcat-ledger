import { Knex } from 'knex';
import { Inject, Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { ServiceError } from '@/modules/Items/ServiceError';
import { TENANCY_DB_CONNECTION } from '@/modules/Tenancy/TenancyDB/TenancyDB.constants';
import { ExtSettingsService } from '../common/ExtSettings.service';
import {
  LedgerPostingsService,
  Posting,
  PostingContext,
} from '../common/LedgerPostings.service';
import { fromCents, toCents } from '../common/money';
import { MARKED_ACCOUNT_ERRORS } from '../Accounts/markedAccounts';
import { ExtAccountTreeService } from '../Accounts/ExtAccountTree.service';
import { LedgerWorkspacesService } from '../Workspaces/LedgerWorkspaces.service';
import { toPlainDate } from '../common/timestamps';
import { rootTypeOf, SINGLE_ACCOUNT_TYPES } from '../Accounts/chart';
import { LedgerAccountsService } from '../Accounts/LedgerAccounts.service';
import {
  BOOKS_ERRORS,
  FUNDING_REFERENCE,
  OPENING_EQUITY_SLUG,
  OPENING_REFERENCE,
} from './books.constants';
import { LedgerFundingDto } from './LedgerBooks.dto';

const TABLE = 'ext_opening_balances';

export type OpeningSource = 'import' | 'fixed_asset' | 'loan';

export interface OpeningRow {
  id: number;
  source: OpeningSource;
  sourceId: number | null;
  accountId: number;
  /** Debits less credits, as a decimal string. */
  amount: string;
  postedOn: string;
  /** The account the other side went to; null for opening balance equity. */
  againstAccountId: number | null;
}

/** A funding checked, ready to post. */
export interface PreparedFunding {
  cents: bigint;
  postedOn: string;
  /** Null when it was held at the start of the books. */
  againstAccountId: number | null;
}

export interface FundingView {
  amount: string;
  postedOn: string;
  from: 'opening' | 'account';
  accountId: number | null;
}

/**
 * Opening entries: one account's opening balance posted against the opening
 * balance equity account, on both bases. An import of opening balances makes
 * them; so do a fixed asset and a loan made with one.
 */
@Injectable()
export class OpeningEntriesService {
  constructor(
    @Inject(TENANCY_DB_CONNECTION)
    private readonly tenantKnex: () => Knex,
    private readonly cls: ClsService,
    private readonly settings: ExtSettingsService,
    private readonly postings: LedgerPostingsService,
    private readonly tree: ExtAccountTreeService,
    private readonly workspaces: LedgerWorkspacesService,
    private readonly accounts: LedgerAccountsService,
  ) {}

  /**
   * Checks where the other side of an asset's or a loan's entry goes.
   *
   * From an account: the account is named, takes postings, and is a
   * balance-sheet account other than the receivable and the payable one
   * (what is bought on credit is a bill). From the opening: no account is
   * named, and the entry is dated on or before the day the books start;
   * where the workspace has no start, any day is taken.
   */
  public async prepareFunding(
    funding: LedgerFundingDto | null | undefined,
  ): Promise<PreparedFunding | null> {
    if (!funding) return null;

    const postedOn = toPlainDate(funding.postedOn);
    const cents = toCents(funding.amount);
    const accountNamed =
      funding.accountId !== null && funding.accountId !== undefined;

    if (funding.from === 'account') {
      if (!accountNamed) {
        throw new ServiceError(
          BOOKS_ERRORS.FUNDING_ACCOUNT_REQUIRED,
          'Funding from an account names the account by account_id.',
        );
      }
      await this.accounts.assertPostable([funding.accountId]);
      const account = await this.tenantKnex()('accounts')
        .where({ id: funding.accountId })
        .first();
      const rootType = rootTypeOf(account.accountType);

      if (
        !['asset', 'liability', 'equity'].includes(rootType) ||
        SINGLE_ACCOUNT_TYPES.includes(account.accountType) ||
        account.slug === OPENING_EQUITY_SLUG
      ) {
        throw new ServiceError(
          BOOKS_ERRORS.FUNDING_ACCOUNT_NOT_ALLOWED,
          'The other side goes to a balance-sheet account other than the receivable, the payable and the opening balance equity account.',
          { accountId: funding.accountId },
        );
      }
      return { cents, postedOn, againstAccountId: funding.accountId };
    }
    if (accountNamed) {
      throw new ServiceError(
        BOOKS_ERRORS.FUNDING_ACCOUNT_REQUIRED,
        'Funding from the opening names no account.',
      );
    }
    const workspace = await this.workspaces.findByOrganization(
      this.cls.get('organizationId'),
    );

    if (workspace?.booksStartOn && postedOn > workspace.booksStartOn) {
      throw new ServiceError(
        BOOKS_ERRORS.OPENING_AFTER_BOOKS_START,
        'Only what was held when the books began is recorded against opening balance equity. This is dated after the books start: name the account it was paid from or received into.',
        { postedOn, booksStartOn: workspace.booksStartOn },
      );
    }
    return { cents, postedOn, againstAccountId: null };
  }

  public fundingView(
    row: OpeningRow | undefined,
    sign: 1 | -1,
  ): FundingView | null {
    if (!row) return null;
    const cents = toCents(row.amount);

    return {
      amount: fromCents(sign === 1 ? cents : -cents),
      postedOn: row.postedOn,
      from: row.againstAccountId === null ? 'opening' : 'account',
      accountId: row.againstAccountId,
    };
  }

  /** What the ledger rows of a record of this module are written with. */
  public async context(
    referenceType: string,
    referenceId: number,
  ): Promise<PostingContext> {
    const workspace = await this.workspaces.findByOrganization(
      this.cls.get('organizationId'),
    );
    return {
      referenceType,
      referenceId,
      currencyCode: workspace?.baseCurrency,
    };
  }

  /**
   * The opening balance equity account: Bigcapital's own, which the chart
   * must hold.
   * @throws {ServiceError} LEDGER_ACCOUNT_NOT_MARKED when it does not.
   */
  public async equityAccountId(trx?: Knex.Transaction): Promise<number> {
    const account = await (trx ?? this.tenantKnex())('accounts')
      .where({ slug: OPENING_EQUITY_SLUG })
      .first();
    const node = account ? await this.tree.get(Number(account.id), trx) : null;

    if (!node) {
      throw new ServiceError(
        MARKED_ACCOUNT_ERRORS.ACCOUNT_NOT_MARKED,
        `The chart marks no account as "${OPENING_EQUITY_SLUG}", which this write posts to.`,
        { slug: OPENING_EQUITY_SLUG },
      );
    }
    return Number(account.id);
  }

  /**
   * Posts one opening entry: the account for `cents` (positive a debit),
   * the equity account for the opposite; or, where `againstAccountId` is
   * given, that account for the opposite, as an entry of its own kind.
   */
  public async post(
    entry: {
      source: OpeningSource;
      sourceId: number | null;
      accountId: number;
      cents: bigint;
      postedOn: string;
      againstAccountId?: number | null;
    },
    trx: Knex.Transaction,
    shared?: { equityAccountId: number },
  ): Promise<number> {
    const againstAccountId = entry.againstAccountId ?? null;
    const equityAccountId =
      againstAccountId ??
      shared?.equityAccountId ??
      (await this.equityAccountId(trx));
    const [id] = await trx(TABLE).insert({
      source: entry.source,
      sourceId: entry.sourceId,
      accountId: entry.accountId,
      amount: fromCents(entry.cents),
      postedOn: entry.postedOn,
      againstAccountId,
      createdAt: trx.fn.now(),
      updatedAt: trx.fn.now(),
    });
    const postings: Posting[] = [
      {
        accountId: entry.accountId,
        cents: entry.cents,
        postedOn: entry.postedOn,
        basis: null,
      },
      {
        accountId: equityAccountId,
        cents: -entry.cents,
        postedOn: entry.postedOn,
        basis: null,
      },
    ];
    await this.postings.replace(
      await this.context(
        againstAccountId === null ? OPENING_REFERENCE : FUNDING_REFERENCE,
        id,
      ),
      postings,
      trx,
    );
    return id;
  }

  public async list(
    source: OpeningSource,
    sourceIds?: number[],
    trx?: Knex.Transaction,
  ): Promise<OpeningRow[]> {
    const query = (trx ?? this.tenantKnex())(TABLE)
      .where({ source })
      .orderBy('id');
    if (sourceIds) query.whereIn('sourceId', sourceIds);

    return (await query).map((row: any) => ({
      id: Number(row.id),
      source: row.source,
      sourceId: row.sourceId === null ? null : Number(row.sourceId),
      accountId: Number(row.accountId),
      amount: fromCents(toCents(String(row.amount))),
      postedOn: row.postedOn,
      againstAccountId:
        row.againstAccountId === null || row.againstAccountId === undefined
          ? null
          : Number(row.againstAccountId),
    }));
  }

  /** Takes every opening entry of a source out of the books. */
  public async removeAll(
    source: OpeningSource,
    trx: Knex.Transaction,
  ): Promise<void> {
    const rows = await this.list(source, undefined, trx);

    for (const row of rows) {
      await this.postings.remove(
        row.againstAccountId === null ? OPENING_REFERENCE : FUNDING_REFERENCE,
        row.id,
        trx,
      );
    }
    await trx(TABLE).where({ source }).delete();
  }
}
