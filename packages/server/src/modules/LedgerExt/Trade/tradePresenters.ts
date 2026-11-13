import { PartyView } from './ExtParties.service';
import { TradeDocumentView } from './TradeDocuments.service';
import { TradePaymentView } from './TradePaymentViews.service';
import { TradeConfig } from './trade.config';
import { ApplicationView } from './CreditApplications.service';
import { CREDIT_STATUSES, TradeSide } from './trade.constants';

/**
 * Puts the documents and payments of each side in that side's words.
 */

/**
 * An application in the words of its side: the payment or credit it is made
 * from, and the bill or invoice it is to.
 */
export const presentApplication = (application: ApplicationView) => {
  const { sourceKind, sourceId, documentId, ...rest } = application;
  const payable =
    sourceKind === 'bill_payment' || sourceKind === 'vendor_credit';
  const from = {
    bill_payment: 'billPaymentId',
    payment_received: 'invoicePaymentId',
    vendor_credit: 'vendorCreditId',
    credit_note: 'creditNoteId',
  }[sourceKind];

  return {
    ...rest,
    [from]: sourceId,
    [payable ? 'billId' : 'invoiceId']: documentId,
  };
};

export const presentBillPayment = (payment: TradePaymentView) => {
  const {
    party,
    redemptionAccount: _redemption,
    allocations,
    applications,
    ...rest
  } = payment;

  return {
    ...rest,
    vendorId: party?.id ?? null,
    applications: applications.map(presentApplication),
    allocations: allocations.map(({ documentId, ...allocation }) => ({
      id: allocation.id,
      billId: documentId,
      amount: allocation.amount,
    })),
  };
};

export const presentBill = (bill: TradeDocumentView) => {
  const { party, number: _number, payments, applications, ...rest } = bill;

  return {
    ...rest,
    vendor: party as PartyView | null,
    applications: applications.map(presentApplication),
    payments: payments.map((allocation) => ({
      ...allocation,
      payment: presentBillPayment(allocation.payment),
    })),
  };
};

export const presentInvoicePayment = (payment: TradePaymentView) => {
  const {
    party,
    allocations,
    applications,
    account,
    redemptionAccount,
    ...rest
  } = payment;

  return {
    ...rest,
    applications: applications.map(presentApplication),
    customerId: party?.id ?? null,
    customer: party,
    accountId: account?.id ?? null,
    account,
    redemptionAccountId: redemptionAccount?.id ?? null,
    redemptionAccount,
    allocations: allocations.map(({ documentId, ...allocation }) =>
      documentId === null
        ? {
            id: allocation.id,
            invoiceId: null,
            accountId: allocation.accountId,
            amount: allocation.amount,
            memo: allocation.memo,
          }
        : {
            id: allocation.id,
            invoiceId: documentId,
            amount: allocation.amount,
          },
    ),
  };
};

export const presentInvoice = (invoice: TradeDocumentView) => {
  const { party, number, payments, applications, ...rest } = invoice;

  return {
    ...rest,
    invoiceNumber: number,
    customer: party as PartyView | null,
    applications: applications.map(presentApplication),
    payments: payments.map((allocation) => ({
      ...allocation,
      payment: presentInvoicePayment(allocation.payment),
    })),
  };
};

/**
 * A credit in its own words: what it has left is `unapplied`, and its
 * statuses speak of applying, since nothing pays it.
 */
const presentCredit = (credit: TradeDocumentView) => {
  const {
    party: _party,
    number: _number,
    payments: _payments,
    paidOn: _paidOn,
    balance,
    status,
    applications,
    ...rest
  } = credit;

  return {
    ...rest,
    status: CREDIT_STATUSES[status],
    unapplied: balance,
    applications: applications.map(presentApplication),
  };
};

export const presentVendorCredit = (credit: TradeDocumentView) => ({
  ...presentCredit(credit),
  vendor: credit.party as PartyView | null,
});

export const presentCreditNote = (credit: TradeDocumentView) => ({
  ...presentCredit(credit),
  creditNoteNumber: credit.number,
  customer: credit.party as PartyView | null,
});

/**
 * A document as the route of its kind answers it: what the audit log keeps.
 * The kind is the document's own: a bill sent below zero is a vendor credit.
 */
export const presentDocument = (
  config: TradeConfig,
  document: TradeDocumentView | null | undefined,
) =>
  !document
    ? null
    : document.kind === 'vendor_credit'
      ? presentVendorCredit(document)
      : document.kind === 'credit_note'
        ? presentCreditNote(document)
        : config.side === TradeSide.Payable
          ? presentBill(document)
          : presentInvoice(document);

/** A payment as its own side's route answers it: what the audit log keeps. */
export const presentPayment = (
  config: TradeConfig,
  payment: TradePaymentView | null | undefined,
) =>
  !payment
    ? null
    : config.side === TradeSide.Payable
      ? presentBillPayment(payment)
      : presentInvoicePayment(payment);
