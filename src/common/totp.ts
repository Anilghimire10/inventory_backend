import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'crypto';

/**
 * Time-based one-time passwords (RFC 6238) for admin two-factor sign-in:
 * HMAC-SHA1, 30-second steps, 6 digits -- the defaults every authenticator app
 * (Google Authenticator, Authy, 1Password, ...) assumes when it scans a code.
 *
 * Built on node:crypto rather than a dependency: the algorithm is thirty lines,
 * and this is code that decides who gets into every shop's data.
 */

export const TOTP_STEP_SECONDS = 30;
const DIGITS = 6;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.replace(/[\s=-]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i === -1) throw new Error('Invalid base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new secret: 160 bits, the size RFC 4226 recommends for HMAC-SHA1. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** The code for one 30-second step. */
export function totpCode(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary = hmac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

export function totpStep(now = Date.now()): number {
  return Math.floor(now / 1000 / TOTP_STEP_SECONDS);
}

/**
 * Check a code, allowing one step either side for clock drift. Returns the
 * step it matched, so the caller can refuse to accept that step twice (a
 * code seen over someone's shoulder is spent once it has been used), or null.
 */
export function verifyTotp(secret: string, code: string, now = Date.now()): number | null {
  const given = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(given)) return null;
  const current = totpStep(now);
  for (const step of [current, current - 1, current + 1]) {
    const expected = totpCode(secret, step);
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(given))) return step;
  }
  return null;
}

/** What an authenticator app scans. */
export function otpauthUrl(account: string, secret: string, issuer = 'Inventory Admin'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// ---- Secrets at rest ----
//
// Encrypted with AES-256-GCM, so a copy of the database (a backup dump on a
// laptop, say) doesn't hand over everyone's second factor along with it. The
// key is TOTP_ENCRYPTION_KEY when set, otherwise derived from JWT_SECRET.
// Changing either makes existing secrets unreadable: those admins then can't
// sign in until another admin resets their two-factor.

function key(): Buffer {
  const explicit = process.env.TOTP_ENCRYPTION_KEY?.trim();
  if (explicit) return createHash('sha256').update(explicit).digest();
  const base = process.env.JWT_SECRET?.trim();
  if (!base) throw new Error('JWT_SECRET is required');
  return createHmac('sha256', base).update('admin-totp-secret').digest();
}

export function encryptTotpSecret(secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}

export function decryptTotpSecret(stored: string): string {
  const [version, iv, tag, data] = stored.split(':');
  if (version !== 'v1' || !iv || !tag || !data) throw new Error('Unrecognised TOTP secret format');
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}
