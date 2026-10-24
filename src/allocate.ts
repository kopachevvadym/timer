/**
 * Розподіл часу між задачами, що йшли паралельно.
 *
 * - full:  кожна задача отримує весь свій час (сума ≥ реального часу)
 * - split: відрізок, де йдуть k задач, ділиться на k (сума = реальний час)
 * - focus: відрізок іде задачі у фокусі, якщо вона запущена; інакше як split
 *
 * Кілька записів однієї задачі в один момент (два агенти в одному репо)
 * рахуються як одна задача.
 */

export type Mode = 'full' | 'split' | 'focus';

export interface Interval {
  taskId: string;
  start: number;
  stop: number | null; // null = іде зараз
}

export interface FocusSwitch {
  taskId: string | null;
  at: number;
}

export interface Allocation {
  /** Реальний час: довжина об'єднання всіх інтервалів, мс. */
  wall: number;
  /** Час по задачах за обраним режимом, мс. */
  perTask: Record<string, number>;
}

export function allocate(
  entries: Interval[],
  from: number,
  to: number,
  now: number,
  mode: Mode,
  focus: FocusSwitch[] = [],
): Allocation {
  const iv = entries
    .map((e) => ({ taskId: e.taskId, s: Math.max(e.start, from), e: Math.min(e.stop ?? now, to) }))
    .filter((x) => x.e > x.s);

  const pts = new Set<number>();
  for (const x of iv) {
    pts.add(x.s);
    pts.add(x.e);
  }
  const sortedFocus = [...focus].sort((a, b) => a.at - b.at);
  if (mode === 'focus') {
    for (const f of sortedFocus) if (f.at > from && f.at < to) pts.add(f.at);
  }
  const points = [...pts].sort((a, b) => a - b);

  let fi = -1; // індекс останнього перемикання фокусу ≤ поточного моменту
  const focusAt = (t: number): string | null => {
    while (fi + 1 < sortedFocus.length && sortedFocus[fi + 1].at <= t) fi++;
    return fi >= 0 ? sortedFocus[fi].taskId : null;
  };

  const perTask: Record<string, number> = {};
  const add = (t: string, v: number) => {
    perTask[t] = (perTask[t] ?? 0) + v;
  };

  let wall = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const len = b - a;
    const active = [...new Set(iv.filter((x) => x.s <= a && x.e >= b).map((x) => x.taskId))];
    if (active.length === 0) continue;
    wall += len;
    if (mode === 'full') {
      for (const t of active) add(t, len);
      continue;
    }
    const f = mode === 'focus' ? focusAt(a) : null;
    if (f && active.includes(f)) add(f, len);
    else for (const t of active) add(t, len / active.length);
  }

  return { wall, perTask };
}

export interface Stream {
  /** Потік роботи: сесія агента, таймер задачі через MCP або ручний таймер проєкту. */
  key: string;
  start: number;
  stop: number | null;
}

export interface Concurrency {
  /** Реальний час: коли йшов хоча б один потік, мс. */
  wall: number;
  /** Сума часу всіх потоків (п'ять сесій по годині разом = 5 год), мс. */
  sum: number;
  /** Найбільше потоків одночасно. */
  peak: number;
}

/**
 * Скільки потоків роботи йшло одночасно — незалежно від того, один це проєкт чи різні.
 * Кілька записів одного потоку в один момент рахуються один раз. sum / wall — середня паралельність.
 */
export function concurrency(streams: Stream[], from: number, to: number, now: number): Concurrency {
  const iv = streams
    .map((x) => ({ key: x.key, s: Math.max(x.start, from), e: Math.min(x.stop ?? now, to) }))
    .filter((x) => x.e > x.s);
  const points = [...new Set(iv.flatMap((x) => [x.s, x.e]))].sort((a, b) => a - b);
  let wall = 0;
  let sum = 0;
  let peak = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const k = new Set(iv.filter((x) => x.s <= a && x.e >= b).map((x) => x.key)).size;
    if (k === 0) continue;
    wall += b - a;
    sum += k * (b - a);
    peak = Math.max(peak, k);
  }
  return { wall, sum, peak };
}
