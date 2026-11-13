export const ACCOUNT_ERRORS = {
  // Bigcapital's own error types, raised by the extension in the same cases.
  ACCOUNT_NOT_FOUND: 'account_not_found',
  ACCOUNT_IN_USE: 'ACCOUNT_IN_USE',
  TRACKING_OPTION_WITHOUT_CATEGORY: 'TRACKING_OPTION_WITHOUT_CATEGORY',
  ACCOUNT_TYPE_NOT_FOUND: 'account_type_not_found',
  PARENT_ACCOUNT_NOT_FOUND: 'parent_account_not_found',
  PARENT_ACCOUNT_HAS_DIFFERENT_TYPE: 'parent_has_different_type',
  ACCOUNT_PREDEFINED: 'account_predefined',
  ACCOUNT_HAS_ASSOCIATED_TRANSACTIONS: 'account_has_associated_transactions',
  // The extension's own.
  ACCOUNT_HAS_CHILDREN: 'ACCOUNT_HAS_CHILDREN',
  ACCOUNT_PARENT_CIRCULAR: 'ACCOUNT_PARENT_CIRCULAR',
  ACCOUNT_TYPE_SINGLE: 'ACCOUNT_TYPE_SINGLE',
  /** A type root groups accounts: it takes no posting, move, delete or archive. */
  ACCOUNT_IS_TYPE_ROOT: 'ACCOUNT_IS_TYPE_ROOT',
  /** An archived account takes no new line until it is restored. */
  ACCOUNT_ARCHIVED: 'ACCOUNT_ARCHIVED',
};
