import { Injectable } from '@nestjs/common';
import { AuthUser } from './types/auth-user';

/**
 * Short-lived cache of validated principals, so a burst of authenticated
 * requests doesn't re-join User and Business on every one.
 *
 * Shared (rather than living inside JwtStrategy) so AuthService can evict a
 * user the moment their password changes. Without that eviction the cache
 * actively inverts the security property it sits in front of: the entry still
 * holds the OLD tokenVersion, so the just-retired token matches it and is
 * served from cache, while the freshly-minted token does not and is rejected.
 *
 * Single-instance revocation is therefore immediate. On a multi-instance
 * deploy the other instances still carry their own entry for up to the TTL,
 * so a retired token can survive that long over there -- acceptable next to
 * the seven days it used to survive, but worth knowing before scaling out.
 */
@Injectable()
export class PrincipalCache {
  private readonly ttlMs = 10_000;
  private readonly entries = new Map<
    string,
    { expiresAt: number; user: AuthUser; tokenVersion: number }
  >();

  get(userId: string) {
    const entry = this.entries.get(userId);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(userId);
      return null;
    }
    return entry;
  }

  set(userId: string, user: AuthUser, tokenVersion: number) {
    this.entries.set(userId, {
      expiresAt: Date.now() + this.ttlMs,
      user,
      tokenVersion,
    });
    // Entries are tiny, but the map would otherwise grow with every user that
    // ever signs in, so sweep what has aged out once it gets large.
    if (this.entries.size > 5_000) {
      const now = Date.now();
      for (const [key, e] of this.entries) {
        if (e.expiresAt <= now) this.entries.delete(key);
      }
    }
  }

  /** Drop a user's entry — called whenever their sessions are invalidated. */
  evict(userId: string) {
    this.entries.delete(userId);
  }
}
