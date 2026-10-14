/**
 * Межі днів і тижнів у часовому поясі користувача без зовнішніх бібліотек.
 * Коректно обробляє переходи на літній/зимовий час (доби по 23 і 25 годин).
 */

const DAY = 24 * 60 * 60 * 1000;

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

interface Parts {
  y: number;
  m: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

function parts(instant: number, tz: string): Parts {
  const p: Record<string, number> = {};
  for (const { type, value } of fmt(tz).formatToParts(new Date(instant))) {
    if (type !== 'literal') p[type] = Number(value);
  }
  return { y: p.year, m: p.month, d: p.day, h: p.hour, mi: p.minute, s: p.second };
}

/** Зсув часового поясу (мс) у момент instant: local = utc + offset. */
export function tzOffset(instant: number, tz: string): number {
  const p = parts(instant, tz);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/** UTC-момент для локального часу y-m-d h:mi:s у поясі tz. */
export function zonedTime(y: number, m: number, d: number, h: number, mi: number, s: number, tz: string): number {
  const naive = Date.UTC(y, m - 1, d, h, mi, s);
  const g1 = naive - tzOffset(naive, tz);
  const g2 = naive - tzOffset(g1, tz);
  // Якщо локального часу не існує (перехід на літній час рівно опівночі, як у Чилі),
  // друга ітерація потрапляє в попередній день — тоді беремо першу: момент переходу.
  const want = new Date(naive).toISOString().slice(0, 10);
  if (localDate(g2, tz) !== want && localDate(g1, tz) === want) return g1;
  return g2;
}

/** UTC-момент локальної опівночі для дати y-m-d у поясі tz. */
export function zonedMidnight(y: number, m: number, d: number, tz: string): number {
  return zonedTime(y, m, d, 0, 0, 0, tz);
}

/**
 * Розбирає момент часу: мілісекунди, ISO 8601 зі зсувом (2026-10-14T10:00:00+03:00, ...Z)
 * або локальний час без зсуву (2026-10-14, 2026-10-14T10:00, 2026-10-14 10:00) — тоді в поясі tz.
 */
export function parseInstant(v: string | number, tz: string): number {
  if (typeof v === 'number') return v;
  const s = v.trim();
  if (/^\d+$/.test(s)) return Number(s);
  const local = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (local) {
    const [, y, m, d, h = '0', mi = '0', sec = '0'] = local;
    return zonedTime(+y, +m, +d, +h, +mi, +sec, tz);
  }
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new Error(`Не вдалося розібрати час: ${v}`);
  return t;
}

/** Початок локального дня, що містить instant. */
export function startOfDay(instant: number, tz: string): number {
  const p = parts(instant, tz);
  return zonedMidnight(p.y, p.m, p.d, tz);
}

/** Початок наступного локального дня. */
export function nextDay(dayStart: number, tz: string): number {
  return startOfDay(dayStart + DAY + 2 * 60 * 60 * 1000, tz);
}

/** Початок локального тижня (понеділок). */
export function startOfWeek(instant: number, tz: string): number {
  const start = startOfDay(instant, tz);
  const p = parts(start + 12 * 60 * 60 * 1000, tz);
  const dow = new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay(); // 0 = неділя
  const back = (dow + 6) % 7;
  return zonedMidnight(p.y, p.m, p.d - back, tz);
}

/** Початок локального місяця. */
export function startOfMonth(instant: number, tz: string): number {
  const p = parts(instant, tz);
  return zonedMidnight(p.y, p.m, 1, tz);
}

/** 'YYYY-MM-DD' у поясі tz. */
export function localDate(instant: number, tz: string): string {
  const p = parts(instant, tz);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

/** Локальні дні [start, end), що перетинають [from, to). */
export function days(from: number, to: number, tz: string): { date: string; start: number; end: number }[] {
  const out: { date: string; start: number; end: number }[] = [];
  let s = startOfDay(from, tz);
  while (s < to) {
    const e = nextDay(s, tz);
    out.push({ date: localDate(s, tz), start: s, end: e });
    s = e;
  }
  return out;
}

export const PERIODS = ['today', 'yesterday', 'this_week', 'last_week', 'this_month', 'last_month'] as const;
export type Period = (typeof PERIODS)[number];

export function periodRange(period: Period, now: number, tz: string): { from: number; to: number } {
  switch (period) {
    case 'today': {
      const from = startOfDay(now, tz);
      return { from, to: nextDay(from, tz) };
    }
    case 'yesterday': {
      const to = startOfDay(now, tz);
      return { from: startOfDay(to - 1, tz), to };
    }
    case 'this_week': {
      const from = startOfWeek(now, tz);
      return { from, to: startOfWeek(from + 8 * DAY, tz) };
    }
    case 'last_week': {
      const to = startOfWeek(now, tz);
      return { from: startOfWeek(to - 1, tz), to };
    }
    case 'this_month': {
      const from = startOfMonth(now, tz);
      return { from, to: startOfMonth(from + 32 * DAY, tz) };
    }
    case 'last_month': {
      const to = startOfMonth(now, tz);
      return { from: startOfMonth(to - 1, tz), to };
    }
  }
}

/** 3725000 → "1:02". */
export function hm(ms: number): string {
  const totalMin = Math.round(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h}:${String(m).padStart(2, '0')}`;
}
