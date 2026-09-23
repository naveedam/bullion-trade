import { NextRequest, NextResponse } from "next/server";
import { getCurrentTick } from "../../../lib/tickService";
import { getRedis, RedisNotConfiguredError } from "../../../lib/redis";
import { MarketFeedError } from "../../../lib/marketFeed";

/**
 * GET /api/tick?metal=GOLD|SILVER
 * Polled by the trading terminal every ~1.5s. Cheap to call often: it's
 * reading a short-TTL Redis cache, not hitting the upstream feed on every
 * request — see tickService.ts / marketFeed.ts for the actual refresh
 * cadence and throttling.
 */
export async function GET(req: NextRequest) {
  const metalParam = (req.nextUrl.searchParams.get("metal") ?? "GOLD").toUpperCase();
  if (metalParam !== "GOLD" && metalParam !== "SILVER") {
    return NextResponse.json(
      { error: "metal must be GOLD or SILVER" },
      { status: 400 }
    );
  }

  try {
    const tick = await getCurrentTick(getRedis(), metalParam);
    return NextResponse.json(tick);
  } catch (err) {
    if (err instanceof RedisNotConfiguredError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    if (err instanceof MarketFeedError) {
      // Both the fresh fetch and the stale fallback came up empty — this
      // only happens on a truly cold start with the upstream feed also
      // down. Surface it plainly rather than fabricating a price.
      return NextResponse.json(
        { error: `No price available: ${err.message}` },
        { status: 503 }
      );
    }
    // eslint-disable-next-line no-console
    console.error("[api:tick] unexpected error", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
