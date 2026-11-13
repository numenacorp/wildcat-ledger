/**
 * Accounts the extension posts to on its own. A chart marks each with a slug
 * on one of its entries; the extension then finds the account by that slug.
 * The value is the root type the marked account must have.
 */
export const MARKED_ACCOUNTS: Record<string, string> = {
  /** Money a bill payment sends out with no paying account named. */
  'payments-out-clearing': 'liability',
  /** Money an invoice payment brings in with no receiving account named. */
  'payments-in-clearing': 'asset',
  /**
   * Money paid to a vendor and not yet applied to a bill, on the cash basis
   * only. A chart that does not mark it uses `uncategorized-expense`.
   */
  'unapplied-cash-expense': 'expense',
  /**
   * Money received from a customer and not yet applied to an invoice, on the
   * cash basis only. A chart that does not mark it uses
   * `uncategorized-income`.
   */
  'unapplied-cash-income': 'income',
  /** Stands in for `unapplied-cash-expense` where a chart does not mark it. */
  'uncategorized-expense': 'expense',
  /** Stands in for `unapplied-cash-income` where a chart does not mark it. */
  'uncategorized-income': 'income',
  /** A credit balance redeemed against an invoice with no account named. */
  'unearned-revenue': 'liability',
  /** Income recognised on the cash basis by a redeemed credit balance. */
  sales: 'income',
  /** The account a fixed asset's own account is made under. */
  'fixed-assets': 'asset',
  /** What a fixed asset has lost in value, named by slug on a write. */
  'accumulated-depreciation': 'asset',
  /** The cost of that loss, named by slug on a write. */
  depreciation: 'expense',
};

export type MarkedAccountSlug = keyof typeof MARKED_ACCOUNTS;

export const isMarkedAccountSlug = (slug: unknown): slug is MarkedAccountSlug =>
  typeof slug === 'string' &&
  Object.prototype.hasOwnProperty.call(MARKED_ACCOUNTS, slug);

/** The key of the setting that holds the id of a marked account. */
export const markedAccountSetting = (slug: string): string =>
  `marked_account:${slug}`;

export const MARKED_ACCOUNT_ERRORS = {
  /** The chart marks no account for a slug a write needs. */
  ACCOUNT_NOT_MARKED: 'LEDGER_ACCOUNT_NOT_MARKED',
};
