/**
 * Користувачі, вхід через GitHub або Google, сесії вебу (підписана cookie) і API-ключі для хуків / MCP.
 * Секрети: SESSION_SECRET (підпис cookie), GITHUB_CLIENT_SECRET, GOOGLE_CLIENT_SECRET. Ключі зберігаються лише як SHA-256.
 */
import { TimerError } from './service';

export interface User {
  id: string;
  github_id: number | null;
  login: string | null;
  name: string | null;
  avatar_url: string | null;
  timezone: string;
  note_from_prompt: number;
  session_epoch: number;
  created_at: number;
  last_login_at: number | null;
  /** Google: незмінний id (sub) і пошта для показу. */
  google_sub: string | null;
  google_email: string | null;
}

export type KeyScope = 'full' | 'hooks';

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  scope: KeyScope;
  created_at: number;
  last_used_at: number | null;
}

const enc = new TextEncoder();

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

export function randomToken(bytes = 32): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmacKey(secret: string) {
  if (!secret || secret.length < 32) throw new Error('SESSION_SECRET має бути щонайменше 32 символи');
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

/** Підписаний токен «payload.signature» (HMAC-SHA256). */
export async function sign(secret: string, payload: object): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(body));
  return `${body}.${b64url(sig)}`;
}

export async function verify<T>(secret: string, token: string | undefined | null): Promise<T | null> {
  if (!token) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  try {
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), fromB64url(sig), enc.encode(body));
    if (!ok) return null;
    return JSON.parse(new TextDecoder().decode(fromB64url(body))) as T;
  } catch {
    return null;
  }
}

// ───────────── Сесія вебу ─────────────

export const SESSION_COOKIE = '__Host-timer_session';
export const SESSION_TTL_MS = 30 * 24 * 3600_000;

interface SessionPayload {
  /** Призначення токена — щоб підписаний state OAuth не можна було видати за сесію. */
  p: 'sess';
  u: string;
  /** Кінець дії, мс. */
  e: number;
  /** users.session_epoch на момент входу; вихід збільшує його й гасить усі cookie. */
  v: number;
}

export async function makeSessionCookie(secret: string, user: Pick<User, 'id' | 'session_epoch'>, now: number): Promise<string> {
  const token = await sign(secret, { p: 'sess', u: user.id, e: now + SESSION_TTL_MS, v: user.session_epoch } satisfies SessionPayload);
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
}

export const clearSessionCookie = `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie') ?? '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

export async function userFromSession(db: D1Database, secret: string, request: Request, now: number): Promise<User | null> {
  const p = await verify<SessionPayload>(secret, readCookie(request, SESSION_COOKIE));
  if (!p || p.p !== 'sess' || typeof p.u !== 'string' || typeof p.e !== 'number' || p.e < now) return null;
  const user = await getUser(db, p.u);
  return user && user.session_epoch === p.v ? user : null;
}

/** Вихід з усіх пристроїв: старі cookie більше не приймаються. */
export async function bumpSessionEpoch(db: D1Database, userId: string): Promise<void> {
  await db.prepare('UPDATE users SET session_epoch = session_epoch + 1 WHERE id = ?').bind(userId).run();
}

// ───────────── Користувачі ─────────────

export async function getUser(db: D1Database, id: string): Promise<User | null> {
  return db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<User>();
}

export interface GithubProfile {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string | null;
}

/**
 * Користувач за профілем GitHub: існуючий, або власник наявних даних (перший вхід з OWNER_GITHUB_ID),
 * або новий. Власника визначаємо за числовим id: логін на GitHub можна змінити, і старий хтось займе.
 */
export async function upsertGithubUser(db: D1Database, gh: GithubProfile, ownerGithubId: string, tz: string, now: number): Promise<User> {
  const existing = await db.prepare('SELECT * FROM users WHERE github_id = ?').bind(gh.id).first<User>();
  if (existing) {
    await db
      .prepare('UPDATE users SET login = ?, name = ?, avatar_url = ?, last_login_at = ? WHERE id = ?')
      .bind(gh.login, gh.name, gh.avatar_url, now, existing.id)
      .run();
    return (await getUser(db, existing.id))!;
  }
  if (/^\d+$/.test(ownerGithubId ?? '') && gh.id === Number(ownerGithubId)) {
    // Власник забирає дані, що були до появи акаунтів. Умова github_id IS NULL — лише один раз.
    const claimed = await db
      .prepare('UPDATE users SET github_id = ?, login = ?, name = ?, avatar_url = ?, last_login_at = ? WHERE id = ? AND github_id IS NULL')
      .bind(gh.id, gh.login, gh.name, gh.avatar_url, now, 'owner')
      .run();
    if ((claimed.meta.changes ?? 0) > 0) return (await getUser(db, 'owner'))!;
  }
  const id = crypto.randomUUID();
  await db
    .prepare(
      'INSERT INTO users (id, github_id, login, name, avatar_url, timezone, note_from_prompt, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)',
    )
    .bind(id, gh.id, gh.login, gh.name, gh.avatar_url, validTimezone(tz) ? tz : 'UTC', now, now)
    .run();
  return (await getUser(db, id))!;
}

export function validTimezone(tz: string | null | undefined): tz is string {
  if (!tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export async function updateSettings(db: D1Database, userId: string, patch: { timezone?: string; note_from_prompt?: boolean }): Promise<User> {
  const u = await getUser(db, userId);
  if (!u) throw new TimerError('Користувача не знайдено', 404);
  if (patch.timezone !== undefined && !validTimezone(patch.timezone)) throw new TimerError(`Невідомий часовий пояс: ${patch.timezone}`);
  await db
    .prepare('UPDATE users SET timezone = ?, note_from_prompt = ? WHERE id = ?')
    .bind(patch.timezone ?? u.timezone, patch.note_from_prompt === undefined ? u.note_from_prompt : patch.note_from_prompt ? 1 : 0, userId)
    .run();
  return (await getUser(db, userId))!;
}

/** Видалити акаунт з усіма даними. */
export async function deleteUser(db: D1Database, userId: string): Promise<void> {
  await db.batch(
    [
      'DELETE FROM time_entries WHERE user_id = ?',
      'DELETE FROM session_tasks WHERE user_id = ?',
      'DELETE FROM agent_sessions WHERE user_id = ?',
      'DELETE FROM focus_switches WHERE user_id = ?',
      'DELETE FROM tasks WHERE user_id = ?',
      'DELETE FROM project_paths WHERE user_id = ?',
      'DELETE FROM projects WHERE user_id = ?',
      'DELETE FROM api_keys WHERE user_id = ?',
      'DELETE FROM users WHERE id = ?',
    ].map((sql) => db.prepare(sql).bind(userId)),
  );
}

// ───────────── API-ключі ─────────────

export const KEY_PREFIX = 'tk_';
const MAX_KEYS = 20;

export async function createApiKey(
  db: D1Database,
  userId: string,
  name: string,
  scope: KeyScope,
  now: number,
): Promise<{ key: string; info: ApiKey }> {
  if (scope !== 'full' && scope !== 'hooks') throw new TimerError('scope: full | hooks');
  const n = await db.prepare('SELECT COUNT(*) AS n FROM api_keys WHERE user_id = ? AND revoked_at IS NULL').bind(userId).first<{ n: number }>();
  if ((n?.n ?? 0) >= MAX_KEYS) throw new TimerError(`Щонайбільше ${MAX_KEYS} активних ключів — відкличте зайві`, 429);
  const key = `${KEY_PREFIX}${randomToken(32)}`;
  const id = crypto.randomUUID();
  const clean = (name || 'Claude Code').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Claude Code';
  await db
    .prepare('INSERT INTO api_keys (id, user_id, name, prefix, hash, scope, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, userId, clean, key.slice(0, KEY_PREFIX.length + 6), await sha256(key), scope, now)
    .run();
  return { key, info: { id, name: clean, prefix: key.slice(0, KEY_PREFIX.length + 6), scope, created_at: now, last_used_at: null } };
}

export async function listApiKeys(db: D1Database, userId: string): Promise<ApiKey[]> {
  return (
    await db
      .prepare('SELECT id, name, prefix, scope, created_at, last_used_at FROM api_keys WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC')
      .bind(userId)
      .all<ApiKey>()
  ).results;
}

export async function revokeApiKey(db: D1Database, userId: string, id: string, now: number): Promise<void> {
  const r = await db.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL').bind(now, id, userId).run();
  if ((r.meta.changes ?? 0) === 0) throw new TimerError('Ключ не знайдено', 404);
}

/**
 * Користувач за ключем «tk_…», якщо ключ має потрібні права: hooks-ключ годиться лише для хуків.
 * last_used_at оновлюємо не частіше разу на годину, щоб не писати на кожен хук.
 */
export async function userFromApiKey(db: D1Database, key: string, now: number, need: KeyScope = 'full'): Promise<User | null> {
  if (!key.startsWith(KEY_PREFIX) || key.length > 200) return null;
  const row = await db
    .prepare('SELECT id, user_id, scope, last_used_at FROM api_keys WHERE hash = ? AND revoked_at IS NULL')
    .bind(await sha256(key))
    .first<{ id: string; user_id: string; scope: KeyScope; last_used_at: number | null }>();
  if (!row || (need === 'full' && row.scope !== 'full')) return null;
  if (!row.last_used_at || now - row.last_used_at > 3600_000) {
    await db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').bind(now, row.id).run();
  }
  return getUser(db, row.user_id);
}

export function bearer(request: Request): string | null {
  const h = request.headers.get('authorization') ?? '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

// ───────────── GitHub OAuth (вхід у веб) ─────────────

export const OAUTH_STATE_COOKIE = '__Host-timer_oauth';

/**
 * Куди повернутися після входу: лише шлях цього сайту. Браузер викидає з URL табуляції й переноси
 * («/\t/evil.com» → «//evil.com»), тому керівні символи, пробіли й «\\» відкидаємо, а результат
 * перевіряємо розбором відносно умовного origin.
 */
export function safeNext(next: string | null | undefined): string {
  if (!next || next.length > 2000 || !next.startsWith('/') || /[\u0000-\u0020\u007f\\]/.test(next)) return '/';
  try {
    const u = new URL(next, 'https://origin.invalid');
    if (u.origin !== 'https://origin.invalid') return '/';
    return u.pathname + u.search + u.hash;
  } catch {
    return '/';
  }
}

export async function githubExchange(code: string, clientId: string, clientSecret: string, redirectUri: string): Promise<GithubProfile> {
  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri }),
  });
  const token = (await tokenRes.json().catch(() => ({}))) as { access_token?: string; error?: string };
  if (!token.access_token) throw new TimerError(`GitHub не видав токен: ${token.error ?? tokenRes.status}`, 401);
  const userRes = await fetch('https://api.github.com/user', {
    headers: { authorization: `Bearer ${token.access_token}`, accept: 'application/vnd.github+json', 'user-agent': 'timer' },
  });
  if (!userRes.ok) throw new TimerError(`GitHub не віддав профіль: ${userRes.status}`, 401);
  const u = (await userRes.json()) as GithubProfile;
  if (typeof u.id !== 'number' || typeof u.login !== 'string') throw new TimerError('Дивна відповідь GitHub', 502);
  return { id: u.id, login: u.login, name: u.name ?? null, avatar_url: u.avatar_url ?? null };
}

// ───────────── Google ─────────────

export interface GoogleProfile {
  sub: string;
  email: string | null;
  name: string | null;
  picture: string | null;
}

/** Обмін коду на профіль: токен → userinfo OpenID (без розбору id_token — профіль іде прямо від Google по TLS). */
export async function googleExchange(code: string, clientId: string, clientSecret: string, redirectUri: string): Promise<GoogleProfile> {
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' }),
  });
  const token = (await tokenRes.json().catch(() => ({}))) as { access_token?: string; error?: string };
  if (!token.access_token) throw new TimerError(`Google не видав токен: ${token.error ?? tokenRes.status}`, 401);
  const res = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { authorization: `Bearer ${token.access_token}` } });
  if (!res.ok) throw new TimerError(`Google не віддав профіль: ${res.status}`, 401);
  const u = (await res.json()) as { sub?: string; email?: string; email_verified?: boolean; name?: string; picture?: string };
  if (typeof u.sub !== 'string' || !u.sub) throw new TimerError('Дивна відповідь Google', 502);
  return {
    sub: u.sub,
    email: u.email && u.email_verified !== false ? u.email.slice(0, 320) : null,
    name: u.name?.slice(0, 200) ?? null,
    picture: u.picture?.startsWith('https://') ? u.picture.slice(0, 1000) : null,
  };
}

/**
 * Вхід через Google: знайомий sub → той користувач; новий → новий акаунт.
 * За поштою з GitHub-акаунтом НЕ зливаємо: прив'язка — лише свідомо, з «Налаштувань».
 */
export async function loginGoogleUser(db: D1Database, g: GoogleProfile, tz: string, now: number): Promise<User> {
  const existing = await db.prepare('SELECT * FROM users WHERE google_sub = ?').bind(g.sub).first<User>();
  if (existing) {
    await db
      .prepare('UPDATE users SET google_email = ?, name = COALESCE(name, ?), avatar_url = COALESCE(avatar_url, ?), last_login_at = ? WHERE id = ?')
      .bind(g.email, g.name, g.picture, now, existing.id)
      .run();
    return (await getUser(db, existing.id))!;
  }
  const id = crypto.randomUUID();
  await db
    .prepare(
      'INSERT INTO users (id, github_id, login, name, avatar_url, timezone, note_from_prompt, created_at, last_login_at, google_sub, google_email) VALUES (?, NULL, NULL, ?, ?, ?, 0, ?, ?, ?, ?)',
    )
    .bind(id, g.name ?? g.email, g.picture, validTimezone(tz) ? tz : 'UTC', now, now, g.sub, g.email)
    .run();
  return (await getUser(db, id))!;
}

/** Прив'язати Google до користувача. Цей Google уже в іншому акаунті — 409 (зливати акаунти не будемо мовчки). */
export async function linkGoogle(db: D1Database, userId: string, g: GoogleProfile): Promise<User> {
  const other = await db.prepare('SELECT id FROM users WHERE google_sub = ? AND id != ?').bind(g.sub, userId).first<{ id: string }>();
  if (other) throw new TimerError('Цей акаунт Google уже прив’язаний до іншого користувача трекера', 409);
  await db
    .prepare('UPDATE users SET google_sub = ?, google_email = ?, name = COALESCE(name, ?), avatar_url = COALESCE(avatar_url, ?) WHERE id = ?')
    .bind(g.sub, g.email, g.name, g.picture, userId)
    .run();
  return (await getUser(db, userId))!;
}

/** Прив'язати GitHub до користувача (напр. того, хто зайшов через Google). */
export async function linkGithub(db: D1Database, userId: string, gh: GithubProfile): Promise<User> {
  const other = await db.prepare('SELECT id FROM users WHERE github_id = ? AND id != ?').bind(gh.id, userId).first<{ id: string }>();
  if (other) throw new TimerError('Цей акаунт GitHub уже прив’язаний до іншого користувача трекера', 409);
  await db
    .prepare('UPDATE users SET github_id = ?, login = ?, name = COALESCE(name, ?), avatar_url = COALESCE(avatar_url, ?) WHERE id = ?')
    .bind(gh.id, gh.login, gh.name, gh.avatar_url, userId)
    .run();
  return (await getUser(db, userId))!;
}

/** Відв'язати спосіб входу. Останній відв'язати не можна — інакше в акаунт не увійти. */
export async function unlinkProvider(db: D1Database, userId: string, provider: 'google' | 'github'): Promise<User> {
  const u = await getUser(db, userId);
  if (!u) throw new TimerError('Користувача не знайдено', 404);
  const other = provider === 'google' ? u.github_id !== null : u.google_sub !== null;
  if (!other) throw new TimerError('Це єдиний спосіб входу — спершу прив’яжіть інший', 409);
  if (provider === 'google') await db.prepare('UPDATE users SET google_sub = NULL, google_email = NULL WHERE id = ?').bind(userId).run();
  else await db.prepare('UPDATE users SET github_id = NULL WHERE id = ?').bind(userId).run();
  return (await getUser(db, userId))!;
}
