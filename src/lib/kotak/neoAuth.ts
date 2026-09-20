/**
 * Kotak Neo Session & Token Management
 * ---------------------------------------------------------------------------
 * Rewritten against OptionPal Pro's verified, working implementation
 * (supabase/functions/kotak-neo-auth) rather than guessed at. Corrects two
 * assumptions the first draft of this file got wrong:
 *
 *   1. Login is NOT "mobile + password, then TOTP". It's UCC (client code)
 *      + TOTP in one call, then MPIN in a second call. There is no
 *      password step at all in this flow.
 *   2. Auth uses a DIFFERENT base URL (mis.kotaksecurities.com) than every
 *      other Kotak Neo call in this platform (gw-napi.kotaksecurities.com,
 *      used by instrumentResolver.ts and kotakNeoAdapter.ts). Don't merge
 *      these into one configurable base URL - they're genuinely different
 *      hosts.
 *
 * Real flow (verified):
 *   Step 1 - POST {MIS_BASE}/login/1.0/tradeApiLogin
 *            body: { mobileNumber, ucc, totp }
 *            headers: Authorization: <consumerKey> (raw, not Bearer/Basic),
 *                     neo-fin-key: "neotradeapi"
 *            -> { data: { token, sid } }  (a view token, not yet tradeable)
 *   Step 2 - POST {MIS_BASE}/login/1.0/tradeApiValidate
 *            body: { mpin }
 *            headers: Authorization: <consumerKey>, Auth: <viewToken>,
 *                     sid: <viewSid>, neo-fin-key: "neotradeapi"
 *            -> { data: { token, sid, baseUrl } }
 *            baseUrl here is the actual host to use for every subsequent
 *            trading/market-data call for this session - it is returned
 *            per-session, not a fixed constant. Falls back to
 *            gw-napi.kotaksecurities.com if the response omits it (that's
 *            what OptionPal Pro's own code does).
 *
 * IMPORTANT - TOTP is not currently automatable from what's been verified.
 * OptionPal Pro's login UI has the user type in a 6-digit TOTP code by
 * hand each session (see BrokerLoginDialog.tsx) - there's no evidence in
 * the working code of a registered static TOTP secret being used to
 * generate codes programmatically. That's fine for a personal tool opened
 * once a day; it's a real problem for this platform's hedge-execution
 * path, which needs to fire unattended the instant an order is funded.
 * Two ways forward, neither implemented here yet:
 *   (a) Check whether Kotak Neo's API-trading account setup offers a
 *       registerable static TOTP secret (some brokers do, separate from
 *       personal-login 2FA) - if so, generateTotp() can produce codes
 *       automatically the way the original draft of this file assumed.
 *   (b) Accept that session refresh needs a human in the loop
 *       periodically, and lean on the existing hedge-failure alerting
 *       (see hedging.ts's flagOrderHedgeFailure) to surface "session needs
 *       re-auth" promptly rather than silently missing hedges.
 * getValidSession() below throws when there's no cached, unexpired session
 * rather than attempting a fresh login on its own - until (a) or (b) is
 * settled, an automatic login attempt would either hang waiting on a TOTP
 * input that never comes, or fail in a way that's easy to miss.
 */

import type Redis from "ioredis";

const REDIS_KEY_TOKEN = "kotak:neo:session";
const MIS_BASE_URL = "https://mis.kotaksecurities.com";
const TOTP_LOGIN_PATH = "login/1.0/tradeApiLogin";
const TOTP_VALIDATE_PATH = "login/1.0/tradeApiValidate";
const FALLBACK_TRADING_BASE = "https://gw-napi.kotaksecurities.com";

const SESSION_TTL_SECONDS = 8 * 60 * 60;

export interface KotakNeoSession {
  accessToken: string;
  sid: string;
  consumerKey: string;
  tradingBaseUrl: string;
  cachedAt: string;
  expiresAt: string;
}

export interface KotakNeoAuthConfig {
  consumerKey: string;
  mobileNumber: string;
  ucc: string;
  mpin: string;
}

export class KotakAuthError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "KotakAuthError";
  }
}

export class KotakNeoAuthClient {
  constructor(
    private readonly config: KotakNeoAuthConfig,
    private readonly redis: Redis
  ) {}

  async getValidSession(): Promise<KotakNeoSession> {
    const cached = await this.readCachedSession();
    if (cached && new Date(cached.expiresAt) > new Date()) {
      return cached;
    }
    throw new KotakAuthError(
      "No valid Kotak Neo session cached. Call login(totp) with a fresh TOTP code - session refresh is not automatic (see neoAuth.ts file header for why)."
    );
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

  async login(totp: string): Promise<KotakNeoSession> {
    const { viewToken, viewSid } = await this.requestViewToken(totp);
    const { tradeToken, tradeSid, tradingBaseUrl } = await this.validateMpin(
      viewToken,
      viewSid
    );

    const session: KotakNeoSession = {
      accessToken: tradeToken,
      sid: tradeSid,
      consumerKey: this.config.consumerKey,
      tradingBaseUrl,
      cachedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString(),
    };

    await this.redis.set(
      REDIS_KEY_TOKEN,
      JSON.stringify(session),
      "EX",
      SESSION_TTL_SECONDS
    );

    return session;
  }

  private async requestViewToken(
    totp: string
  ): Promise<{ viewToken: string; viewSid: string }> {
    let response: Response;
    try {
      response = await fetch(`${MIS_BASE_URL}/${TOTP_LOGIN_PATH}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: this.config.consumerKey,
          "neo-fin-key": "neotradeapi",
        },
        body: JSON.stringify({
          mobileNumber: this.config.mobileNumber,
          ucc: this.config.ucc.toUpperCase(),
          totp,
        }),
      });
    } catch (err) {
      throw new KotakAuthError("Network error during TOTP login", err);
    }

    const body = (await response.json().catch(() => null)) as {
      data?: { token?: string; sid?: string };
      token?: string;
      sid?: string;
      stat?: string;
      emsg?: string;
    } | null;

    if (!response.ok || !body || body.stat === "Not_Ok") {
      throw new KotakAuthError(
        `TOTP login failed: ${body?.emsg ?? `HTTP ${response.status}`}`
      );
    }

    const viewToken = body.data?.token ?? body.token;
    const viewSid = body.data?.sid ?? body.sid;
    if (!viewToken) {
      throw new KotakAuthError("TOTP login response missing a view token");
    }

    return { viewToken, viewSid: viewSid ?? "" };
  }

  private async validateMpin(
    viewToken: string,
    viewSid: string
  ): Promise<{ tradeToken: string; tradeSid: string; tradingBaseUrl: string }> {
    let response: Response;
    try {
      response = await fetch(`${MIS_BASE_URL}/${TOTP_VALIDATE_PATH}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: this.config.consumerKey,
          Auth: viewToken,
          sid: viewSid,
          "neo-fin-key": "neotradeapi",
        },
        body: JSON.stringify({ mpin: this.config.mpin }),
      });
    } catch (err) {
      throw new KotakAuthError("Network error during MPIN validation", err);
    }

    const body = (await response.json().catch(() => null)) as {
      data?: { token?: string; sid?: string; baseUrl?: string };
      token?: string;
      sid?: string;
      baseUrl?: string;
      stat?: string;
      emsg?: string;
    } | null;

    if (!response.ok || !body || body.stat === "Not_Ok") {
      throw new KotakAuthError(
        `MPIN validation failed: ${body?.emsg ?? `HTTP ${response.status}`}`
      );
    }

    const tradeToken = body.data?.token ?? body.token ?? viewToken;
    const tradeSid = body.data?.sid ?? body.sid ?? viewSid;
    const tradingBaseUrl = body.data?.baseUrl ?? body.baseUrl ?? FALLBACK_TRADING_BASE;

    if (!tradeToken) {
      throw new KotakAuthError("MPIN validation response missing a trade token");
    }

    return { tradeToken, tradeSid, tradingBaseUrl };
  }

  async healthCheckPing(): Promise<{ healthy: boolean; detail?: string }> {
    let session: KotakNeoSession;
    try {
      session = await this.getValidSession();
    } catch (err) {
      return {
        healthy: false,
        detail: err instanceof Error ? err.message : "No cached session",
      };
    }

    try {
      const response = await fetch(
        `${session.tradingBaseUrl}/script-details/1.0/quotes/neosymbol/${encodeURIComponent(
          "nse_cm|26000"
        )}/ltp`,
        {
          headers: {
            Authorization: session.consumerKey,
            Auth: session.accessToken,
            sid: session.sid,
            "neo-fin-key": "neotradeapi",
            Accept: "application/json",
          },
        }
      );

      if (response.status === 401 || response.status === 403) {
        await this.redis.del(REDIS_KEY_TOKEN);
        return { healthy: false, detail: `Session rejected: HTTP ${response.status}` };
      }

      return {
        healthy: response.ok,
        detail: response.ok ? undefined : `HTTP ${response.status}`,
      };
    } catch (err) {
      return {
        healthy: false,
        detail: err instanceof Error ? err.message : "Unknown health-check error",
      };
    }
  }
}
