import { BadGatewayException, BadRequestException, Injectable, Logger } from '@nestjs/common';
import { KeyObject, createHmac, createPrivateKey, createSign, randomBytes } from 'crypto';
import { readFileSync } from 'fs';

export type GatewayId = 'ESEWA' | 'KHALTI' | 'CONNECTIPS';

/** What the gateway says about one payment. Only `paid` ever records money. */
export type GatewayState =
  | { state: 'paid'; transactionId: string; amount: number }
  // `unsure`: the gateway can't say either way (eSewa's AMBIGUOUS, a status
  // we don't know, or keys since removed) -- the money may have been taken.
  | { state: 'pending'; unsure?: boolean }
  | { state: 'failed'; reason: string }
  // The gateway has no such payment -- yet, or ever (the owner closed the page).
  | { state: 'unknown' };

const ESEWA = {
  test: { form: 'https://rc-epay.esewa.com.np/api/epay/main/v2/form', status: 'https://rc.esewa.com.np/api/epay/transaction/status/' },
  live: { form: 'https://epay.esewa.com.np/api/epay/main/v2/form', status: 'https://epay.esewa.com.np/api/epay/transaction/status/' },
};
const KHALTI = {
  test: 'https://dev.khalti.com/api/v2/epayment/',
  live: 'https://khalti.com/api/v2/epayment/',
};
const CONNECTIPS = {
  test: {
    form: 'https://uat.connectips.com/connectipswebgw/loginpage',
    validate: 'https://uat.connectips.com/connectipswebws/api/creditor/validatetxn',
  },
  live: {
    form: 'https://login.connectips.com/connectipswebgw/loginpage',
    validate: 'https://login.connectips.com/connectipswebws/api/creditor/validatetxn',
  },
};
const TIMEOUT_MS = 15_000;

/** eSewa's signature: base64 HMAC-SHA256 of "k=v,k=v" over the signed fields, in order. */
export function esewaSignature(secret: string, fields: Record<string, string>, names: string[]): string {
  const message = names.map((n) => `${n}=${fields[n]}`).join(',');
  return createHmac('sha256', secret).update(message).digest('base64');
}

/** connectIPS's TOKEN: base64 RSA-SHA256 of its "K=v,K=v" string, with the merchant's key. */
export function connectIpsToken(key: KeyObject | string, message: string): string {
  return createSign('RSA-SHA256').update(message).sign(key, 'base64');
}

/** connectIPS takes a TXNID of 20 characters at most: SUB and 17 random ones. */
export function connectIpsRef(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return 'SUB' + [...randomBytes(17)].map((b) => alphabet[b % alphabet.length]).join('');
}

/** dd-MM-yyyy in Nepal, as connectIPS wants TXNDATE. */
const nepalDate = (d: Date) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kathmandu', day: '2-digit', month: '2-digit', year: 'numeric' })
    .format(d)
    .replace(/\//g, '-');

/** A field of a gateway's JSON as text; anything that isn't a string or number is blank. */
const str = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');

/** "1500" not "1500.00": eSewa signs the amount as the text it is sent. */
const amountText = (n: number) => String(Math.round(n * 100) / 100);

/**
 * eSewa (ePay v2), Khalti (KPG v2) and connectIPS (NCHL), configured from
 * the environment. A
 * gateway without its keys is simply not offered. Test mode talks to each
 * one's sandbox, where no real money moves; it is the default outside
 * production.
 */
@Injectable()
export class PaymentGateways {
  private readonly logger = new Logger(PaymentGateways.name);

  private keyCache: { source: string; key: KeyObject | null } | null = null;

  private mode(name: 'ESEWA_MODE' | 'KHALTI_MODE' | 'CONNECTIPS_MODE'): 'test' | 'live' {
    const v = process.env[name]?.trim().toLowerCase();
    if (v === 'live' || v === 'test') return v;
    return process.env.NODE_ENV === 'production' ? 'live' : 'test';
  }

  private esewa() {
    const code = process.env.ESEWA_MERCHANT_CODE?.trim();
    const secret = process.env.ESEWA_SECRET_KEY?.trim();
    if (!code || !secret) return null;
    const mode = this.mode('ESEWA_MODE');
    return { code, secret, mode, urls: ESEWA[mode] };
  }

  private khalti() {
    const secret = process.env.KHALTI_SECRET_KEY?.trim();
    if (!secret) return null;
    const mode = this.mode('KHALTI_MODE');
    return { secret, mode, base: KHALTI[mode] };
  }

  /**
   * connectIPS: the ids NCHL issues, the app password for its API, and the
   * private key from the .pfx it issues (as PEM, inline or a file).
   */
  private connectIps() {
    const merchantId = process.env.CONNECTIPS_MERCHANT_ID?.trim();
    const appId = process.env.CONNECTIPS_APP_ID?.trim();
    const appName = process.env.CONNECTIPS_APP_NAME?.trim();
    const password = process.env.CONNECTIPS_APP_PASSWORD?.trim();
    if (!merchantId || !appId || !appName || !password) return null;
    const key = this.connectIpsKey();
    if (!key) return null;
    const mode = this.mode('CONNECTIPS_MODE');
    return { merchantId, appId, appName, password, key, mode, urls: CONNECTIPS[mode] };
  }

  private connectIpsKey(): KeyObject | null {
    const inline = process.env.CONNECTIPS_PRIVATE_KEY?.trim();
    const file = process.env.CONNECTIPS_PRIVATE_KEY_FILE?.trim();
    const source = inline ? `inline:${inline}` : file ? `file:${file}` : '';
    if (!source) return null;
    if (this.keyCache?.source === source) return this.keyCache.key;
    let key: KeyObject | null = null;
    try {
      // .env files often hold a PEM on one line, with \n for the line breaks.
      key = createPrivateKey(inline ? inline.replace(/\\n/g, '\n') : readFileSync(file!, 'utf8'));
    } catch (e) {
      this.logger.error(`connectIPS private key unreadable, so connectIPS is off: ${(e as Error).message}`);
    }
    this.keyCache = { source, key };
    return key;
  }

  /** The gateways set up on this server, for the shop app and the admin panel. */
  available(): { id: GatewayId; label: string; test: boolean }[] {
    const out: { id: GatewayId; label: string; test: boolean }[] = [];
    const e = this.esewa();
    if (e) out.push({ id: 'ESEWA', label: 'eSewa', test: e.mode === 'test' });
    const k = this.khalti();
    if (k) out.push({ id: 'KHALTI', label: 'Khalti', test: k.mode === 'test' });
    const c = this.connectIps();
    if (c) out.push({ id: 'CONNECTIPS', label: 'connectIPS', test: c.mode === 'test' });
    return out;
  }

  isAvailable(id: GatewayId) {
    return this.available().some((g) => g.id === id);
  }

  /**
   * The form the browser posts to eSewa. Our payment id is the
   * transaction_uuid, so the status check can find it again.
   */
  esewaForm(p: { id: string; amount: number; successUrl: string; failureUrl: string }) {
    const e = this.esewa();
    if (!e) throw new BadRequestException('eSewa is not set up');
    const total = amountText(p.amount);
    const fields: Record<string, string> = {
      amount: total,
      tax_amount: '0',
      total_amount: total,
      transaction_uuid: p.id,
      product_code: e.code,
      product_service_charge: '0',
      product_delivery_charge: '0',
      success_url: p.successUrl,
      failure_url: p.failureUrl,
      signed_field_names: 'total_amount,transaction_uuid,product_code',
    };
    fields.signature = esewaSignature(e.secret, fields, fields.signed_field_names.split(','));
    return { action: e.urls.form, fields };
  }

  /** eSewa's status API: the only thing that marks an eSewa payment paid. */
  async esewaStatus(id: string, amount: number): Promise<GatewayState> {
    const e = this.esewa();
    if (!e) return { state: 'pending', unsure: true };
    const url = `${e.urls.status}?${new URLSearchParams({ product_code: e.code, total_amount: amountText(amount), transaction_uuid: id })}`;
    const body = await this.fetchJson('eSewa', url, { method: 'GET' });
    const status = str(body.status);
    switch (status) {
      case 'COMPLETE':
        return { state: 'paid', transactionId: str(body.ref_id), amount: Number(body.total_amount) };
      case 'PENDING':
        return { state: 'pending' };
      case 'AMBIGUOUS':
        return { state: 'pending', unsure: true };
      case 'NOT_FOUND':
        return { state: 'unknown' };
      case 'CANCELED':
        return { state: 'failed', reason: 'Cancelled on eSewa' };
      case 'FULL_REFUND':
      case 'PARTIAL_REFUND':
        return { state: 'failed', reason: 'Refunded by eSewa' };
      default:
        this.logger.warn(`eSewa status for ${id}: unexpected ${JSON.stringify(body).slice(0, 200)}`);
        return { state: 'pending', unsure: true };
    }
  }

  /**
   * The form the browser posts to connectIPS. It sends the owner back to the
   * success or failure URL registered with NCHL, adding ?TXNID=.
   */
  connectIpsForm(p: { ref: string; amount: number; remarks: string; particulars: string }, now = new Date()) {
    const c = this.connectIps();
    if (!c) throw new BadRequestException('connectIPS is not set up');
    // Commas would split the signed string; connectIPS limits both lengths.
    const clean = (t: string, max: number) => t.replace(/[,=]/g, ' ').slice(0, max);
    const fields: Record<string, string> = {
      MERCHANTID: c.merchantId,
      APPID: c.appId,
      APPNAME: c.appName,
      TXNID: p.ref,
      TXNDATE: nepalDate(now),
      TXNCRNCY: 'NPR',
      TXNAMT: String(Math.round(p.amount * 100)), // paisa
      REFERENCEID: p.ref,
      REMARKS: clean(p.remarks, 50),
      PARTICULARS: clean(p.particulars, 100),
    };
    const message = Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(',') + ',TOKEN=TOKEN';
    fields.TOKEN = connectIpsToken(c.key, message);
    return { action: c.urls.form, fields };
  }

  /** connectIPS's validation API: the only thing that marks a connectIPS payment paid. */
  async connectIpsStatus(ref: string, amount: number): Promise<GatewayState> {
    const c = this.connectIps();
    if (!c) return { state: 'pending', unsure: true };
    const paisa = String(Math.round(amount * 100));
    const token = connectIpsToken(c.key, `MERCHANTID=${c.merchantId},APPID=${c.appId},REFERENCEID=${ref},TXNAMT=${paisa}`);
    const body = await this.fetchJson('connectIPS', c.urls.validate, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${c.appId}:${c.password}`).toString('base64')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        merchantId: /^\d+$/.test(c.merchantId) ? Number(c.merchantId) : c.merchantId,
        appId: c.appId,
        referenceId: ref,
        txnAmt: paisa,
        token,
      }),
    });
    switch (str(body.status).toUpperCase()) {
      case 'SUCCESS':
        return { state: 'paid', transactionId: ref, amount: Number(str(body.txnAmt) || paisa) / 100 };
      case 'FAILED':
        return { state: 'failed', reason: str(body.statusDesc) || 'The connectIPS payment failed' };
      case 'ERROR':
        // No such transaction (yet): the owner never finished, or it's still going through.
        return { state: 'unknown' };
      default:
        this.logger.warn(`connectIPS status for ${ref}: unexpected ${JSON.stringify(body).slice(0, 200)}`);
        return { state: 'pending', unsure: true };
    }
  }

  /** Start a Khalti payment; the browser is sent to the returned url. */
  async khaltiStart(p: {
    id: string;
    amount: number;
    returnUrl: string;
    websiteUrl: string;
    name: string;
    customer?: { name: string; email: string };
  }): Promise<{ pidx: string; url: string }> {
    const k = this.khalti();
    if (!k) throw new BadRequestException('Khalti is not set up');
    const body = await this.fetchJson('Khalti', k.base + 'initiate/', {
      method: 'POST',
      headers: { Authorization: `Key ${k.secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        return_url: p.returnUrl,
        website_url: p.websiteUrl,
        amount: Math.round(p.amount * 100), // paisa
        purchase_order_id: p.id,
        purchase_order_name: p.name,
        ...(p.customer ? { customer_info: p.customer } : {}),
      }),
    });
    if (typeof body.pidx !== 'string' || typeof body.payment_url !== 'string') {
      throw new BadGatewayException('Khalti did not start the payment. Try again, or pay another way.');
    }
    return { pidx: body.pidx, url: body.payment_url };
  }

  /** Khalti's lookup API: the only thing that marks a Khalti payment paid. */
  async khaltiLookup(pidx: string): Promise<GatewayState> {
    const k = this.khalti();
    if (!k) return { state: 'pending', unsure: true };
    let body: Record<string, unknown>;
    try {
      body = await this.fetchJson('Khalti', k.base + 'lookup/', {
        method: 'POST',
        headers: { Authorization: `Key ${k.secret}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ pidx }),
      });
    } catch (e) {
      // Khalti answers 404 for a pidx it has dropped.
      if (e instanceof GatewayHttpError && e.gatewayStatus === 404) return { state: 'unknown' };
      throw e;
    }
    switch (str(body.status)) {
      case 'Completed':
        return { state: 'paid', transactionId: str(body.transaction_id), amount: Number(body.total_amount) / 100 };
      case 'Pending':
      case 'Initiated':
        return { state: 'pending' };
      case 'User canceled':
        return { state: 'failed', reason: 'Cancelled on Khalti' };
      case 'Expired':
        return { state: 'failed', reason: 'The Khalti payment expired' };
      case 'Refunded':
      case 'Partially Refunded':
        return { state: 'failed', reason: 'Refunded by Khalti' };
      default:
        this.logger.warn(`Khalti lookup for ${pidx}: unexpected ${JSON.stringify(body).slice(0, 200)}`);
        return { state: 'pending', unsure: true };
    }
  }

  private async fetchJson(name: string, url: string, init: RequestInit): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (e) {
      this.logger.warn(`${name} unreachable: ${(e as Error).message}`);
      throw new BadGatewayException(`Couldn't reach ${name}. Try again in a moment.`);
    }
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    if (!res.ok) {
      this.logger.warn(`${name} ${res.status}: ${text.slice(0, 300)}`);
      throw new GatewayHttpError(name, res.status, gatewayMessage(body));
    }
    if (!body || typeof body !== 'object') {
      throw new BadGatewayException(`${name} sent an unexpected answer. Try again in a moment.`);
    }
    return body as Record<string, unknown>;
  }
}

/** A gateway's 4xx/5xx, shown to the owner as a 502 with its own words. */
export class GatewayHttpError extends BadGatewayException {
  constructor(
    name: string,
    readonly gatewayStatus: number,
    detail: string | null,
  ) {
    super(detail ? `${name}: ${detail}` : `${name} refused the request. Try again, or pay another way.`);
  }
}

/** Khalti's errors look like { amount: ["..."] } or { detail: "..." }. */
function gatewayMessage(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    if (k === 'error_key' || k === 'status_code') continue;
    if (typeof v === 'string' && v && v.length < 200) return v;
    if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
  }
  return null;
}
