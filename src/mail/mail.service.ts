import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EmailStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { accessEndsAt, supportContact } from '../common/subscription';

/** What kind of email it is, for the admin panel's email log. */
export type EmailType =
  | 'verification'
  | 'password-reset'
  | 'receipt'
  | 'low-stock'
  | 'invite'
  | 'subscription-reminder'
  | 'announcement'
  | 'support-reply'
  | 'support-new';

interface SendArgs {
  to: string;
  subject: string;
  html: string;
  type: EmailType;
  /** Whose email it is. Omitted, it is looked up from the recipient's account. */
  businessId?: string;
}

/** Escape user-supplied text before it goes into an email's HTML. */
const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

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

  constructor(
    private config: ConfigService,
    private prisma: PrismaService,
  ) {}

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

  /**
   * Where mail goes. 'log' writes the message to the application log and
   * sends nothing — the point of it is local development, where Resend's
   * sandbox 403s every recipient that isn't the account owner's own address,
   * so a signup or reset for any test address fills the log with failures and
   * the code never arrives. validateEnv() refuses this value in production.
   */
  private transport() {
    return (this.config.get<string>('MAIL_TRANSPORT') ?? 'resend').toLowerCase();
  }

  /**
   * Send, then write the outcome to the email log. The log is best-effort: a
   * failed log write never fails the email, and a failed email is logged
   * before its error goes back to the caller.
   */
  async send(args: SendArgs) {
    try {
      const status = await this.deliver(args);
      void this.record(args, status);
    } catch (e) {
      void this.record(args, EmailStatus.FAILED, (e as { detail?: string }).detail ?? (e as Error).message);
      throw e;
    }
  }

  private async record(args: SendArgs, status: EmailStatus, error?: string) {
    try {
      const businessId =
        args.businessId ??
        (
          await this.prisma.user.findUnique({
            where: { email: args.to.trim().toLowerCase() },
            select: { businessId: true },
          })
        )?.businessId ??
        null;
      await this.prisma.emailLog.create({
        data: {
          to: args.to,
          type: args.type,
          subject: args.subject,
          status,
          error: error ? error.slice(0, 1000) : null,
          businessId,
        },
      });
    } catch (e) {
      this.logger.warn(`Email log write failed: ${(e as Error).message}`);
    }
  }

  private async deliver({ to, subject, html }: SendArgs): Promise<EmailStatus> {
    if (this.transport() === 'log') {
      this.logger.log(`[mail:log] to=${to} subject="${subject}" (not sent)`);
      return EmailStatus.LOGGED;
    }
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
      // What Resend said goes to the email log; the caller gets the generic
      // message, as before.
      throw Object.assign(new InternalServerErrorException('Failed to send email'), {
        detail: `Resend ${res.status}: ${detail}`,
      });
    }
    return EmailStatus.SENT;
  }

  // ----- Templated messages used by the auth flows -----

  sendVerificationCode(to: string, name: string, code: string) {
    return this.send({
      type: 'verification',
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
      /** Prices already included the tax, so it isn't added on top. */
      taxInclusive?: boolean;
    },
    /** The customer isn't a user, so the log can't look their business up. */
    businessId?: string,
  ) {
    const money = (n: number) => `${esc(data.currency)} ${n.toFixed(2)}`;
    const rows = data.items
      .map(
        (it) => `
        <tr>
          <td style="padding:6px 10px;border-bottom:1px solid #e2e8f0">${esc(it.name)}</td>
          <td style="padding:6px 10px;border-bottom:1px solid #e2e8f0;text-align:right">${it.quantity}</td>
          <td style="padding:6px 10px;border-bottom:1px solid #e2e8f0;text-align:right">${money(it.unitPrice)}</td>
          <td style="padding:6px 10px;border-bottom:1px solid #e2e8f0;text-align:right">${money(it.lineTotal)}</td>
        </tr>`,
      )
      .join('');

    const html = `
      <div style="font-family:system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#0f172a">
        <h2 style="margin:0 0 4px">${esc(data.businessName)}</h2>
        <p style="margin:0 0 16px;color:#475569">Receipt ${esc(data.receiptNo)} · ${data.date.toLocaleString()}</p>
        <p style="margin:0 0 12px">Hi ${esc(data.customerName)}, thanks for your purchase. Here's your receipt:</p>
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
          <div style="display:flex;justify-content:space-between;color:#475569"><span>${data.taxInclusive ? 'Tax (included)' : 'Tax'}</span><span>${money(data.tax)}</span></div>
          <div style="display:flex;justify-content:space-between;font-weight:700;font-size:16px;margin-top:6px"><span>Total</span><span>${money(data.total)}</span></div>
        </div>
      </div>`;

    return this.send({
      type: 'receipt',
      businessId,
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
          <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0">${esc(it.productName)}${
            it.sku ? ` <span style="color:#94a3b8">(${esc(it.sku)})</span>` : ''
          }${it.storeName ? `<div style="color:#94a3b8;font-size:12px">${esc(it.storeName)}</div>` : ''}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;text-align:right;font-weight:600;color:#dc2626">${it.quantity}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;text-align:right;color:#475569">${it.reorderLevel}</td>
        </tr>`,
      )
      .join('');

    const html = `
      <div style="font-family:system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#0f172a">
        <h2 style="margin:0 0 4px">Low stock alert</h2>
        <p style="margin:0 0 16px;color:#475569">Hi ${esc(name)}, ${items.length} item${
          items.length === 1 ? '' : 's'
        } at <strong>${esc(businessName)}</strong> ${
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
      type: 'low-stock',
      to,
      subject: `Low stock: ${items.length} item${items.length === 1 ? '' : 's'} need restocking`,
      html,
    });
  }

  /**
   * A platform admin created this account. No code in it: the owner sets a
   * password through the normal "Forgot password" flow, so the invite never
   * expires the way a 15-minute code would.
   */
  sendAccountInvite(to: string, name: string, businessName: string) {
    return this.send({
      type: 'invite',
      to,
      subject: `Your ${businessName} account is ready`,
      html: `
      <div style="font-family:system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#0f172a">
        <h2 style="margin:0 0 16px">Welcome to Inventory Manager</h2>
        <p style="margin:0 0 8px">Hi ${esc(name)},</p>
        <p style="margin:0 0 16px;color:#475569">An account has been created for <strong>${esc(businessName)}</strong> with this email address.</p>
        <p style="margin:0 0 16px;color:#475569">To choose your password, open the sign-in page, click <strong>Forgot password</strong> and enter this email. You'll get a code to set it.</p>
      </div>`,
    });
  }

  /** Subscription ending soon (daysLeft > 0) or already ended (daysLeft <= 0). */
  sendSubscriptionReminder(
    to: string,
    name: string,
    businessName: string,
    endsOn: Date,
    daysLeft: number,
  ) {
    const date = endsOn.toISOString().slice(0, 10);
    const stopsOn = accessEndsAt(endsOn).toISOString().slice(0, 10);
    const { email, phone } = supportContact();
    const contact = [email, phone].filter(Boolean).map((c) => esc(c!)).join(' · ');
    const when =
      daysLeft > 0
        ? `ends in ${daysLeft} day${daysLeft === 1 ? '' : 's'}, on ${date}`
        : `ended on ${date}`;
    return this.send({
      type: 'subscription-reminder',
      to,
      subject:
        daysLeft > 0
          ? `Your subscription ends in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`
          : 'Your subscription has ended',
      html: `
      <div style="font-family:system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#0f172a">
        <h2 style="margin:0 0 16px">Subscription reminder</h2>
        <p style="margin:0 0 8px">Hi ${esc(name)},</p>
        <p style="margin:0 0 16px;color:#475569">The subscription for <strong>${esc(businessName)}</strong> ${when}.</p>
        <p style="margin:0;color:#475569">${
          daysLeft > 0
            ? 'Renew before then to keep using the app without interruption.'
            : `The app keeps working until ${stopsOn}. Renew before then, or your team won't be able to sign in.`
        }</p>
        <p style="margin:16px 0 0;color:#475569">${
          contact ? `To renew, contact us: <strong>${contact}</strong>` : 'Contact us to renew.'
        }</p>
      </div>`,
    });
  }

  /** An admin answered a support ticket: tell whoever raised it. */
  sendSupportReply(to: string, name: string, subject: string, reply: string, businessId: string) {
    return this.send({
      type: 'support-reply',
      to,
      businessId,
      subject: `Re: ${subject}`,
      html: `
      <div style="font-family:system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#0f172a">
        <h2 style="margin:0 0 16px">We've replied to your question</h2>
        <p style="margin:0 0 8px">Hi ${esc(name)},</p>
        <p style="margin:0 0 8px;color:#475569">About <strong>${esc(subject)}</strong>:</p>
        <p style="margin:0 0 16px;color:#0f172a;white-space:pre-line;border-left:3px solid #e2e8f0;padding-left:12px">${esc(reply)}</p>
        <p style="margin:0;color:#94a3b8;font-size:12px">To answer, open Help &amp; support in the app.</p>
      </div>`,
    });
  }

  /** A shop raised a ticket: tell the support inbox (SUPPORT_EMAIL). */
  sendSupportNew(to: string, businessName: string, from: string, subject: string, body: string) {
    return this.send({
      type: 'support-new',
      to,
      subject: `Support: ${subject}`,
      html: `
      <div style="font-family:system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#0f172a">
        <h2 style="margin:0 0 16px">${esc(subject)}</h2>
        <p style="margin:0 0 16px;color:#475569">From ${esc(from)} at <strong>${esc(businessName)}</strong></p>
        <p style="margin:0 0 16px;white-space:pre-line">${esc(body)}</p>
        <p style="margin:0;color:#94a3b8;font-size:12px">Answer it from the admin panel's Support page.</p>
      </div>`,
    });
  }

  /** A platform announcement, emailed to a shop's owners alongside the bell. */
  sendAnnouncement(to: string, name: string, businessName: string, title: string, body: string) {
    return this.send({
      type: 'announcement',
      to,
      subject: title,
      html: `
      <div style="font-family:system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#0f172a">
        <h2 style="margin:0 0 16px">${esc(title)}</h2>
        <p style="margin:0 0 8px">Hi ${esc(name)},</p>
        <p style="margin:0 0 16px;color:#475569;white-space:pre-line">${esc(body)}</p>
        <p style="margin:0;color:#94a3b8;font-size:12px">Sent to the owners of ${esc(businessName)}.</p>
      </div>`,
    });
  }

  sendPasswordReset(to: string, name: string, code: string) {
    return this.send({
      type: 'password-reset',
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
        <p style="margin:0 0 8px">Hi ${esc(name)},</p>
        <p style="margin:0 0 16px;color:#475569">${intro}</p>
        <div style="font-size:32px;font-weight:700;letter-spacing:8px;background:#f1f5f9;border-radius:8px;padding:16px;text-align:center">${code}</div>
        <p style="margin:16px 0 0;color:#94a3b8;font-size:13px">This code expires in 15 minutes.</p>
      </div>`;
  }
}
