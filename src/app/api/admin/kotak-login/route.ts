import { NextRequest, NextResponse } from "next/server";
import { KotakAuthError } from "../../../../lib/kotak/neoAuth";
import { buildKotakPricingGraph } from "../../../../lib/kotak/wiring";

/**
 * POST /api/admin/kotak-login
 * body: { totp: "123456" }
 *
 * A human step, not automatable — see neoAuth.ts's file header for why.
 * OptionPal Pro's own working implementation has the account owner type in
 * a fresh 6-digit TOTP code each session; this route is the equivalent
 * entry point for this platform; a small internal page (or just curl/
 * Postman) calling it with today's code is enough until (or unless) Kotak
 * Neo's API-trading setup is confirmed to support a registerable static
 * TOTP secret for unattended login.
 *
 * Protected by a shared secret header, same pattern as the /api/cron/*
 * routes — this is not meant to be reachable by anyone but you.
 */
export async function POST(req: NextRequest) {
  const adminSecret = req.headers.get("x-admin-secret");
  if (adminSecret !== process.env.ADMIN_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const totp = typeof body.totp === "string" ? body.totp.trim() : "";

  if (!/^\d{6}$/.test(totp)) {
    return NextResponse.json(
      { error: "totp must be a 6-digit code" },
      { status: 400 }
    );
  }

  try {
    const { authClient } = buildKotakPricingGraph();
    const session = await authClient.login(totp);
    return NextResponse.json({
      success: true,
      tradingBaseUrl: session.tradingBaseUrl,
      expiresAt: session.expiresAt,
    });
  } catch (err) {
    if (err instanceof KotakAuthError) {
      return NextResponse.json({ error: err.message }, { status: 401 });
    }
    // eslint-disable-next-line no-console
    console.error("[admin:kotak-login] unexpected error", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
