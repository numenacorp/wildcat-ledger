import { ExtRecordKind } from '../LedgerExt.constants';
import {
  BILLS,
  CREDIT_NOTES,
  INVOICES,
  TradeConfig,
  VENDOR_CREDITS,
} from '../Trade/trade.config';

export const TRACKING_ERRORS = {
  CATEGORY_NOT_FOUND: 'tracking_category_not_found',
  OPTION_NOT_FOUND: 'tracking_option_not_found',
  /** A write names a category that has not been made. */
  UNKNOWN_CATEGORY: 'TRACKING_CATEGORY_NOT_FOUND',
  /** A write names an option its category does not have. */
  UNKNOWN_OPTION: 'TRACKING_OPTION_NOT_FOUND',
  /** A write names an option that has been archived. */
  OPTION_ARCHIVED: 'TRACKING_OPTION_ARCHIVED',
  LINE_NOT_FOUND: 'line_not_found',
  LINK_NOT_FOUND: 'tracking_link_not_found',
};

/** The most options one request may name for a category. */
export const CATEGORY_MAX_OPTIONS = 1000;

/** The most lines, and the most links, one request may name. */
export const LINKS_MAX_LINES = 1000;

/** The most assignments one request may give each line. */
export const LINKS_MAX_TRACKING = 50;

/**
 * The kinds of line a link may be made on, as callers name them. A journal's
 * lines are Bigcapital's; a bill's and an invoice's are the module's own.
 */
export const LINE_TYPES: Record<
  string,
  { kind: ExtRecordKind; config: TradeConfig | null }
> = {
  journal_line: { kind: ExtRecordKind.ManualJournalEntry, config: null },
  bill_line: { kind: ExtRecordKind.BillEntry, config: BILLS },
  invoice_line: { kind: ExtRecordKind.SaleInvoiceEntry, config: INVOICES },
  vendor_credit_line: {
    kind: ExtRecordKind.VendorCreditEntry,
    config: VENDOR_CREDITS,
  },
  credit_note_line: {
    kind: ExtRecordKind.CreditNoteEntry,
    config: CREDIT_NOTES,
  },
};
