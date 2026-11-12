import { Knex } from 'knex';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ServiceError } from '@/modules/Items/ServiceError';
import { TENANCY_DB_CONNECTION } from '@/modules/Tenancy/TenancyDB/TenancyDB.constants';
import { ExternalIdsService } from '../common/ExternalIds.service';
import { ExtMetadataService } from '../common/ExtMetadata.service';
import { fromCents, toCents } from '../common/money';
import { toInstant } from '../common/timestamps';
import { ExtRecordKind } from '../LedgerExt.constants';
import {
  LedgerAccountBrief,
  LedgerAccountsService,
} from '../Accounts/LedgerAccounts.service';
import { ExtLockService } from '../Lock/ExtLock.service';
import { toIso } from '../Trade/TradePaymentViews.service';
import { BOOKS_ERRORS, paging } from './books.constants';
import { OpeningEntriesService } from './OpeningEntries.service';
import { CreateLedgerLoanDto } from './LedgerBooks.dto';

const TABLE = 'ext_loans';

export interface LoanView {
  id: number;
  externalId: string | null;
  name: string;
  loanType: string;
  originationDate: string | null;
  originalPrincipal: string | null;
  creditLimit: string | null;
  loanTermMonths: number | null;
  metadata: Record<string, unknown> | null;
  /** The loan's own account, made with it. */
  account: LedgerAccountBrief | null;
  /** What the loan's account holds to date: credits less debits. */
  balance: string;
  opening: { amount: string; postedAt: string } | null;
  createdAt: string | null;
}

const named = (value: unknown): boolean =>
  value !== null && value !== undefined;

/**
 * Loans. A loan is made with an account of its own, a long-term liability
 * under the root of the liabilities, and with what is owed on it at a given
 * instant posted as an opening entry: a debit to opening balance equity, a
 * credit to the loan's account.
 */
@Injectable()
export class LedgerLoansService {
  constructor(
    @Inject(TENANCY_DB_CONNECTION)
    private readonly tenantKnex: () => Knex,
    private readonly externalIds: ExternalIdsService,
    private readonly metadata: ExtMetadataService,
    private readonly accounts: LedgerAccountsService,
    private readonly lock: ExtLockService,
    private readonly openings: OpeningEntriesService,
  ) {}

  /**
   * Creates a loan, its account and, when given, its opening entry, in one
   * transaction. A create carrying the external id of an existing loan
   * answers that loan unchanged.
   */
  public async create(dto: CreateLedgerLoanDto): Promise<LoanView> {
    const openingAt = dto.opening ? toInstant(dto.opening.postedAt) : null;
    const money = (value: string | null | undefined) =>
      named(value) ? fromCents(toCents(value)) : null;

    const { recordId } = await this.externalIds.createOnce({
      kind: ExtRecordKind.Loan,
      externalId: dto.externalId ?? undefined,
      create: async (trx) => {
        if (openingAt) await this.lock.assertOpen([openingAt], trx);

        const accountId = await this.accounts.createWithin(
          {
            name: dto.name,
            accountType: 'long-term-liability',
            parentAccountId: await this.accounts.rootOf('liability', trx),
          },
          trx,
        );
        const [id] = await trx(TABLE).insert({
          name: dto.name,
          loanType: dto.loanType,
          originationDate: dto.originationDate ?? null,
          originalPrincipal: money(dto.originalPrincipal),
          creditLimit: money(dto.creditLimit),
          loanTermMonths: dto.loanTermMonths ?? null,
          accountId,
          createdAt: trx.fn.now(),
          updatedAt: trx.fn.now(),
        });
        await this.metadata.set(
          ExtRecordKind.Loan,
          id,
          dto.metadata ?? null,
          trx,
        );
        if (openingAt) {
          await this.openings.post(
            {
              source: 'loan',
              sourceId: id,
              accountId,
              // What is owed is a credit on the loan's account.
              cents: -toCents(dto.opening.amount),
              postedAt: openingAt,
            },
            trx,
          );
        }
        return id;
      },
      read: async (id) => id,
    });
    return this.get(recordId);
  }

  public async get(loanId: number): Promise<LoanView> {
    const row = Number.isInteger(loanId)
      ? await this.tenantKnex()(TABLE).where({ id: loanId }).first()
      : null;

    if (!row) {
      throw new ServiceError(
        BOOKS_ERRORS.LOAN_NOT_FOUND,
        'The loan was not found.',
        { loanId },
        HttpStatus.NOT_FOUND,
      );
    }
    return (await this.views([loanId]))[0];
  }

  /** Loans, oldest made first. */
  public async list(query: {
    page?: string | number;
    pageSize?: string | number;
  }): Promise<{
    data: LoanView[];
    pagination: { total: number; page: number; pageSize: number };
  }> {
    const { page, pageSize } = paging(query);
    const knex = this.tenantKnex();
    const [{ total }] = await knex(TABLE).count({ total: '*' });
    const rows = await knex(TABLE)
      .orderBy('id')
      .limit(pageSize)
      .offset((page - 1) * pageSize)
      .select('id');

    return {
      data: await this.views(rows.map((row: any) => Number(row.id))),
      pagination: { total: Number(total), page, pageSize },
    };
  }

  private async views(loanIds: number[]): Promise<LoanView[]> {
    if (loanIds.length === 0) return [];

    const kind = ExtRecordKind.Loan;
    const knex = this.tenantKnex();
    const rows = await knex(TABLE).whereIn('id', loanIds);
    const accountIds = rows.map((row: any) => Number(row.accountId));
    const [externalIds, metadata, briefs, openings, sums] = await Promise.all([
      this.externalIds.findExternalIds(kind, loanIds),
      this.metadata.getMany(kind, loanIds),
      this.accounts.briefs(accountIds),
      this.openings.list('loan', loanIds),
      // A row counted on the cash basis alone has a twin on the accrual
      // basis, so those are left out.
      knex('accounts_transactions')
        .whereIn('accountId', accountIds)
        .where((q) => q.whereNull('basis').orWhere('basis', 'accrual'))
        .groupBy('accountId')
        .select('accountId')
        .sum({ debit: 'debit', credit: 'credit' }),
    ]);
    const openingOf = new Map(openings.map((row) => [row.sourceId, row]));
    const balanceOf = new Map<number, bigint>(
      sums.map((row: any) => [
        Number(row.accountId),
        toCents(String(row.credit ?? 0)) - toCents(String(row.debit ?? 0)),
      ]),
    );
    const rowById = new Map(rows.map((row: any) => [Number(row.id), row]));

    return loanIds
      .filter((id) => rowById.has(id))
      .map((id) => {
        const row: any = rowById.get(id);
        const opening = openingOf.get(id);
        const money = (value: unknown) =>
          named(value) ? fromCents(toCents(String(value))) : null;

        return {
          id,
          externalId: externalIds.get(id) ?? null,
          name: row.name,
          loanType: row.loanType,
          originationDate: row.originationDate ?? null,
          originalPrincipal: money(row.originalPrincipal),
          creditLimit: money(row.creditLimit),
          loanTermMonths: named(row.loanTermMonths)
            ? Number(row.loanTermMonths)
            : null,
          metadata: (metadata.get(id) as Record<string, unknown>) ?? null,
          account: briefs.get(Number(row.accountId)) ?? null,
          balance: fromCents(balanceOf.get(Number(row.accountId)) ?? 0n),
          opening: opening
            ? {
                amount: fromCents(-toCents(opening.amount)),
                postedAt: opening.postedAt,
              }
            : null,
          createdAt: toIso(row.createdAt),
        };
      });
  }
}
