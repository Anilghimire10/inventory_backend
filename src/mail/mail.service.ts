import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

interface SendArgs {
  to: string;
  subject: string;
  html: string;
}

/**
 * Transactional email via Resend's HTTP API.
 *
 * Required env:
 *   RESEND_API_KEY  — your Resend API key (sent as `Authorization: Bearer <key>`)
 *   RESEND_FROM     — a verified sender address on your Resend domain
 * Optional:
 *   RESEND_FROM_NAME — display name for the sender (default "Inventory Manager")
 *   RESEND_API_URL   — override the API endpoint (default api.resend.com/emails)
 *
 * If the key is missing we fail loudly rather than silently dropping mail.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  constructor(private config: ConfigService) {}

  private cfg() {
    const apiKey = this.config.get<string>('RESEND_API_KEY');
    const from = this.config.get<string>('RESEND_FROM');
    if (!apiKey || !from) {
      throw new InternalServerErrorException(
        'Email service is not configured. Set RESEND_API_KEY and RESEND_FROM.',
      );
    }
    return {
      apiKey,
      from,
      fromName:
        this.config.get<string>('RESEND_FROM_NAME') ?? 'Inventory Manager',
      url:
        this.config.get<string>('RESEND_API_URL') ??
        'https://api.resend.com/emails',
    };
  }

  async send({ to, subject, html }: SendArgs) {
    const { apiKey, from, fromName, url } = this.cfg();

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        // Resend accepts a "Name <address>" string for the sender, but its
        // sandbox-mode recipient allowlist check does a raw string match on
        // `to` and doesn't parse "Name <address>" -- so the recipient must
        // stay a bare address or a real allowed recipient silently 403s.
        from: `${fromName} <${from}>`,
        to: [to],
        subject,
        html,
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      this.logger.error(`Resend send failed (${res.status}): ${detail}`);
      throw new InternalServerErrorException('Failed to send email');
    }
  }

  // ----- Templated messages used by the auth flows -----

  sendVerificationCode(to: string, name: string, code: string) {
    return this.send({
      to,
      subject: 'Verify your email',
      html: this.codeTemplate(
        name,
        'Confirm your email address',
        'Use this code to verify your account:',
        code,
      ),
    });
  }

  /** Email a sale receipt to a customer. */
  sendReceipt(
    to: string,
    data: {
      customerName: string;
      businessName: string;
      receiptNo: string;
      date: Date;
      currency: string;
      items: { name: string; quantity: number; unitPrice: number; lineTotal: number }[];
      subtotal: number;
      discount: number;
      tax: number;
      total: number;
    },
  ) {
    const money = (n: number) => `${data.currency} ${n.toFixed(2)}`;
    const rows = data.items
      .map(
        (it) => `
        <tr>
          <td style="padding:6px 10px;border-bottom:1px solid #e2e8f0">${it.name}</td>
          <td style="padding:6px 10px;border-bottom:1px solid #e2e8f0;text-align:right">${it.quantity}</td>
          <td style="padding:6px 10px;border-bottom:1px solid #e2e8f0;text-align:right">${money(it.unitPrice)}</td>
          <td style="padding:6px 10px;border-bottom:1px solid #e2e8f0;text-align:right">${money(it.lineTotal)}</td>
        </tr>`,
      )
      .join('');

    const html = `
      <div style="font-family:system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#0f172a">
        <h2 style="margin:0 0 4px">${data.businessName}</h2>
        <p style="margin:0 0 16px;color:#475569">Receipt ${data.receiptNo} · ${data.date.toLocaleString()}</p>
        <p style="margin:0 0 12px">Hi ${data.customerName}, thanks for your purchase. Here's your receipt:</p>
        <table style="width:100%;border-collapse:collapse;font-size:14px">
          <thead>
            <tr style="text-align:left;color:#64748b;font-size:12px;text-transform:uppercase">
              <th style="padding:6px 10px">Item</th>
              <th style="padding:6px 10px;text-align:right">Qty</th>
              <th style="padding:6px 10px;text-align:right">Price</th>
              <th style="padding:6px 10px;text-align:right">Total</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
        <div style="margin-top:12px;font-size:14px">
          <div style="display:flex;justify-content:space-between;color:#475569"><span>Subtotal</span><span>${money(data.subtotal)}</span></div>
          <div style="display:flex;justify-content:space-between;color:#475569"><span>Discount</span><span>${money(data.discount)}</span></div>
          <div style="display:flex;justify-content:space-between;color:#475569"><span>Tax</span><span>${money(data.tax)}</span></div>
          <div style="display:flex;justify-content:space-between;font-weight:700;font-size:16px;margin-top:6px"><span>Total</span><span>${money(data.total)}</span></div>
        </div>
      </div>`;

    return this.send({
      to,
      subject: `Receipt ${data.receiptNo} — ${data.businessName}`,
      html,
    });
  }

  /** Daily low-stock digest sent to a business owner. */
  sendLowStockDigest(
    to: string,
    name: string,
    businessName: string,
    items: {
      productName: string;
      sku?: string | null;
      quantity: number;
      reorderLevel: number;
      storeName?: string | null;
    }[],
  ) {
    const rows = items
      .map(
        (it) => `
        <tr>
          <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0">${it.productName}${
            it.sku ? ` <span style="color:#94a3b8">(${it.sku})</span>` : ''
          }${it.storeName ? `<div style="color:#94a3b8;font-size:12px">${it.storeName}</div>` : ''}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;text-align:right;font-weight:600;color:#dc2626">${it.quantity}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;text-align:right;color:#475569">${it.reorderLevel}</td>
        </tr>`,
      )
      .join('');

    const html = `
      <div style="font-family:system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#0f172a">
        <h2 style="margin:0 0 4px">Low stock alert</h2>
        <p style="margin:0 0 16px;color:#475569">Hi ${name}, ${items.length} item${
          items.length === 1 ? '' : 's'
        } at <strong>${businessName}</strong> ${
          items.length === 1 ? 'is' : 'are'
        } at or below the reorder level:</p>
        <table style="width:100%;border-collapse:collapse;font-size:14px">
          <thead>
            <tr style="text-align:left;color:#64748b;font-size:12px;text-transform:uppercase">
              <th style="padding:8px 12px">Product</th>
              <th style="padding:8px 12px;text-align:right">In stock</th>
              <th style="padding:8px 12px;text-align:right">Reorder at</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
        <p style="margin:16px 0 0;color:#94a3b8;font-size:13px">Restock soon to avoid running out.</p>
      </div>`;

    return this.send({
      to,
      subject: `Low stock: ${items.length} item${items.length === 1 ? '' : 's'} need restocking`,
      html,
    });
  }

  sendPasswordReset(to: string, name: string, code: string) {
    return this.send({
      to,
      subject: 'Reset your password',
      html: this.codeTemplate(
        name,
        'Reset your password',
        'Use this code to set a new password. If you did not request this, you can ignore this email:',
        code,
      ),
    });
  }

  private codeTemplate(
    name: string,
    heading: string,
    intro: string,
    code: string,
  ) {
    return `
      <div style="font-family:system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#0f172a">
        <h2 style="margin:0 0 16px">${heading}</h2>
        <p style="margin:0 0 8px">Hi ${name},</p>
        <p style="margin:0 0 16px;color:#475569">${intro}</p>
        <div style="font-size:32px;font-weight:700;letter-spacing:8px;background:#f1f5f9;border-radius:8px;padding:16px;text-align:center">${code}</div>
        <p style="margin:16px 0 0;color:#94a3b8;font-size:13px">This code expires in 15 minutes.</p>
      </div>`;
  }
}
