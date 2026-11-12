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
import { WORKSPACE_SETTINGS } from '../Workspaces/LedgerWorkspaces.constants';
import { OPENING_EQUITY_SLUG, OPENING_REFERENCE } from './books.constants';

const TABLE = 'ext_opening_balances';

export type OpeningSource = 'import' | 'fixed_asset' | 'loan';

export interface OpeningRow {
  id: number;
  source: OpeningSource;
  sourceId: number | null;
  accountId: number;
  /** Debits less credits, as a decimal string. */
  amount: string;
  postedAt: string;
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
  ) {}

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
      timezone: workspace?.timezone || 'UTC',
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
   * the equity account for the opposite.
   */
  public async post(
    entry: {
      source: OpeningSource;
      sourceId: number | null;
      accountId: number;
      cents: bigint;
      postedAt: string;
    },
    trx: Knex.Transaction,
    shared?: { equityAccountId: number; contactOf: Map<number, number> },
  ): Promise<number> {
    const equityAccountId =
      shared?.equityAccountId ?? (await this.equityAccountId(trx));
    const contactOf = shared?.contactOf ?? (await this.controlContacts(trx));
    const [id] = await trx(TABLE).insert({
      source: entry.source,
      sourceId: entry.sourceId,
      accountId: entry.accountId,
      amount: fromCents(entry.cents),
      postedAt: entry.postedAt,
      createdAt: trx.fn.now(),
      updatedAt: trx.fn.now(),
    });
    const postings: Posting[] = [
      {
        accountId: entry.accountId,
        cents: entry.cents,
        postedAt: entry.postedAt,
        basis: null,
        contactId: contactOf.get(entry.accountId) ?? null,
      },
      {
        accountId: equityAccountId,
        cents: -entry.cents,
        postedAt: entry.postedAt,
        basis: null,
        contactId: contactOf.get(equityAccountId) ?? null,
      },
    ];
    await this.postings.replace(
      await this.context(OPENING_REFERENCE, id),
      postings,
      trx,
    );
    return id;
  }

  /**
   * The receivable and the payable account each need a contact on their
   * rows; an opening entry names none, so the placeholders stand in.
   */
  public async controlContacts(
    trx?: Knex.Transaction,
  ): Promise<Map<number, number>> {
    const [customerId, vendorId, accounts] = await Promise.all([
      this.settings.get<number>(
        WORKSPACE_SETTINGS.PLACEHOLDER_CUSTOMER_ID,
        trx,
      ),
      this.settings.get<number>(WORKSPACE_SETTINGS.PLACEHOLDER_VENDOR_ID, trx),
      (trx ?? this.tenantKnex())('accounts')
        .whereIn('slug', ['accounts-receivable', 'accounts-payable'])
        .select('id', 'slug'),
    ]);
    const contactOf = new Map<number, number>();

    accounts.forEach((account: any) => {
      const contactId =
        account.slug === 'accounts-receivable' ? customerId : vendorId;
      if (contactId !== null && contactId !== undefined) {
        contactOf.set(Number(account.id), Number(contactId));
      }
    });
    return contactOf;
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
      postedAt: row.postedAt,
    }));
  }

  /** Takes every opening entry of a source out of the books. */
  public async removeAll(
    source: OpeningSource,
    trx: Knex.Transaction,
  ): Promise<void> {
    const rows = await this.list(source, undefined, trx);

    for (const row of rows) {
      await this.postings.remove(OPENING_REFERENCE, row.id, trx);
    }
    await trx(TABLE).where({ source }).delete();
  }
}
