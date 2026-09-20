/**
 * MCX Session Hours
 * ---------------------------------------------------------------------------
 * MCX commodity derivatives trade in two daily sessions, Monday to Friday
 * (no weekend trading), plus a published annual holiday calendar and
 * occasional one-off closures (e.g. muhurat-adjacent special sessions) that
 * are NOT deducible from day-of-week alone.
 *
 *   Morning:  09:00 - 17:00 IST
 *   Evening:  17:00 - 23:30 IST (up to 23:55 IST during the part of the year
 *             MCX evening close tracks COMEX daylight-saving hours) — the
 *             exact evening close time shifts twice a year and MUST be
 *             confirmed against the exchange's published circular for the
 *             current period rather than hard-coded indefinitely. Pass the
 *             current value via config; do not trust the default in
 *             production without checking it against this month's circular.
 *
 * This module deliberately does NOT hard-code a holiday list inline: MCX
 * publishes a fresh trading-holiday calendar every calendar year, and a
 * stale in-code list is a worse failure mode than an honest "ask the
 * calendar provider" — it would silently permit orders on a day the
 * exchange is actually closed. `isHolidayIst` is injected so it can be
 * backed by a small Redis-cached table synced from the exchange circular.
 */

export type McxSessionWindow = "MORNING" | "EVENING" | "CLOSED";

export interface McxMarketStatus {
  isOpen: boolean;
  session: McxSessionWindow;
  isHoliday: boolean;
  nowIst: Date;
  /** Next IST instant the market will be open, for scheduling AMO release. */
  nextOpenIst: Date | null;
}

const IST_OFFSET_MINUTES = 5 * 60 + 30;

const MORNING_OPEN = { hour: 9, minute: 0 };
const MORNING_CLOSE = { hour: 17, minute: 0 };
const EVENING_OPEN = { hour: 17, minute: 0 };
const EVENING_CLOSE_DEFAULT = { hour: 23, minute: 30 };

export interface McxMarketHoursConfig {
  eveningCloseHour?: number;
  eveningCloseMinute?: number;
  /** Injected holiday check — should be backed by the synced exchange calendar. */
  isHolidayIst: (dateIst: Date) => Promise<boolean> | boolean;
}

function toIst(date: Date): Date {
  const utcMs = date.getTime() + date.getTimezoneOffset() * 60_000;
  return new Date(utcMs + IST_OFFSET_MINUTES * 60_000);
}

function atIstTime(base: Date, hour: number, minute: number): Date {
  const d = new Date(base);
  d.setHours(hour, minute, 0, 0);
  return d;
}

function isWeekendIst(dateIst: Date): boolean {
  const day = dateIst.getDay(); // 0 = Sunday, 6 = Saturday
  return day === 0 || day === 6;
}

/**
 * Walks forward day by day (bounded to 14 days as a sanity limit) to find
 * the next weekday that isn't a holiday, returning that day's 09:00 IST
 * morning open.
 */
async function nextTradingSessionOpen(
  fromIst: Date,
  config: McxMarketHoursConfig
): Promise<Date> {
  let cursor = new Date(fromIst);
  cursor.setDate(cursor.getDate() + 1);
  cursor.setHours(MORNING_OPEN.hour, MORNING_OPEN.minute, 0, 0);

  for (let i = 0; i < 14; i++) {
    const weekend = isWeekendIst(cursor);
    const holiday = weekend ? false : await config.isHolidayIst(cursor);
    if (!weekend && !holiday) {
      return cursor;
    }
    cursor = new Date(cursor);
    cursor.setDate(cursor.getDate() + 1);
  }

  // Fallback — should never be reached with a sane holiday calendar, but
  // better to return a concrete (if wrong) date than throw during a
  // settlement webhook's critical path.
  return cursor;
}

export async function getMcxMarketStatus(
  config: McxMarketHoursConfig,
  now: Date = new Date()
): Promise<McxMarketStatus> {
  const nowIst = toIst(now);
  const eveningCloseHour = config.eveningCloseHour ?? EVENING_CLOSE_DEFAULT.hour;
  const eveningCloseMinute =
    config.eveningCloseMinute ?? EVENING_CLOSE_DEFAULT.minute;

  const weekend = isWeekendIst(nowIst);
  const holiday = weekend ? false : await config.isHolidayIst(nowIst);
  const closedForDay = weekend || holiday;

  const morningOpen = atIstTime(nowIst, MORNING_OPEN.hour, MORNING_OPEN.minute);
  const morningClose = atIstTime(
    nowIst,
    MORNING_CLOSE.hour,
    MORNING_CLOSE.minute
  );
  const eveningOpen = atIstTime(nowIst, EVENING_OPEN.hour, EVENING_OPEN.minute);
  const eveningClose = atIstTime(nowIst, eveningCloseHour, eveningCloseMinute);

  if (closedForDay) {
    return {
      isOpen: false,
      session: "CLOSED",
      isHoliday: holiday,
      nowIst,
      nextOpenIst: await nextTradingSessionOpen(nowIst, config),
    };
  }

  if (nowIst >= morningOpen && nowIst < morningClose) {
    return {
      isOpen: true,
      session: "MORNING",
      isHoliday: false,
      nowIst,
      nextOpenIst: null,
    };
  }

  if (nowIst >= eveningOpen && nowIst < eveningClose) {
    return {
      isOpen: true,
      session: "EVENING",
      isHoliday: false,
      nowIst,
      nextOpenIst: null,
    };
  }

  // Before 09:00, or past evening close — either way, resolve the next open.
  const nextOpen =
    nowIst < morningOpen
      ? morningOpen
      : await nextTradingSessionOpen(nowIst, config);

  return {
    isOpen: false,
    session: "CLOSED",
    isHoliday: false,
    nowIst,
    nextOpenIst: nextOpen,
  };
}
