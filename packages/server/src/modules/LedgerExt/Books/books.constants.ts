export const BOOKS_ERRORS = {
  FIXED_ASSET_NOT_FOUND: 'fixed_asset_not_found',
  LOAN_NOT_FOUND: 'loan_not_found',
  /** A value update on an asset that has no accumulated account yet. */
  ACCUMULATED_ACCOUNT_NOT_SET: 'ACCUMULATED_ACCOUNT_NOT_SET',
  /** An account named both by id and by slug, or by neither where one is due. */
  ACCOUNT_NAMED_ONCE: 'ACCOUNT_NAMED_ONCE',
  OPENING_BALANCES_ALREADY_IMPORTED: 'OPENING_BALANCES_ALREADY_IMPORTED',
  OPENING_ACCOUNT_NOT_FOUND: 'OPENING_ACCOUNT_NOT_FOUND',
  OPENING_ACCOUNT_NAMED_TWICE: 'OPENING_ACCOUNT_NAMED_TWICE',
};

/** The most rows one page of fixed assets, value updates or loans holds. */
export const BOOKS_LIST_MAX_PAGE_SIZE = 50000;

/** The most rows one import of opening balances holds. */
export const OPENING_MAX_BALANCES = 5000;

/** Bigcapital's names for the kinds of document these records post as. */
export const OPENING_REFERENCE = 'OpeningBalance';
export const VALUE_UPDATE_REFERENCE = 'FixedAssetValueUpdate';

export const OPENING_EQUITY_SLUG = 'opening-balance-equity';

export const paging = (query: {
  page?: string | number;
  pageSize?: string | number;
}) => ({
  page: Math.max(1, Number(query.page) || 1),
  pageSize: Math.min(
    Math.max(1, Number(query.pageSize) || 50),
    BOOKS_LIST_MAX_PAGE_SIZE,
  ),
});
