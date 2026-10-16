import { describe, expect, it } from 'vitest';
import { safeNext, sign, verify } from '../src/users';

describe('safeNext', () => {
  it('пропускає шляхи цього сайту', () => {
    expect(safeNext('/')).toBe('/');
    expect(safeNext('/authorize?client_id=x&state=y')).toBe('/authorize?client_id=x&state=y');
    expect(safeNext('/#settings')).toBe('/#settings');
  });
  it('відкидає все, що веде на інший сайт', () => {
    for (const bad of ['//evil.com', '/\t/evil.com', '/\n/evil.com', '/\\evil.com', 'https://evil.com', 'evil.com', '/ /evil.com', '', null, undefined]) {
      expect(safeNext(bad as string)).toBe('/');
    }
  });
});

describe('sign / verify', () => {
  const secret = 'x'.repeat(40);
  it('перевіряє підпис', async () => {
    const t = await sign(secret, { a: 1 });
    expect(await verify(secret, t)).toEqual({ a: 1 });
    expect(await verify('y'.repeat(40), t)).toBeNull();
    expect(await verify(secret, t.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')))).toBeNull();
  });
});
