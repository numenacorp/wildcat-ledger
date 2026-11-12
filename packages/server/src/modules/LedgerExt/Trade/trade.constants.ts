/** Which side of the books a document is on. */
export enum TradeSide {
  /** Bills, vendors and bill payments. */
  Payable = 'payable',
  /** Invoices, customers and invoice payments. */
  Receivable = 'receivable',
}

export const TRADE_ERRORS = {
  ALLOCATION_NAMES_ONE_TARGET: 'ALLOCATION_NAMES_ONE_TARGET',
  VENDOR_NOT_FOUND: 'vendor_not_found',
  BILL_NOT_FOUND: 'bill_not_found',
  BILL_PAYMENT_NOT_FOUND: 'bill_payment_not_found',
  /** An edit would leave a bill totalling less than has been paid on it. */
  BILL_AMOUNT_BELOW_PAID: 'BILL_AMOUNT_BELOW_PAID',
  /** A payment would pay more of a bill than it still owes. */
  BILL_ALLOCATION_EXCEEDS_BALANCE: 'BILL_ALLOCATION_EXCEEDS_BALANCE',
  /** A bill with a payment on it cannot be voided. */
  BILL_HAS_PAYMENTS: 'BILL_HAS_PAYMENTS',
  /** A payment's amount is less than the sum of what it allocates. */
  PAYMENT_AMOUNT_BELOW_ALLOCATIONS: 'PAYMENT_AMOUNT_BELOW_ALLOCATIONS',
  /** A payment allocates to a bill that does not exist. */
  PAYMENT_BILL_NOT_FOUND: 'PAYMENT_BILL_NOT_FOUND',
  /** Both a vendor id and a vendor external id, or neither, were given. */
  VENDOR_REQUIRED: 'VENDOR_REQUIRED',

  CUSTOMER_NOT_FOUND: 'customer_not_found',
  INVOICE_NOT_FOUND: 'invoice_not_found',
  INVOICE_PAYMENT_NOT_FOUND: 'invoice_payment_not_found',
  /** An edit would leave an invoice totalling less than has been paid on it. */
  INVOICE_AMOUNT_BELOW_PAID: 'INVOICE_AMOUNT_BELOW_PAID',
  /** A payment would pay more of an invoice than it is still owed. */
  INVOICE_ALLOCATION_EXCEEDS_BALANCE: 'INVOICE_ALLOCATION_EXCEEDS_BALANCE',
  /** An invoice with a payment on it cannot be voided. */
  INVOICE_HAS_PAYMENTS: 'INVOICE_HAS_PAYMENTS',
  /** An invoice may not total less than zero. */
  INVOICE_AMOUNT_NEGATIVE: 'INVOICE_AMOUNT_NEGATIVE',
  /** A voided invoice can be neither edited nor paid. */
  INVOICE_VOIDED: 'INVOICE_VOIDED',
  /** A payment allocates to an invoice that does not exist. */
  PAYMENT_INVOICE_NOT_FOUND: 'PAYMENT_INVOICE_NOT_FOUND',
  /** A payment allocates to an invoice of another customer. */
  PAYMENT_INVOICE_OF_ANOTHER_CUSTOMER: 'PAYMENT_INVOICE_OF_ANOTHER_CUSTOMER',
  /** Both a customer id and a customer external id, or neither, were given. */
  CUSTOMER_REQUIRED: 'CUSTOMER_REQUIRED',
};

/** The most lines one bill may hold. */
export const DOCUMENT_MAX_ENTRIES = 1000;

/** The most bills one payment may be allocated to. */
export const PAYMENT_MAX_ALLOCATIONS = 1000;

/** The most documents one page of a list holds: a whole export in one call. */
export const DOCUMENT_LIST_MAX_PAGE_SIZE = 50000;

export type DocumentStatus = 'open' | 'partially_paid' | 'paid' | 'voided';

/**
 * The status of a bill: voided once voided, whatever is paid; otherwise paid
 * when it totals zero or when a positive total is paid off, partially paid
 * when something is paid, and open in every other case, a negative total
 * included.
 */
export function documentStatus(
  amount: bigint,
  paid: bigint,
  voided: boolean,
): DocumentStatus {
  if (voided) return 'voided';
  if (amount === 0n || (amount > 0n && amount - paid === 0n)) return 'paid';
  if (paid > 0n) return 'partially_paid';
  return 'open';
}

/** The longest memo of a payment part paid to an account. */
export const ALLOCATION_MEMO_MAX_LENGTH = 2000;
