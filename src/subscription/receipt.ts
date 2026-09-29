import { SubscriptionPaymentMethod } from '@prisma/client';
import type { SubscriptionReceipt } from '../mail/mail.service';

export const METHOD_LABEL: Record<SubscriptionPaymentMethod, string> = {
  CASH: 'Cash',
  BANK: 'Bank transfer',
  ESEWA: 'eSewa',
  KHALTI: 'Khalti',
  OTHER: 'Other',
};

/** SUB-000042: the receipt number as printed. */
export const formatReceiptNo = (n: number) => `SUB-${String(n).padStart(6, '0')}`;

/**
 * Everything a subscription receipt shows, from the payment and the
 * platform's billing details in Settings. Shared by the admin panel and the
 * shop's own Subscription page so both print the same receipt. The payment's
 * note is left off: that field is for admins.
 */
export function toReceipt(
  p: {
    receiptNo: number;
    createdAt: Date;
    amount: { toString(): string } | number;
    currency: string;
    method: SubscriptionPaymentMethod;
    reference: string | null;
    periodFrom: Date;
    periodTo: Date;
    business: { id: string; name: string; taxId: string | null };
  },
  s: {
    billingName: string | null;
    billingTaxId: string | null;
    billingAddress: string | null;
    billingPhone: string | null;
    billingEmail: string | null;
  },
): SubscriptionReceipt {
  return {
    receiptNo: formatReceiptNo(p.receiptNo),
    issuedAt: p.createdAt,
    seller: {
      name: s.billingName,
      taxId: s.billingTaxId,
      address: s.billingAddress,
      phone: s.billingPhone,
      email: s.billingEmail,
    },
    buyer: { businessId: p.business.id, name: p.business.name, taxId: p.business.taxId },
    amount: Number(p.amount),
    currency: p.currency,
    methodLabel: METHOD_LABEL[p.method],
    reference: p.reference,
    periodFrom: p.periodFrom,
    periodTo: p.periodTo,
  };
}
