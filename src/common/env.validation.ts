/**
 * Boot-time environment validation.
 *
 * Wired into ConfigModule.forRoot({ validate }), so a misconfigured deploy
 * dies on startup with every problem listed at once, rather than coming up
 * healthy and behaving insecurely. That matters most for JWT_SECRET: it used
 * to fall back to the literal 'dev-secret', so a missing env var in
 * production silently made every token in the system forgeable by anyone who
 * can read this repo.
 */

import { createHmac } from 'crypto';

const MIN_SECRET_LENGTH = 32;

/**
 * The key platform (super-admin) tokens are signed and verified with.
 *
 * Kept apart from JWT_SECRET so the two kinds of token can never verify under
 * each other's strategy -- today only the `scope: 'platform'` claim check and
 * the id living in a different table stand between them, and a key that
 * differs makes that a cryptographic property rather than a code-path one.
 *
 * PLATFORM_JWT_SECRET is used when set. Otherwise the key is derived from
 * JWT_SECRET with HMAC, which already separates the two without a new env var
 * to forget on deploy; set PLATFORM_JWT_SECRET to also keep admin tokens safe
 * if JWT_SECRET alone ever leaks. Either way, changing it signs every platform
 * admin out once.
 */
export function platformJwtSecret(get: (key: string) => string | undefined) {
  const explicit = get('PLATFORM_JWT_SECRET')?.trim();
  if (explicit) return explicit;
  const base = get('JWT_SECRET')?.trim();
  if (!base) throw new Error('JWT_SECRET is required');
  return createHmac('sha256', base).update('platform-jwt').digest('hex');
}

/** Secrets that ship in the repo/docs and must never reach production. */
const KNOWN_PLACEHOLDERS = [
  'dev-secret',
  'change-me-to-a-long-random-string',
  'secret',
  'changeme',
];

export function validateEnv(config: Record<string, unknown>) {
  const isProd = config.NODE_ENV === 'production';
  const errors: string[] = [];
  const get = (key: string) => {
    const v = config[key];
    return typeof v === 'string' ? v.trim() : '';
  };

  if (!get('DATABASE_URL')) {
    errors.push('DATABASE_URL is required.');
  }

  const secret = get('JWT_SECRET');
  if (!secret) {
    errors.push(
      'JWT_SECRET is required. Generate one with: openssl rand -base64 48',
    );
  } else if (KNOWN_PLACEHOLDERS.includes(secret.toLowerCase())) {
    errors.push(
      'JWT_SECRET is still set to a placeholder value from .env.example. ' +
        'Generate a real one with: openssl rand -base64 48',
    );
  } else if (secret.length < MIN_SECRET_LENGTH) {
    errors.push(
      `JWT_SECRET must be at least ${MIN_SECRET_LENGTH} characters (got ${secret.length}). ` +
        'Generate one with: openssl rand -base64 48',
    );
  }

  // Optional (see platformJwtSecret), but held to the same bar when given,
  // and it must actually differ from JWT_SECRET or it separates nothing.
  const platformSecret = get('PLATFORM_JWT_SECRET');
  if (platformSecret) {
    if (KNOWN_PLACEHOLDERS.includes(platformSecret.toLowerCase())) {
      errors.push(
        'PLATFORM_JWT_SECRET is set to a placeholder value. ' +
          'Generate a real one with: openssl rand -base64 48',
      );
    } else if (platformSecret.length < MIN_SECRET_LENGTH) {
      errors.push(
        `PLATFORM_JWT_SECRET must be at least ${MIN_SECRET_LENGTH} characters (got ${platformSecret.length}).`,
      );
    } else if (platformSecret === secret) {
      errors.push(
        'PLATFORM_JWT_SECRET must differ from JWT_SECRET — the point of it is ' +
          'that the two kinds of token cannot verify under each other.',
      );
    }
  }

  // In dev, CORS reflects whatever origin asks, which is what makes a
  // phone/emulator on the LAN work without configuration. In production that
  // same fallback would let any site on the internet call the API with
  // credentials, so there it has to be stated explicitly.
  if (isProd && !get('CORS_ORIGIN')) {
    errors.push(
      'CORS_ORIGIN is required when NODE_ENV=production — set a comma-separated ' +
        'allowlist of the origins the web app is served from.',
    );
  }

  // MAIL_TRANSPORT=log sends nothing. In production that silently breaks
  // email verification and password resets, and the failure is invisible:
  // both endpoints deliberately report success either way so they can't be
  // used to enumerate accounts. Nobody would notice until users complained.
  const transport = get('MAIL_TRANSPORT').toLowerCase();
  if (transport && !['resend', 'log'].includes(transport)) {
    errors.push(`MAIL_TRANSPORT must be "resend" or "log" (got "${transport}").`);
  }
  if (isProd && transport === 'log') {
    errors.push(
      'MAIL_TRANSPORT=log discards all email and cannot be used in production — ' +
        'verification codes and password resets would never be delivered.',
    );
  }

  // These two reach the throttler through Number(). A value that isn't a
  // positive integer becomes NaN there, and a NaN limit disables rate
  // limiting altogether -- silently, since nothing else reads them. Catch a
  // typo'd THROTTLE_LIMIT here rather than discovering it as an open door.
  for (const key of ['THROTTLE_TTL', 'THROTTLE_LIMIT']) {
    const raw = get(key);
    if (raw && !/^[1-9]\d*$/.test(raw)) {
      errors.push(`${key} must be a positive integer (got "${raw}").`);
    }
  }

  if (errors.length) {
    throw new Error(
      `Invalid environment configuration:\n  - ${errors.join('\n  - ')}`,
    );
  }
  return config;
}
