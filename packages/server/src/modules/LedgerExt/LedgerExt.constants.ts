/**
 * The kinds of record the extension keeps companion rows for. A kind names a
 * Bigcapital record type (or one of the extension's own), and together with the
 * record id it keys every `ext_*` table.
 */
export enum ExtRecordKind {
  Account = 'account',
  ManualJournal = 'manual_journal',
  ManualJournalEntry = 'manual_journal_entry',
  Bill = 'bill',
  BillEntry = 'bill_entry',
  BillPayment = 'bill_payment',
  SaleInvoice = 'sale_invoice',
  SaleInvoiceEntry = 'sale_invoice_entry',
  PaymentReceived = 'payment_received',
  VendorCredit = 'vendor_credit',
  VendorCreditEntry = 'vendor_credit_entry',
  CreditNote = 'credit_note',
  CreditNoteEntry = 'credit_note_entry',
  CreditApplication = 'credit_application',
  Vendor = 'vendor',
  Customer = 'customer',
  TrackingCategory = 'tracking_category',
  TrackingCategoryOption = 'tracking_category_option',
  FixedAsset = 'fixed_asset',
  FixedAssetValueUpdate = 'fixed_asset_value_update',
  OpeningBalance = 'opening_balance',
  Loan = 'loan',
  Lock = 'lock',
  LockException = 'lock_exception',
}

export const ERRORS = {
  EXTERNAL_ID_IN_USE: 'EXTERNAL_ID_IN_USE',
  EXTERNAL_ID_FIXED: 'EXTERNAL_ID_FIXED',
  METADATA_NOT_SERIALIZABLE: 'METADATA_NOT_SERIALIZABLE',
  INVALID_TIMESTAMP: 'INVALID_TIMESTAMP',
  DATE_NOT_PLAIN: 'DATE_NOT_PLAIN',
};

/** Longest `external_id` accepted on any record. */
export const EXTERNAL_ID_MAX_LENGTH = 255;

/** Largest serialized `metadata` value accepted on any record, in bytes. */
export const METADATA_MAX_BYTES = 64 * 1024;
