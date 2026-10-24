import { describe, expect, it } from 'vitest';
import { allocate, concurrency } from '../src/allocate';

const M = 60_000;
const at = (h: number, m = 0) => (h * 60 + m) * M;

// Приклад із документа: A 10:00–11:00, B 10:30–11:30.
const AB = [
  { taskId: 'A', start: at(10), stop: at(11) },
  { taskId: 'B', start: at(10, 30), stop: at(11, 30) },
];

describe('allocate', () => {
  it('full: кожна задача отримує весь свій час', () => {
    expect(allocate(AB, 0, at(24), at(23), 'full')).toEqual({ wall: 90 * M, perTask: { A: 60 * M, B: 60 * M } });
  });

  it('split: паралельний час ділиться порівну, сума = реальний час', () => {
    expect(allocate(AB, 0, at(24), at(23), 'split')).toEqual({ wall: 90 * M, perTask: { A: 45 * M, B: 45 * M } });
  });

  it('focus: час іде задачі у фокусі', () => {
    const focus = [
      { taskId: 'A', at: at(10) },
      { taskId: 'B', at: at(10, 30) },
    ];
    expect(allocate(AB, 0, at(24), at(23), 'focus', focus)).toEqual({ wall: 90 * M, perTask: { A: 30 * M, B: 60 * M } });
  });

  it('focus: якщо задача у фокусі не йде — як split', () => {
    const focus = [{ taskId: 'C', at: at(9) }];
    expect(allocate(AB, 0, at(24), at(23), 'focus', focus).perTask).toEqual({ A: 45 * M, B: 45 * M });
  });

  it('обрізає записи межами періоду (запис через північ)', () => {
    const e = [{ taskId: 'X', start: at(23, 42), stop: at(25, 5) }];
    expect(allocate(e, 0, at(24), at(30), 'full')).toEqual({ wall: 18 * M, perTask: { X: 18 * M } });
    expect(allocate(e, at(24), at(48), at(30), 'full')).toEqual({ wall: 65 * M, perTask: { X: 65 * M } });
  });

  it('запущений запис рахується до now', () => {
    const e = [{ taskId: 'X', start: at(10), stop: null }];
    expect(allocate(e, 0, at(24), at(12), 'full').wall).toBe(120 * M);
  });

  it('два агенти в одній задачі рахуються як одна задача', () => {
    const e = [
      { taskId: 'A', start: at(10), stop: at(11) },
      { taskId: 'A', start: at(10, 30), stop: at(12) },
      { taskId: 'B', start: at(10), stop: at(11) },
    ];
    const r = allocate(e, 0, at(24), at(23), 'full');
    expect(r).toEqual({ wall: 120 * M, perTask: { A: 120 * M, B: 60 * M } });
    // split: 10:00–11:00 ділиться між A і B, 11:00–12:00 — лише A
    expect(allocate(e, 0, at(24), at(23), 'split').perTask).toEqual({ A: 90 * M, B: 30 * M });
  });

  it('порожній період', () => {
    expect(allocate([], 0, at(24), at(23), 'split')).toEqual({ wall: 0, perTask: {} });
  });
});

describe('concurrency', () => {
  it('п’ять сесій одного проєкту одночасно — ×5', () => {
    const five = [1, 2, 3, 4, 5].map((i) => ({ key: `s${i}`, start: at(10), stop: at(11) }));
    const c = concurrency(five, 0, at(24), at(23));
    expect(c).toEqual({ wall: 60 * M, sum: 300 * M, peak: 5 });
    expect(c.sum / c.wall).toBe(5);
  });

  it('частково перекриті сесії: середнє, а не пік', () => {
    // A 10:00–11:00, B 10:30–11:30 → реально 90 хв, разом 120 хв, ×1.33, пік 2
    const c = concurrency(
      [
        { key: 'A', start: at(10), stop: at(11) },
        { key: 'B', start: at(10, 30), stop: at(11, 30) },
      ],
      0,
      at(24),
      at(23),
    );
    expect(c).toEqual({ wall: 90 * M, sum: 120 * M, peak: 2 });
  });

  it('записи одного потоку не подвоюються', () => {
    const c = concurrency(
      [
        { key: 'A', start: at(10), stop: at(11) },
        { key: 'A', start: at(10, 30), stop: at(11, 30) },
      ],
      0,
      at(24),
      at(23),
    );
    expect(c).toEqual({ wall: 90 * M, sum: 90 * M, peak: 1 });
  });

  it('запущений потік рахується до now і обрізається межами', () => {
    const c = concurrency([{ key: 'A', start: at(10), stop: null }], at(10, 30), at(24), at(11));
    expect(c).toEqual({ wall: 30 * M, sum: 30 * M, peak: 1 });
  });
});
