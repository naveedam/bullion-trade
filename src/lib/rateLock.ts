/**
 * 30-Second Rate-Lock & Lease Manager
 * ---------------------------------------------------------------------------
 * Distributed lock built on Redis. A jeweller acquires a lock on a quoted
 * price for a specific volume; the lock auto-expires via Redis TTL if not
 * committed to an order within the lease window, so an abandoned quote never
 * silently binds the platform to stale pricing ("no slippage leakage").
 *
 * Design notes:
 * - Each lock is keyed by `lock:rate:{quoteId}:{userId}` so one user can't
 *   accidentally block another user's attempt to lock the same tick.
 * - The lock VALUE is a random token (not the mere key's existence), so
 *   commitLock can safely verify ownership before consuming it — this closes
 *   the classic "lock expires between check and use" race via a Lua script
 *   that does the get+delete atomically.
 * - On commit, we also write an audit row (RateLockAudit) via the injected
 *   `persistAudit` callback so expired-and-abandoned locks are still visible
 *   for analytics even though Redis itself will have evicted them.
 */

import { randomUUID } from "crypto";
import type Redis from "ioredis";
import Decimal from "decimal.js";
import type { RateLockRequest, RateLockResult } from "../types";

export const LOCK_TTL_MS = 30_000;

// Atomic compare-and-delete: only remove the key if the token still matches
// what we handed out, preventing us from deleting a lock some other request
// has since (re)acquired after expiry.
const RELEASE_IF_OWNER_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end
`;

export interface PersistedLockRecord {
  lockToken: string;
  quoteId: string;
  userId: string;
  volumeGrams: Decimal;
  ratePerGram: Decimal;
  acquiredAt: Date;
  expiresAt: Date;
}

export interface RateLockManagerDeps {
  redis: Redis;
  /** Look up the currently live ask price for this quoteId (from the tick cache). */
  getQuotedRatePerGram: (quoteId: string, metal: string) => Promise<Decimal>;
  /** Persist an audit row when a lock is acquired — called fire-and-forget. */
  persistAudit: (record: PersistedLockRecord) => Promise<void>;
}

export class RateLockError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "QUOTE_EXPIRED"
      | "ALREADY_LOCKED"
      | "LOCK_NOT_FOUND"
      | "LOCK_EXPIRED_OR_STOLEN"
  ) {
    super(message);
    this.name = "RateLockError";
  }
}

export class RateLockManager {
  constructor(private readonly deps: RateLockManagerDeps) {}

  private lockKey(quoteId: string, userId: string): string {
    return `lock:rate:${quoteId}:${userId}`;
  }

  /**
   * Acquire a 30-second lease on the current quoted rate for `volumeGrams`.
   * Fails fast with ALREADY_LOCKED if this user already holds a live lock
   * on the same quoteId (prevents double-submission from a flaky client).
   */
  async acquireLock(req: RateLockRequest): Promise<RateLockResult> {
    const ratePerGram = await this.deps.getQuotedRatePerGram(
      req.quoteId,
      req.metal
    );
    if (!ratePerGram || ratePerGram.lessThanOrEqualTo(0)) {
      throw new RateLockError(
        `No live quote for quoteId=${req.quoteId}`,
        "QUOTE_EXPIRED"
      );
    }

    const key = this.lockKey(req.quoteId, req.userId);
    const token = randomUUID();

    // NX = only set if not already present; PX = TTL in ms.
    const setResult = await this.deps.redis.set(
      key,
      token,
      "PX",
      LOCK_TTL_MS,
      "NX"
    );

    if (setResult !== "OK") {
      throw new RateLockError(
        `An active lock already exists for quoteId=${req.quoteId}`,
        "ALREADY_LOCKED"
      );
    }

    const acquiredAt = new Date();
    const expiresAt = new Date(acquiredAt.getTime() + LOCK_TTL_MS);

    // Fire-and-forget audit write — must never block or fail the lock path.
    void this.deps
      .persistAudit({
        lockToken: token,
        quoteId: req.quoteId,
        userId: req.userId,
        volumeGrams: req.volumeGrams,
        ratePerGram,
        acquiredAt,
        expiresAt,
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error("[rateLock] audit persist failed (non-fatal)", err);
      });

    return {
      lockToken: token,
      quoteId: req.quoteId,
      ratePerGram,
      volumeGrams: req.volumeGrams,
      acquiredAt,
      expiresAt,
      ttlMs: LOCK_TTL_MS,
    };
  }

  /**
   * Commit a held lock into a confirmed order. Atomically verifies the
   * caller still owns the lock (i.e. it hasn't expired or been stolen by a
   * retry) and deletes it in the same round trip so it can never be
   * double-committed.
   *
   * Returns true if the commit succeeded; throws LOCK_EXPIRED_OR_STOLEN if
   * the lease had already lapsed — the caller (order service) must then
   * refresh the quote and ask the user to re-lock, never silently reuse a
   * stale rate.
   */
  async commitLock(
    quoteId: string,
    userId: string,
    lockToken: string
  ): Promise<boolean> {
    const key = this.lockKey(quoteId, userId);
    const result = (await this.deps.redis.eval(
      RELEASE_IF_OWNER_SCRIPT,
      1,
      key,
      lockToken
    )) as number;

    if (result !== 1) {
      throw new RateLockError(
        `Lock for quoteId=${quoteId} has expired or was not held by this token`,
        "LOCK_EXPIRED_OR_STOLEN"
      );
    }
    return true;
  }

  /** Explicit early release — e.g. user cancels the ticket before confirming. */
  async releaseLock(
    quoteId: string,
    userId: string,
    lockToken: string
  ): Promise<void> {
    const key = this.lockKey(quoteId, userId);
    await this.deps.redis.eval(RELEASE_IF_OWNER_SCRIPT, 1, key, lockToken);
  }

  /** Remaining TTL in ms, or null if the lock no longer exists (expired/committed). */
  async getRemainingTtlMs(
    quoteId: string,
    userId: string
  ): Promise<number | null> {
    const key = this.lockKey(quoteId, userId);
    const ttl = await this.deps.redis.pttl(key);
    return ttl > 0 ? ttl : null;
  }
}
