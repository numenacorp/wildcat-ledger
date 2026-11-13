import { ExtRecordKind } from '../LedgerExt.constants';
import { TRADE_ERRORS, TradeSide } from './trade.constants';

/**
 * Where bills and invoices differ. Each is the other seen from the other
 * side of the books; the differences below are rules, not signs.
 */
export interface TradeConfig {
  side: TradeSide;
  documentKind: ExtRecordKind;
  lineKind: ExtRecordKind;
  paymentKind: ExtRecordKind;
  partyKind: ExtRecordKind;
  /** Bigcapital's names for the documents, as ledger rows refer to them. */
  documentReference: string;
  paymentReference: string;
  /** The words used in messages. */
  nouns: {
    document: string;
    payment: string;
    party: string;
    /** What settles the document: payments of it, or applications from it. */
    settlements: string;
  };
  /** The keys of ids in the payload of an error. */
  idKeys: {
    document: string;
    documents: string;
    payment: string;
    party: string;
  };
  errors: {
    documentNotFound: string;
    paymentNotFound: string;
    partyNotFound: string;
    partyRequired: string;
    /** An edit would change what the books hold of a settled document. */
    editHasSettlements: string;
    allocationExceedsBalance: string;
    hasPayments: string;
    voided: string;
    paymentDocumentNotFound: string;
    paymentAmountBelowAllocations: string;
    amountNegative: string;
  };
  /** A party named by an external id not seen before is made, with no name. */
  partyMadeOnSight: boolean;
  /**
   * A credit: the document of its side with the signs turned. It is paid by
   * nothing, and is applied to the documents of `appliesTo`.
   */
  credit: boolean;
  appliesTo?: TradeConfig;
  /** A document sent with a total below zero is stored as this credit. */
  negativeTotalBecomes?: () => TradeConfig;
  /** Deleting a deleted payment is answered with the payment; else not found. */
  deletedPaymentStillAnswers: boolean;
  /** The document carries a number of its own, issued when none is sent. */
  numbered: boolean;
  numberPrefix?: string;
  numberSequence?: string;
  /** A payment names its party, and may pay only that party's documents. */
  paymentNamesParty: boolean;
}

export const BILLS: TradeConfig = {
  side: TradeSide.Payable,
  documentKind: ExtRecordKind.Bill,
  lineKind: ExtRecordKind.BillEntry,
  paymentKind: ExtRecordKind.BillPayment,
  partyKind: ExtRecordKind.Vendor,
  documentReference: 'Bill',
  paymentReference: 'BillPayment',
  nouns: {
    document: 'bill',
    payment: 'bill payment',
    party: 'vendor',
    settlements: 'payments',
  },
  idKeys: {
    document: 'billId',
    documents: 'billIds',
    payment: 'paymentId',
    party: 'vendorId',
  },
  errors: {
    documentNotFound: TRADE_ERRORS.BILL_NOT_FOUND,
    paymentNotFound: TRADE_ERRORS.BILL_PAYMENT_NOT_FOUND,
    partyNotFound: TRADE_ERRORS.VENDOR_NOT_FOUND,
    partyRequired: TRADE_ERRORS.VENDOR_REQUIRED,
    editHasSettlements: TRADE_ERRORS.BILL_EDIT_HAS_PAYMENTS,
    allocationExceedsBalance: TRADE_ERRORS.BILL_ALLOCATION_EXCEEDS_BALANCE,
    hasPayments: TRADE_ERRORS.BILL_HAS_PAYMENTS,
    voided: TRADE_ERRORS.BILL_VOIDED,
    paymentDocumentNotFound: TRADE_ERRORS.PAYMENT_BILL_NOT_FOUND,
    paymentAmountBelowAllocations:
      TRADE_ERRORS.PAYMENT_AMOUNT_BELOW_ALLOCATIONS,
    amountNegative: TRADE_ERRORS.BILL_AMOUNT_NEGATIVE,
  },
  partyMadeOnSight: true,
  credit: false,
  negativeTotalBecomes: () => VENDOR_CREDITS,
  deletedPaymentStillAnswers: true,
  numbered: false,
  paymentNamesParty: false,
};

export const INVOICES: TradeConfig = {
  side: TradeSide.Receivable,
  documentKind: ExtRecordKind.SaleInvoice,
  lineKind: ExtRecordKind.SaleInvoiceEntry,
  paymentKind: ExtRecordKind.PaymentReceived,
  partyKind: ExtRecordKind.Customer,
  documentReference: 'SaleInvoice',
  paymentReference: 'PaymentReceive',
  nouns: {
    document: 'invoice',
    payment: 'invoice payment',
    party: 'customer',
    settlements: 'payments',
  },
  idKeys: {
    document: 'invoiceId',
    documents: 'invoiceIds',
    payment: 'paymentId',
    party: 'customerId',
  },
  errors: {
    documentNotFound: TRADE_ERRORS.INVOICE_NOT_FOUND,
    paymentNotFound: TRADE_ERRORS.INVOICE_PAYMENT_NOT_FOUND,
    partyNotFound: TRADE_ERRORS.CUSTOMER_NOT_FOUND,
    partyRequired: TRADE_ERRORS.CUSTOMER_REQUIRED,
    editHasSettlements: TRADE_ERRORS.INVOICE_EDIT_HAS_PAYMENTS,
    allocationExceedsBalance: TRADE_ERRORS.INVOICE_ALLOCATION_EXCEEDS_BALANCE,
    hasPayments: TRADE_ERRORS.INVOICE_HAS_PAYMENTS,
    voided: TRADE_ERRORS.INVOICE_VOIDED,
    paymentDocumentNotFound: TRADE_ERRORS.PAYMENT_INVOICE_NOT_FOUND,
    paymentAmountBelowAllocations:
      TRADE_ERRORS.PAYMENT_AMOUNT_BELOW_ALLOCATIONS,
    amountNegative: TRADE_ERRORS.INVOICE_AMOUNT_NEGATIVE,
  },
  partyMadeOnSight: false,
  credit: false,
  deletedPaymentStillAnswers: false,
  numbered: true,
  numberPrefix: 'INV-',
  numberSequence: 'trade_document_number',
  paymentNamesParty: true,
};

/**
 * A vendor credit: what a vendor owes back. It debits payables and credits
 * each line's account, and is applied to that vendor's bills.
 */
export const VENDOR_CREDITS: TradeConfig = {
  ...BILLS,
  documentKind: ExtRecordKind.VendorCredit,
  lineKind: ExtRecordKind.VendorCreditEntry,
  documentReference: 'VendorCredit',
  nouns: {
    ...BILLS.nouns,
    document: 'vendor credit',
    settlements: 'applications',
  },
  idKeys: { ...BILLS.idKeys, document: 'vendorCreditId' },
  errors: {
    ...BILLS.errors,
    documentNotFound: TRADE_ERRORS.VENDOR_CREDIT_NOT_FOUND,
    editHasSettlements: TRADE_ERRORS.VENDOR_CREDIT_EDIT_HAS_APPLICATIONS,
    hasPayments: TRADE_ERRORS.VENDOR_CREDIT_HAS_APPLICATIONS,
    voided: TRADE_ERRORS.VENDOR_CREDIT_VOIDED,
    amountNegative: TRADE_ERRORS.VENDOR_CREDIT_AMOUNT_NEGATIVE,
  },
  credit: true,
  appliesTo: BILLS,
  negativeTotalBecomes: undefined,
};

/**
 * A customer credit note: what a customer is owed back. It debits each
 * line's account and credits receivables, and is applied to that customer's
 * invoices.
 */
export const CREDIT_NOTES: TradeConfig = {
  ...INVOICES,
  documentKind: ExtRecordKind.CreditNote,
  lineKind: ExtRecordKind.CreditNoteEntry,
  documentReference: 'CreditNote',
  nouns: {
    ...INVOICES.nouns,
    document: 'credit note',
    settlements: 'applications',
  },
  idKeys: { ...INVOICES.idKeys, document: 'creditNoteId' },
  errors: {
    ...INVOICES.errors,
    documentNotFound: TRADE_ERRORS.CREDIT_NOTE_NOT_FOUND,
    editHasSettlements: TRADE_ERRORS.CREDIT_NOTE_EDIT_HAS_APPLICATIONS,
    hasPayments: TRADE_ERRORS.CREDIT_NOTE_HAS_APPLICATIONS,
    voided: TRADE_ERRORS.CREDIT_NOTE_VOIDED,
    amountNegative: TRADE_ERRORS.CREDIT_NOTE_AMOUNT_NEGATIVE,
  },
  credit: true,
  appliesTo: INVOICES,
  numberPrefix: 'CN-',
  numberSequence: 'credit_note_number',
};

/** The credit kind of each side. */
export const creditsOf = (config: TradeConfig): TradeConfig =>
  config.side === TradeSide.Payable ? VENDOR_CREDITS : CREDIT_NOTES;

/** The method of a payment that redeems a credit balance and moves no cash. */
export const CREDIT_BALANCE_METHOD = 'CREDIT_BALANCE';
