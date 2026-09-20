# Bullion Trading Platform — Core Scaffold

A B2B wholesale bullion (gold/silver) trading platform for the Indian market:
pre-funded virtual-account clearing, a 30-second rate-lock engine, and
automated delta-hedging against MCX gold futures.

## What's here

```
prisma/schema.prisma          Full data model: entities, virtual accounts,
                               orders (state machine), inventory bars,
                               hedging positions, logistics.

src/lib/pricing.ts             Dynamic spot → ask-price calculator.
                                Decimal-safe (decimal.js), GST (3%) and
                                Section 206C(1H) TCS handling.

src/lib/marketFeed.ts          Live spot (gold-api.com, free/no-key) and
                                USD/INR (open.er-api.com, free/no-key,
                                daily) with a Redis pull-through cache and
                                stale-fallback so a provider hiccup degrades
                                gracefully instead of 500ing the quote board.

src/lib/tickService.ts         Bridges marketFeed.ts to pricing.ts, caches
                                the resulting tick under both a
                                "current per metal" key (for /api/tick's
                                polling) and a "per quoteId" key kept
                                slightly longer than the lock window (for
                                the rate-lock endpoint to resolve exactly
                                what was quoted).

src/lib/rateLock.ts            Redis-backed 30-second distributed lock.
                                acquireLock() / commitLock() with atomic
                                compare-and-delete to prevent race conditions
                                on expiry.

src/lib/webhook.ts             Bank settlement webhook ingestion: HMAC
                                verification, replay protection, VAN +
                                amount reconciliation, order state advance.

src/lib/hedging.ts             Delta-hedging trigger. Broker-agnostic
                                interface (HedgeBroker) + a Kite Connect
                                adapter (secondary/fallback). Greedy
                                lot-decomposition across Gold Petal / Gold
                                Mini / Gold 1kg. Also holds the fill-poller
                                (pollAndReconcileHedgeFills) that reconciles
                                broker fills back onto HedgingPosition rows.

src/lib/kotak/                 Kotak Neo — the primary hedging broker.
  neoAuth.ts                     2-step login (password + TOTP via
                                  otplib), Redis-cached bearer/sid session,
                                  login-storm protection, health-check ping.
  instrumentResolver.ts          Downloads + parses the mcx_fo scrip
                                  master, resolves each HedgeContractType to
                                  its current active, non-tender near-month
                                  contract. Redis-cached, but never serves a
                                  cached contract past its own tender-start
                                  date even if the cache TTL hasn't lapsed.
  marketHours.ts                 getMcxMarketStatus() — IST session windows
                                  (morning/evening), weekend + injected
                                  holiday-calendar guard, next-open
                                  calculation for AMO scheduling.
  kotakNeoAdapter.ts              Production HedgeBroker implementation.
                                  Live MARKET/NRML orders when MCX is open;
                                  when it's closed, legs are queued into a
                                  Redis sorted set (not thrown/dropped) for
                                  placement at 09:00:05 IST via
                                  processDueScheduledHedges(). Also exposes
                                  pollFill() for terminal fill/avgPrice/
                                  charges retrieval.
  wiring.ts                       Single factory building the auth client +
                                  instrument resolver + adapter from env
                                  vars, shared by every route/worker below.

src/app/api/...                Next.js route handlers wiring the above.
                                Persistence calls are stubbed with explicit
                                throws — see "Wiring to Prisma" below.

src/app/api/cron/               Scheduled workers (wire to your platform's
                                cron: Vercel Cron, a queue, etc). All three
                                require an `X-Cron-Secret` header matching
                                `CRON_SECRET`.
  process-amo-queue/              Drains legs queued while MCX was closed;
                                   run at 09:00:05 IST + periodically as a
                                   safety net through the morning session.
  poll-hedge-fills/                Polls SUBMITTED/OPEN HedgingPosition rows
                                   for terminal status; run every 5-10s
                                   while any exist. Advances Order to HEDGED
                                   once every leg is filled, or to
                                   HEDGE_FAILED (treasury alert) on a
                                   rejected leg.
  session-health-check/            Keeps the Kotak Neo session warm and
                                   detects an invalidated session early;
                                   run every 3-5 minutes while MCX is open.

src/components/, src/app/trading/
                                The trading terminal UI: live tick board,
                                30-second countdown ring, volume tiers,
                                itemised breakdown, VAN payment panel.
```

## Design choices worth knowing about

- **Everything monetary is `Decimal`, never `number`, until it crosses into
  the UI layer.** Floating-point per-gram pricing compounds rounding error
  across thousands of quotes/day; `decimal.js` with explicit
  `ROUND_HALF_UP` avoids that class of reconciliation bug entirely.
- **The rate lock is a value-token lock, not a bare key.** `commitLock` does
  an atomic Lua GET+DEL so a lock that expired and was already reissued to
  someone else can never be redeemed by a late, stale request.
- **The webhook handler treats an invalid signature and an amount mismatch
  as *data*, not silent failures** — both get written to `Settlement` with
  a rejection status before the exception is thrown, so there's always an
  audit trail for what a bank actually sent, verified or not.
- **Hedging is intentionally granular.** A single order can spawn several
  `HedgingPosition` rows (one per MCX contract size used to cover the
  volume). If *any* leg is rejected, the order is flagged for manual
  intervention rather than silently marked `HEDGED` — this is what "Zero
  Balance-Sheet Slippage" means operationally.
- **After-hours is a real state, not an error.** A settlement that lands
  while MCX is closed doesn't throw or block — it parks the affected legs
  in `AWAITING_MARKET_OPEN` via a Redis-queued AMO, and a scheduled worker
  places them for real at market open. `HEDGE_FAILED` is reserved for
  something actually going wrong (a rejected order, a circuit/margin
  block) — never used as a stand-in for "not yet possible."
- **The instrument resolver won't serve you into a tender period.** MCX
  gold contracts become illiquid and can decouple from spot once they enter
  delivery/tender notice; the resolver excludes those contracts even from
  its own Redis cache, so a cached instrument doesn't silently go stale
  mid-session.
- **All of Kotak Neo's exact endpoint paths and response field names here
  are illustrative**, following the general shape of their published API.
  Confirm every one (`/login/1.0/login/v2/validate`, the order-placement
  and order-report paths, the scrip-master CSV columns) against your
  current credential bundle's documentation before going live — this code
  is written to fail loudly (typed errors, no silent fallthrough) precisely
  so a wrong assumption here surfaces in staging, not as a phantom
  unhedged position in production.

## What's actually live now vs. still simulated

The tick board and rate lock are real as of this update — `/api/tick` and
`/api/rate-lock` hit live public feeds and a real Redis lock, not local
component state. Specifically:

- **Live**: `/api/tick` (spot price from gold-api.com, USD/INR from
  open.er-api.com, both free/no-key), `/api/rate-lock` (Redis-backed
  30-second lock, resolved against the exact quoteId that was ticked).
- **Still simulated / hardcoded**: the VAN/IFSC/bank shown in
  `VanPaymentPanel` (no `VirtualAccount` row exists yet — Postgres isn't
  wired), the demo user id (a random UUID in `localStorage`, not real
  auth), and everything past "lock rate" — no `Order` row is actually
  created, so there's nothing yet for a bank webhook to reconcile against.
- **A real limitation, not a bug**: open.er-api.com's USD/INR rate only
  refreshes once a day. The gold spot leg is genuinely live; the FX leg is
  "today's rate", not "this second's rate". Fine for a working demo — swap
  for a paid intraday FX feed (or your settlement bank's own quoted rate)
  before this handles a real settlement amount.
- **Requires `REDIS_URL` to actually work.** Rate-lock and the tick cache
  both depend on Redis — without it, `/api/tick` and `/api/rate-lock` will
  fail. Point `REDIS_URL` (in `.env` locally, or your Vercel project's
  environment variables for the deployed site) at any real Redis instance —
  Upstash's free tier works fine and gives you a standard `redis://` or
  `rediss://` connection string.

## Wiring to Prisma

The route handlers under `src/app/api/` have their persistence
dependencies stubbed with explicit `throw new Error(...)` calls rather than
silent no-ops, so a deploy that forgets to wire something fails loudly in
staging instead of quietly corrupting order state. To wire a route:

1. Instantiate a shared `PrismaClient` in `src/lib/db.ts`.
2. Replace each stub in the route's `deps` object with the matching Prisma
   call (`prisma.order.findUnique`, `prisma.settlement.create`, etc).
3. For `getQuotedRatePerGram` in `rate-lock/route.ts`, wire it to wherever
   your WebSocket gateway caches the latest tick per `quoteId` (a Redis hash
   is the natural choice, since Redis is already in the stack for locks).

## Not yet implemented (flagged, not silently skipped)

- The WebSocket gateway that pushes live ticks to clients and populates the
  tick cache `getQuotedRatePerGram` reads from.
- e-Way Bill generation and the armored-carrier dispatch integration
  (Sequel Logistics / BVC) referenced by `LogisticsRecord`.
- PMLA/FIU-IND cash-transaction and Section 269ST split-payment validation
  — this needs to sit in the order-creation path, upstream of rate-lock,
  and depends on your KYC/AML vendor's specific API shape.
- Cumulative-FY TCS tracking (`alreadyCollectedThisFyInr` in
  `pricing.ts`) needs a ledger query per buyer; the calculator takes it as
  an input rather than computing it, to keep pricing logic stateless.

## Getting started

```bash
cp .env.example .env      # fill in DB, Redis, bank, broker secrets
npm install
npm run prisma:generate
npm run prisma:migrate
npm run dev                # trading terminal at /trading
```
