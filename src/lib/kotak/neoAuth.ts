/**
 * Kotak Neo Session & Token Management
 * ---------------------------------------------------------------------------
 * Kotak Neo's Trade API uses a two-step login:
 *   1. Password grant — consumer key/secret (HTTP Basic) + mobile number +
 *      password, returns a short-lived "view token" that is only valid for
 *      completing 2FA, not for trading calls.
 *   2. 2FA validation — the view token plus a 6-digit TOTP code (generated
 *      from the secret provisioned when TOTP-based external 2FA was enabled
 *      on the trading account) exchanges for the actual bearer token and a
 *      session ID (`sid`) that gets sent alongside every trading call.
 *
 * NOTE: pinned to otplib v12's `authenticator` API rather than v13, whose
 * v13 release restructured TOTP generation to require explicit
 * crypto/base32 plugin wiring (NobleCryptoPlugin/ScureBase32Plugin) — v12
 * is deprecated but functionally stable, and getting the session-auth path
 * wrong is worse than a deprecation warning. Revisit once v13's plugin
 * wiring is confirmed against your Node runtime.
 *
 * IMPORTANT: the exact endpoint paths, header names and response field names
 * below follow the general shape of Kotak Neo's published API but must be
 * verified against your current API credentials' documentation bundle
 * before going live — brokers routinely version these endpoints, and a
 * mismatch here should fail loudly (which is why every response is narrowly
 * typed and unexpected shapes throw rather than silently returning
 * `undefined` deep in a call chain).
 *
 * The bearer token + sid are cached in Redis (not in-process memory) so
 * that multiple API/worker instances share one session instead of each
 * spawning its own login and potentially invalidating siblings' sessions —
 * most brokers only allow one active session per trading account.
 */

import { authenticator } from "otplib";
import type Redis from "ioredis";

const REDIS_KEY_TOKEN = "kotak:neo:session";
const REDIS_LOCK_KEY = "kotak:neo:login-lock";
const LOGIN_LOCK_TTL_MS = 15_000;

// Conservative default — Kotak Neo sessions are typically valid for the
// trading day; re-validate this against your account's session-timeout
// documentation. Caching for less than the true lifetime just means more
// (harmless) re-logins; caching for longer than the true lifetime means
// calls start failing with 401s that the health-check ping is meant to
// catch early.
const DEFAULT_SESSION_TTL_SECONDS = 8 * 60 * 60;

export interface KotakNeoSession {
  bearerToken: string;
  sid: string;
  consumerKey: string;
  cachedAt: string; // ISO
  expiresAt: string; // ISO
}

export interface KotakNeoAuthConfig {
  consumerKey: string;
  consumerSecret: string;
  mobileNumber: string; // registered trading account mobile, "+91XXXXXXXXXX"
  password: string;
  totpSecret: string; // base32 secret provisioned for TOTP-based 2FA
  baseUrl?: string; // e.g. "https://gw-napi.kotaksecurities.com"
}

export class KotakAuthError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "KotakAuthError";
  }
}

export class KotakNeoAuthClient {
  private readonly baseUrl: string;

  constructor(
    private readonly config: KotakNeoAuthConfig,
    private readonly redis: Redis
  ) {
    this.baseUrl = config.baseUrl ?? "https://gw-napi.kotaksecurities.com";
  }

  /** Generates the current 6-digit TOTP code from the provisioned secret. */
  generateTotp(): string {
    return authenticator.generate(this.config.totpSecret);
  }

  /**
   * Returns a valid cached session, performing a fresh login only if the
   * cache is empty or expired. Safe to call from every request path —
   * concurrent callers coordinate via a short Redis lock so a burst of
   * requests at session expiry triggers one login, not a thundering herd
   * against the broker's login endpoint (which commonly rate-limits or
   * invalidates prior sessions on repeated logins).
   */
  async getValidSession(): Promise<KotakNeoSession> {
    const cached = await this.readCachedSession();
    if (cached && new Date(cached.expiresAt) > new Date()) {
      return cached;
    }

    const gotLock = await this.redis.set(
      REDIS_LOCK_KEY,
      "1",
      "PX",
      LOGIN_LOCK_TTL_MS,
      "NX"
    );

    if (gotLock !== "OK") {
      // Someone else is logging in right now — wait briefly and re-read the
      // cache rather than racing them with a second login.
      await new Promise((r) => setTimeout(r, 1500));
      const retried = await this.readCachedSession();
      if (retried && new Date(retried.expiresAt) > new Date()) {
        return retried;
      }
      // Lock holder failed or is slow — fall through and attempt our own
      // login rather than blocking forever.
    }

    try {
      return await this.login();
    } finally {
      await this.redis.del(REDIS_LOCK_KEY);
    }
  }

  private async readCachedSession(): Promise<KotakNeoSession | null> {
    const raw = await this.redis.get(REDIS_KEY_TOKEN);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as KotakNeoSession;
    } catch {
      return null;
    }
  }

  /**
   * Full two-step login. Throws KotakAuthError on any failure — callers on
   * the hedge-execution critical path must treat an auth failure as a hard
   * stop (flag for treasury alert), never as "proceed unauthenticated".
   */
  async login(): Promise<KotakNeoSession> {
    const viewToken = await this.requestViewToken();
    const session = await this.validateTotp(viewToken);

    const record: KotakNeoSession = {
      bearerToken: session.bearerToken,
      sid: session.sid,
      consumerKey: this.config.consumerKey,
      cachedAt: new Date().toISOString(),
      expiresAt: new Date(
        Date.now() + DEFAULT_SESSION_TTL_SECONDS * 1000
      ).toISOString(),
    };

    await this.redis.set(
      REDIS_KEY_TOKEN,
      JSON.stringify(record),
      "EX",
      DEFAULT_SESSION_TTL_SECONDS
    );

    return record;
  }

  private async requestViewToken(): Promise<string> {
    const basicAuth = Buffer.from(
      `${this.config.consumerKey}:${this.config.consumerSecret}`
    ).toString("base64");

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/login/1.0/login/v2/validate`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${basicAuth}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          mobileNumber: this.config.mobileNumber,
          password: this.config.password,
        }),
      });
    } catch (err) {
      throw new KotakAuthError("Network error requesting view token", err);
    }

    if (!response.ok) {
      throw new KotakAuthError(
        `View-token request failed: HTTP ${response.status}`
      );
    }

    const body = (await response.json()) as { token?: string; data?: { token?: string } };
    const token = body.token ?? body.data?.token;
    if (!token) {
      throw new KotakAuthError(
        "View-token response missing 'token' field — verify API contract"
      );
    }
    return token;
  }

  private async validateTotp(
    viewToken: string
  ): Promise<{ bearerToken: string; sid: string }> {
    const totp = this.generateTotp();

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/login/1.0/login/v2/validate`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${viewToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ otp: totp }),
      });
    } catch (err) {
      throw new KotakAuthError("Network error validating TOTP", err);
    }

    if (!response.ok) {
      throw new KotakAuthError(`TOTP validation failed: HTTP ${response.status}`);
    }

    const body = (await response.json()) as {
      token?: string;
      sid?: string;
      data?: { token?: string; sid?: string };
    };
    const bearerToken = body.token ?? body.data?.token;
    const sid = body.sid ?? body.data?.sid;

    if (!bearerToken || !sid) {
      throw new KotakAuthError(
        "TOTP validation response missing token/sid — verify API contract"
      );
    }

    return { bearerToken, sid };
  }

  /**
   * Lightweight authenticated ping to keep the session warm during trading
   * hours and detect an unexpectedly invalidated session before a real
   * hedge order depends on it. Intended to be invoked by an external
   * scheduler (cron / queue worker) every few minutes while MCX is open —
   * this module does not run its own timer, since a `setInterval` has no
   * meaningful lifetime in a serverless/route-handler deployment.
   */
  async healthCheckPing(): Promise<{ healthy: boolean; detail?: string }> {
    try {
      const session = await this.getValidSession();
      const response = await fetch(`${this.baseUrl}/quick/user/limits`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${session.bearerToken}`,
          sid: session.sid,
          "Content-Type": "application/json",
        },
      });

      if (response.status === 401 || response.status === 403) {
        // Session was invalidated broker-side (e.g. logged in elsewhere) —
        // clear the cache so the next getValidSession() forces a fresh login
        // instead of retrying a token we now know is dead.
        await this.redis.del(REDIS_KEY_TOKEN);
        return { healthy: false, detail: `Session rejected: HTTP ${response.status}` };
      }

      return { healthy: response.ok, detail: response.ok ? undefined : `HTTP ${response.status}` };
    } catch (err) {
      return {
        healthy: false,
        detail: err instanceof Error ? err.message : "Unknown health-check error",
      };
    }
  }
}
