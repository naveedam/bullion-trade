import { NextRequest, NextResponse } from "next/server";
import { buildAuthClientForHealthCheck } from "../../../../lib/kotak/wiring";

/**
 * Scheduled every 3-5 minutes while MCX is open (via your platform's cron
 * scheduler) to keep the Kotak Neo session warm and catch an unexpectedly
 * invalidated session — e.g. someone logging into the same trading account
 * from another terminal, which most brokers treat as a single-session
 * take-over — before a real hedge order depends on it.
 *
 * On an unhealthy result the cached session is already cleared by
 * `healthCheckPing()` itself (see neoAuth.ts), so the next order-placement
 * call will simply trigger a fresh login rather than needing this route to
 * do anything further. This route's job is purely early detection +
 * alerting, not recovery — recovery is automatic on next use.
 */
export async function POST(req: NextRequest) {
  const cronSecret = req.headers.get("x-cron-secret");
  if (cronSecret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const authClient = buildAuthClientForHealthCheck();
  const result = await authClient.healthCheckPing();

  if (!result.healthy) {
    // eslint-disable-next-line no-console
    console.error("[cron:session-health-check] Kotak Neo session unhealthy", result.detail);
    // await notifyTreasury(`Kotak Neo session health check failed: ${result.detail}`);
  }

  return NextResponse.json(result, { status: result.healthy ? 200 : 502 });
}
