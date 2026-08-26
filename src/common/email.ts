/**
 * Emails are matched/stored case-insensitively (and trimmed) everywhere --
 * without this, "Jane@x.com" and "jane@x.com" register as two different
 * accounts, and a user who signs up with mixed case can get "invalid
 * credentials" typing their own email normally.
 */
export const normalizeEmail = (email: string) => email.trim().toLowerCase();
