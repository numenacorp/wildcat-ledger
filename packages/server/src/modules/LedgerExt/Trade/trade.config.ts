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
  nouns: { document: string; payment: string; party: string };
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
    amountBelowPaid: string;
    allocationExceedsBalance: string;
    hasPayments: string;
    paymentDocumentNotFound: string;
    paymentAmountBelowAllocations: string;
  };
  /** A party named by an external id not seen before is made, with no name. */
  partyMadeOnSight: boolean;
  /** A document may total less than zero. */
  negativeTotalAllowed: boolean;
  /** A voided document can still be edited by its id, staying voided. */
  voidedEditable: boolean;
  /** A voided document can still be paid. */
  voidedPayable: boolean;
  /**
   * On the cash basis a payment is shared over the document's lines as they
   * stood when it was made. Otherwise it is shared over the lines as they
   * stand now, and again after every edit.
   */
  paymentsKeepSplit: boolean;
  /**
   * A payment's entry against the control account is dated on the document's
   * day, and that is the day the lock looks at. Otherwise on its own day.
   */
  paymentDatedOnDocument: boolean;
  /** Deleting a deleted payment is answered with the payment; else not found. */
  deletedPaymentStillAnswers: boolean;
  /** The document carries a number of its own, issued when none is sent. */
  numbered: boolean;
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
  nouns: { document: 'bill', payment: 'bill payment', party: 'vendor' },
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
    amountBelowPaid: TRADE_ERRORS.BILL_AMOUNT_BELOW_PAID,
    allocationExceedsBalance: TRADE_ERRORS.BILL_ALLOCATION_EXCEEDS_BALANCE,
    hasPayments: TRADE_ERRORS.BILL_HAS_PAYMENTS,
    paymentDocumentNotFound: TRADE_ERRORS.PAYMENT_BILL_NOT_FOUND,
    paymentAmountBelowAllocations:
      TRADE_ERRORS.PAYMENT_AMOUNT_BELOW_ALLOCATIONS,
  },
  partyMadeOnSight: true,
  negativeTotalAllowed: true,
  voidedEditable: true,
  voidedPayable: true,
  paymentsKeepSplit: true,
  paymentDatedOnDocument: true,
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
  nouns: { document: 'invoice', payment: 'invoice payment', party: 'customer' },
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
    amountBelowPaid: TRADE_ERRORS.INVOICE_AMOUNT_BELOW_PAID,
    allocationExceedsBalance: TRADE_ERRORS.INVOICE_ALLOCATION_EXCEEDS_BALANCE,
    hasPayments: TRADE_ERRORS.INVOICE_HAS_PAYMENTS,
    paymentDocumentNotFound: TRADE_ERRORS.PAYMENT_INVOICE_NOT_FOUND,
    paymentAmountBelowAllocations:
      TRADE_ERRORS.PAYMENT_AMOUNT_BELOW_ALLOCATIONS,
  },
  partyMadeOnSight: false,
  negativeTotalAllowed: false,
  voidedEditable: false,
  voidedPayable: false,
  paymentsKeepSplit: false,
  paymentDatedOnDocument: false,
  deletedPaymentStillAnswers: false,
  numbered: true,
  paymentNamesParty: true,
};

/** The method of a payment that redeems a credit balance and moves no cash. */
export const CREDIT_BALANCE_METHOD = 'CREDIT_BALANCE';
