import { PartyView } from './ExtParties.service';
import { TradeDocumentView } from './TradeDocuments.service';
import { TradePaymentView } from './TradePaymentViews.service';

/**
 * Puts the documents and payments of each side in that side's words.
 */

export const presentBillPayment = (payment: TradePaymentView) => {
  const {
    party: _party,
    redemptionAccount: _redemption,
    allocations,
    ...rest
  } = payment;

  return {
    ...rest,
    allocations: allocations.map(({ documentId, ...allocation }) => ({
      id: allocation.id,
      billId: documentId,
      amount: allocation.amount,
    })),
  };
};

export const presentBill = (bill: TradeDocumentView) => {
  const { party, number: _number, payments, ...rest } = bill;

  return {
    ...rest,
    vendor: party as PartyView | null,
    payments: payments.map((allocation) => ({
      ...allocation,
      payment: presentBillPayment(allocation.payment),
    })),
  };
};

export const presentInvoicePayment = (payment: TradePaymentView) => {
  const { party, allocations, account, redemptionAccount, ...rest } = payment;

  return {
    ...rest,
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
  const { party, number, payments, ...rest } = invoice;

  return {
    ...rest,
    invoiceNumber: number,
    customer: party as PartyView | null,
    payments: payments.map((allocation) => ({
      ...allocation,
      payment: presentInvoicePayment(allocation.payment),
    })),
  };
};
