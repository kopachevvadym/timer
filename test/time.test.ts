import { describe, expect, it } from 'vitest';
import { days, localDate, nextDay, parseInstant, periodRange, startOfDay, startOfWeek } from '../src/time';

const TZ = 'Europe/Kyiv';
const H = 3_600_000;

describe('time', () => {
  it('початок дня у Києві (літній час, UTC+3)', () => {
    const t = Date.parse('2026-10-14T08:49:00Z');
    expect(new Date(startOfDay(t, TZ)).toISOString()).toBe('2026-10-13T21:00:00.000Z');
  });

  it('доба переходу на зимовий час триває 25 годин', () => {
    // 25 жовтня 2026 у Європі — повернення на зимовий час
    const s = startOfDay(Date.parse('2026-10-25T12:00:00Z'), TZ);
    expect(new Date(s).toISOString()).toBe('2026-10-24T21:00:00.000Z');
    expect(nextDay(s, TZ) - s).toBe(25 * H);
  });

  it('доба переходу на літній час триває 23 години', () => {
    const s = startOfDay(Date.parse('2026-03-29T12:00:00Z'), TZ);
    expect(nextDay(s, TZ) - s).toBe(23 * H);
  });

  it('тиждень починається з понеділка', () => {
    const wed = Date.parse('2026-10-14T12:00:00Z'); // середа
    expect(localDate(startOfWeek(wed, TZ), TZ)).toBe('2026-10-12');
    const sun = Date.parse('2026-10-18T20:00:00Z'); // неділя 23:00 за Києвом
    expect(localDate(startOfWeek(sun, TZ), TZ)).toBe('2026-10-12');
  });

  it('this_week = 7 днів', () => {
    const { from, to } = periodRange('this_week', Date.parse('2026-10-14T12:00:00Z'), TZ);
    expect(days(from, to, TZ).map((d) => d.date)).toEqual([
      '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18',
    ]);
  });

  it('parseInstant: локальний час без зсуву — у поясі трекера', () => {
    expect(new Date(parseInstant('2026-10-14 08:49', TZ)).toISOString()).toBe('2026-10-14T05:49:00.000Z');
    expect(new Date(parseInstant('2026-10-14', TZ)).toISOString()).toBe('2026-10-13T21:00:00.000Z');
    expect(parseInstant('2026-10-14T08:49:00Z', TZ)).toBe(Date.parse('2026-10-14T08:49:00Z'));
    expect(parseInstant(1234, TZ)).toBe(1234);
    expect(() => parseInstant('вчора', TZ)).toThrow();
  });
});

describe('time: перехід на літній час опівночі', () => {
  it('America/Santiago: дні не дублюються, доба переходу — 23 години', () => {
    const tz = 'America/Santiago';
    const from = Date.parse('2026-09-04T12:00:00Z');
    const list = days(from, Date.parse('2026-09-08T12:00:00Z'), tz);
    const dates = list.map((d) => d.date);
    expect(new Set(dates).size).toBe(dates.length);
    expect(dates).toContain('2026-09-06');
    const lens = list.map((d) => (d.end - d.start) / H);
    expect(lens.filter((l) => l === 23)).toHaveLength(1);
    expect(lens.every((l) => l === 23 || l === 24)).toBe(true);
  });
});
