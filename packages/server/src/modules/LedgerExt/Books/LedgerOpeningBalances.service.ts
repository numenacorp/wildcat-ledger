import { Knex } from 'knex';
import { Inject, Injectable } from '@nestjs/common';
import { ServiceError } from '@/modules/Items/ServiceError';
import { TENANCY_DB_CONNECTION } from '@/modules/Tenancy/TenancyDB/TenancyDB.constants';
import { AccountTypesUtils } from '@/modules/Accounts/utils/AccountType.utils';
import { ExtUnitOfWork } from '../common/ExtUnitOfWork.service';
import { fromCents, toCents } from '../common/money';
import { toPlainDate } from '../common/timestamps';
import {
  LedgerAccountBrief,
  LedgerAccountsService,
} from '../Accounts/LedgerAccounts.service';
import { ExtAccountTreeService } from '../Accounts/ExtAccountTree.service';
import { ExtLockService } from '../Lock/ExtLock.service';
import { BOOKS_ERRORS } from './books.constants';
import { OpeningEntriesService } from './OpeningEntries.service';
import { ImportLedgerOpeningBalancesDto } from './LedgerBooks.dto';

export interface OpeningBalanceView {
  account: LedgerAccountBrief | null;
  /** In the account's own direction: a credit balance of a liability is positive. */
  amount: string;
  postedOn: string;
}

/**
 * Opening balances: what every account held when the books were opened
 * here, imported once. Each account's balance is one entry against the
 * opening balance equity account.
 */
@Injectable()
export class LedgerOpeningBalancesService {
  constructor(
    @Inject(TENANCY_DB_CONNECTION)
    private readonly tenantKnex: () => Knex,
    private readonly uow: ExtUnitOfWork,
    private readonly accounts: LedgerAccountsService,
    private readonly tree: ExtAccountTreeService,
    private readonly lock: ExtLockService,
    private readonly openings: OpeningEntriesService,
  ) {}

  /**
   * Imports opening balances, all or none. An account is found by its code,
   * or by its name where the row has no code. A second import is refused
   * until the first is deleted.
   */
  public async import(
    dto: ImportLedgerOpeningBalancesDto,
  ): Promise<OpeningBalanceView[]> {
    const postedOn = toPlainDate(dto.postedOn);
    const nodes = await this.tree.list();
    const blank = (value: string | null | undefined) =>
      value === null || value === undefined || value.trim() === '';
    const lower = (value: string) => value.trim().toLowerCase();
    const seen = new Set<number>();

    const rows = dto.balances.map((row, index) => {
      const matches = nodes.filter((node) =>
        blank(row.code)
          ? !blank(row.name) && lower(node.name) === lower(row.name)
          : node.code !== null && lower(node.code) === lower(row.code),
      );
      // A name borne by two accounts finds neither.
      if (matches.length !== 1) {
        throw new ServiceError(
          BOOKS_ERRORS.OPENING_ACCOUNT_NOT_FOUND,
          blank(row.code)
            ? `Opening balance ${index + 1} names no one account of the chart: "${row.name ?? ''}".`
            : `Opening balance ${index + 1} names no account of the chart: code "${row.code}".`,
          { index, code: row.code ?? null, name: row.name ?? null },
        );
      }
      const accountId = matches[0].accountId;

      if (seen.has(accountId)) {
        throw new ServiceError(
          BOOKS_ERRORS.OPENING_ACCOUNT_NAMED_TWICE,
          `Opening balance ${index + 1} names an account an earlier one names.`,
          { index, code: row.code ?? null, name: row.name ?? null },
        );
      }
      seen.add(accountId);
      return {
        index,
        accountId,
        cents: toCents(row.debit) - toCents(row.credit),
      };
    });
    await this.accounts.assertPostable(rows.map((row) => row.accountId));
    // What was owed either way when the books began comes in bill by bill
    // and invoice by invoice, each an opening document with its own party.
    const control = await this.tenantKnex()('accounts')
      .whereIn(
        'id',
        rows.map((row) => row.accountId),
      )
      .whereIn('account_type', ['accounts-receivable', 'accounts-payable'])
      .select('id', 'account_type as accountType');
    if (control.length > 0) {
      // The first such row as the caller sent them.
      const types = new Map(
        control.map((account: any) => [
          Number(account.id),
          account.accountType,
        ]),
      );
      const row = rows.find((r) => types.has(r.accountId));
      const what =
        types.get(row.accountId) === 'accounts-payable'
          ? 'the payable account: bring each open bill in as an opening bill'
          : 'the receivable account: bring each open invoice in as an opening invoice';
      throw new ServiceError(
        BOOKS_ERRORS.OPENING_CONTROL_ACCOUNT_ROW,
        `Opening balance ${row.index + 1} names ${what}.`,
        { index: row.index, accountId: row.accountId },
      );
    }

    await this.uow.withTransaction(async (trx) => {
      // The equity account's row is locked first, so that two imports at
      // once run one after the other and the second finds the first.
      const equityAccountId = await this.openings.equityAccountId(trx);
      await trx('accounts').where({ id: equityAccountId }).first().forUpdate();

      if ((await this.openings.list('import', undefined, trx)).length > 0) {
        throw new ServiceError(
          BOOKS_ERRORS.OPENING_BALANCES_ALREADY_IMPORTED,
          'Opening balances have been imported already. Delete them to import again.',
        );
      }
      await this.lock.assertOpen([postedOn], trx);

      const shared = { equityAccountId };
      for (const { accountId, cents } of rows) {
        await this.openings.post(
          { source: 'import', sourceId: null, accountId, cents, postedOn },
          trx,
          shared,
        );
      }
    });
    return this.list();
  }

  /** The imported balances, in the order they were sent. */
  public async list(): Promise<OpeningBalanceView[]> {
    const rows = await this.openings.list('import');
    if (rows.length === 0) return [];

    const accountIds = rows.map((row) => row.accountId);
    const [briefs, accounts] = await Promise.all([
      this.accounts.briefs(accountIds),
      this.tenantKnex()('accounts')
        .whereIn('id', accountIds)
        .select('id', 'accountType'),
    ]);
    const creditNormal = new Set<number>(
      accounts
        .filter(
          (account: any) =>
            AccountTypesUtils.getType(account.accountType, 'normal') ===
            'credit',
        )
        .map((account: any) => Number(account.id)),
    );
    return rows.map((row) => {
      const cents = toCents(row.amount);

      return {
        account: briefs.get(row.accountId) ?? null,
        amount: fromCents(creditNormal.has(row.accountId) ? -cents : cents),
        postedOn: row.postedOn,
      };
    });
  }

  /**
   * Takes the imported balances out of the books. With none imported it
   * changes nothing.
   */
  public async delete(): Promise<void> {
    await this.uow.withTransaction(async (trx) => {
      const rows = await this.openings.list('import', undefined, trx);
      if (rows.length === 0) return;

      await this.lock.assertOpen(
        rows.map((row) => row.postedOn),
        trx,
      );
      await this.openings.removeAll('import', trx);
    });
  }
}
