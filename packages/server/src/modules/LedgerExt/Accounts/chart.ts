import { MARKED_ACCOUNTS, isMarkedAccountSlug } from './markedAccounts';
import { ServiceError } from '@/modules/Items/ServiceError';
import { ACCOUNT_TYPES } from '@/modules/Accounts/Accounts.constants';
import { AccountsData } from '@/database/tenant/seeds/data/accounts';

export const CHART_ERRORS = {
  CHART_INVALID: 'CHART_INVALID',
};

/** One account of a chart supplied by the caller. */
export interface ChartAccountInput {
  /** The account number. Unique within the chart. */
  code: string;
  /** The display name. Need not be unique. */
  name: string;
  /** One of Bigcapital's account type keys. */
  accountType: string;
  /** The code of the parent account, for a child. */
  parentCode?: string | null;
  /**
   * A slug the extension posts by (see `MARKED_ACCOUNTS`), which marks this
   * entry as that account; or
   * the slug of one of Bigcapital's predefined accounts. The entry then stands
   * for that account instead of creating a second one.
   */
  slug?: string | null;
  description?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface ChartProblem {
  index: number;
  code?: string;
  problem: string;
}

/**
 * Account types of which an organization holds exactly one account, because
 * Bigcapital posts documents to the first account of the type it finds.
 */
export const SINGLE_ACCOUNT_TYPES = ['accounts-receivable', 'accounts-payable'];

const accountTypeKeys = (): Set<string> =>
  new Set(ACCOUNT_TYPES.map((type) => type.key));

/**
 * The root type (asset, liability, equity, income or expense) of an account
 * type, or undefined for a key that is not an account type.
 */
export const rootTypeOf = (accountType: string): string | undefined =>
  ACCOUNT_TYPES.find((type) => type.key === accountType)?.rootType;

const predefinedAccounts = (): Map<string, string> =>
  new Map(AccountsData.map((account) => [account.slug, account.account_type]));

/**
 * Finds everything wrong with a chart, without touching the database.
 */
export function findChartProblems(
  accounts: ChartAccountInput[],
): ChartProblem[] {
  const problems: ChartProblem[] = [];
  const types = accountTypeKeys();
  const predefined = predefinedAccounts();
  const byCode = new Map<string, ChartAccountInput>();
  const seenSlugs = new Set<string>();
  const singles = new Map<string, number>();

  accounts.forEach((account, index) => {
    const report = (problem: string) =>
      problems.push({ index, code: account.code, problem });

    if (byCode.has(account.code)) {
      report(`The code "${account.code}" is used by more than one account.`);
    } else {
      byCode.set(account.code, account);
    }
    if (!types.has(account.accountType)) {
      report(`"${account.accountType}" is not an account type.`);
    }
    if (SINGLE_ACCOUNT_TYPES.includes(account.accountType)) {
      const count = (singles.get(account.accountType) ?? 0) + 1;
      singles.set(account.accountType, count);
      if (count > 1) {
        report(`Only one account of type "${account.accountType}" is allowed.`);
      }
    }
    if (account.slug && isMarkedAccountSlug(account.slug)) {
      const wanted = MARKED_ACCOUNTS[account.slug];

      if (rootTypeOf(account.accountType) !== wanted) {
        report(
          `The account marked "${account.slug}" must be of root type ${wanted}.`,
        );
      }
      if (seenSlugs.has(account.slug)) {
        report(`"${account.slug}" is marked on more than one account.`);
      }
      seenSlugs.add(account.slug);
    } else if (account.slug) {
      const predefinedType = predefined.get(account.slug);

      if (!predefinedType) {
        report(`"${account.slug}" is not a predefined account.`);
      } else if (predefinedType !== account.accountType) {
        report(
          `The predefined account "${account.slug}" is of type "${predefinedType}", not "${account.accountType}".`,
        );
      }
      if (seenSlugs.has(account.slug)) {
        report(
          `The predefined account "${account.slug}" is named more than once.`,
        );
      }
      seenSlugs.add(account.slug);
    }
  });

  accounts.forEach((account, index) => {
    if (!account.parentCode) return;
    const report = (problem: string) =>
      problems.push({ index, code: account.code, problem });

    const parent = byCode.get(account.parentCode);
    if (!parent) {
      report(`The parent "${account.parentCode}" is not in the chart.`);
      return;
    }
    const rootType = rootTypeOf(account.accountType);
    const parentRootType = rootTypeOf(parent.accountType);
    if (rootType && parentRootType && rootType !== parentRootType) {
      report(
        `The parent "${account.parentCode}" is ${parentRootType}, and the account is ${rootType}.`,
      );
    }
    // Walks up the parents; a walk longer than the chart has met a cycle.
    let parentCode: string | null | undefined = account.parentCode;
    let steps = 0;
    while (parentCode && steps <= accounts.length) {
      if (parentCode === account.code) {
        report('The account is its own ancestor.');
        return;
      }
      parentCode = byCode.get(parentCode)?.parentCode;
      steps += 1;
    }
  });
  return problems;
}

/**
 * @throws {ServiceError} CHART_INVALID, with every problem found.
 */
export function validateChart(accounts: ChartAccountInput[]): void {
  const problems = findChartProblems(accounts);

  if (problems.length > 0) {
    throw new ServiceError(
      CHART_ERRORS.CHART_INVALID,
      `The chart of accounts is not valid: ${problems[0].problem}`,
      { problems },
    );
  }
}

/**
 * Orders a chart so that every parent comes before its children.
 */
export function parentsFirst(
  accounts: ChartAccountInput[],
): ChartAccountInput[] {
  const byCode = new Map(accounts.map((account) => [account.code, account]));
  const depth = (account: ChartAccountInput): number => {
    let level = 0;
    let parentCode = account.parentCode;
    while (parentCode && level <= accounts.length) {
      level += 1;
      parentCode = byCode.get(parentCode)?.parentCode;
    }
    return level;
  };
  return accounts
    .map((account, index) => ({ account, index, level: depth(account) }))
    .sort((a, b) => a.level - b.level || a.index - b.index)
    .map(({ account }) => account);
}
