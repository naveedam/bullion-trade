# Bullion Trading Platform — Core Scaffold

A B2B bullion (gold/silver) price-lock platform for Bangalore's wholesale
jewellery trade — replacing phone/WhatsApp price-locking between suppliers
and Raja Market/Chickpet retailers with a transparent, instantly-lockable
rate. No brokerage or order-execution role: the platform quotes and locks
prices, then a bank transfer settles the trade (pre-funded virtual-account
clearing, a 30-second rate-lock engine).

## What's here

```
prisma/schema.prisma          Full data model: entities, virtual accounts,
                               orders (state machine), inventory bars,
                               hedging positions, logistics.

src/lib/pricing.ts             Dynamic spot → ask-price calculator.
                                Decimal-safe (decimal.js), GST (3%) and
                                Section 206C(1H) TCS handling.

src/lib/marketFeed.ts          Live international spot (gold-api.com,
                                free/no-key) and USD/INR (open.er-api.com,
                                free/no-key, daily) with a Redis
                                pull-through cache and stale-fallback so a
                                provider hiccup degrades gracefully instead
                                of 500ing the quote board. Feeds the drift
                                calculation in tickService.ts and the
                                LBMA+FX fallback mode.

src/lib/ibja.ts                The pricing anchor — India Bullion and
                                Jewellers Association's published gold/
                                silver rate, the benchmark the Indian
                                bullion trade actually references. NOT
                                wired to a real provider yet — see the file
                                header and the "What's live" section below.

src/lib/tickService.ts         The actual pricing engine: takes the IBJA
                                anchor and drifts it live using how much
                                marketFeed.ts's international price has
                                moved since the anchor was captured, so the
                                display keeps moving between IBJA's
                                periodic republishes. Falls back to a plain
                                LBMA+FX reconstruction if IBJA fails
                                outright. Caches the resulting tick under
                                both a "current per metal" key (for
                                /api/tick's polling) and a "per quoteId"
                                key kept slightly longer than the lock
                                window (for rate-lock to resolve exactly
                                what was quoted).

src/lib/rateLock.ts            Redis-backed 30-second distributed lock.
                                acquireLock() / commitLock() with atomic
                                compare-and-delete to prevent race conditions
                                on expiry.

src/lib/webhook.ts             Bank settlement webhook ingestion: HMAC
                                verification, replay protection, VAN +
                                amount reconciliation, order state advance.

src/lib/hedging.ts              NOT currently used by any active code
                                path — the platform doesn't place orders
                                or hedge exposure (see business decision
                                above). Kept in the repo, self-contained,
                                in case that changes. Broker-agnostic
                                interface (HedgeBroker) + a Kite Connect
                                adapter. Greedy lot-decomposition across
                                Gold Petal / Gold Mini / Gold 1kg. Also
                                holds the fill-poller
                                (pollAndReconcileHedgeFills).

src/lib/kotak/                  Kotak Neo integration — also NOT wired
                                 into any active code path currently (see
                                 above). Left intact and working (verified
                                 against OptionPal Pro's real
                                 implementation — see git history / prior
                                 discussion for what's confirmed vs.
                                 inferred) in case hedging becomes
                                 relevant later.
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

- **Live**: `/api/tick`, `/api/rate-lock` (real Redis lock, resolved against
  the exact quoteId that was ticked).
- **Pricing model, per the platform's business decision** (a B2B price-lock
  platform for Bangalore's bullion trade — not a brokerage, no order
  execution): both GOLD and SILVER price off an **IBJA anchor with live
  drift**. The anchor is India Bullion and Jewellers Association's
  published rate — the benchmark the formal Indian bullion trade actually
  references — refreshed every few hours. Between refreshes, the anchor is
  scaled by how much the international spot+FX price has moved since it
  was captured, so the displayed price keeps moving in real time without
  ever floating disconnected from the trade's actual reference rate. See
  `tickService.ts`'s file header for the exact math. If IBJA fails
  outright, gold and silver both fall back to the plain LBMA+FX
  reconstruction — `TickSnapshot.priceSource` always records which mode
  priced a given tick.
- **`src/lib/ibja.ts` is the one unwired piece** — there's no single
  obvious free IBJA source the way gold-api.com/open.er-api.com were for
  international spot. `fetchIbjaFromProvider` throws with a clear message
  until you pick a provider (a licensed API like indiagoldratesapi.com, or
  a RapidAPI-hosted listing) and implement its real request/response
  shape — the file header has the contract and an example. Everything
  downstream (the anchor caching, drift math, fallback) is built and
  smoke-tested against simulated IBJA data already; wiring a real provider
  in is the only remaining step for this to be genuinely live end to end.
- **Kotak Neo / MCX (`src/lib/kotak/`) is no longer in the pricing path.**
  Left in the repo untouched, in case hedging becomes relevant later, but
  `tickService.ts` doesn't call it — the business doesn't place orders or
  need a broker account, so it made no sense to keep MCX-via-Kotak as the
  primary price source. If this ever changes, `mcxPricingService.ts` is
  still there and was working (see its own commit history / prior
  conversation) — it would just need re-wiring into `tickService.ts`.
- **Still simulated / hardcoded**: the VAN/IFSC/bank shown in
  `VanPaymentPanel` (no `VirtualAccount` row exists yet — Postgres isn't
  wired), the demo user id (a random UUID in `localStorage`, not real
  auth), and everything past "lock rate" — no `Order` row is actually
  created, so there's nothing yet for a bank webhook to reconcile against.
- **Requires `REDIS_URL` to actually work.** Rate-lock and the tick cache
  both depend on Redis — without it, `/api/tick` and `/api/rate-lock` will
  fail with a clear `RedisNotConfiguredError` message (503) rather than a
  generic 500. If using Upstash: copy the `rediss://` (TLS) connection
  string specifically, not the `https://` REST API URL and not the
  `redis-cli --tls -u ...` command Upstash shows by default — only the
  `rediss://...` portion is the actual value `REDIS_URL` needs.

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
