import { AuthorizationError, CimdFetchError, OAuthProvider, type ConsentDescription } from '@cloudflare/workers-oauth-provider';
import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Mode } from './allocate';
import { handleMcp } from './mcp';
import {
  TimerError,
  addProjectPath,
  closeStale,
  createEntry,
  createProject,
  createTask,
  deleteEntry,
  dayTimeline,
  deleteTask,
  getTask,
  handleHook,
  listEntries,
  listProjects,
  listRunning,
  listTasks,
  listWaiting,
  stopSession,
  mergeProjects,
  removeProjectPath,
  report,
  startManual,
  stopManual,
  switchTo,
  updateEntry,
  updateProject,
  updateTask,
  type HookInput,
  type Scope,
  type TaskStatus,
} from './service';
import { PERIODS, parseInstant, periodRange, type Period } from './time';
import {
  OAUTH_STATE_COOKIE,
  bearer,
  bumpSessionEpoch,
  clearSessionCookie,
  createApiKey,
  deleteUser,
  getUser,
  githubExchange,
  googleExchange,
  linkGithub,
  linkGoogle,
  loginGoogleUser,
  unlinkProvider,
  listApiKeys,
  makeSessionCookie,
  randomToken,
  readCookie,
  revokeApiKey,
  safeNext,
  sign,
  updateSettings,
  upsertGithubUser,
  userFromApiKey,
  userFromSession,
  verify,
  type User,
} from './users';

type AppEnv = { Bindings: Env; Variables: { user: User; viaCookie: boolean } };
const app = new Hono<AppEnv>();

/** Дані поточного користувача. */
const S = (c: Context<AppEnv>): Scope => ({ db: c.env.DB, uid: c.get('user').id });
const tz = (c: Context<AppEnv>) => c.get('user').timezone || 'Europe/Kyiv';
const base = (env: Env) => env.PUBLIC_URL.replace(/\/+$/, '');

// ───────────── Мова відповідей: uk або en ─────────────
// Веб-інтерфейс шле x-lang і ставить cookie lang; сторінки входу без них дивляться на мову браузера.
// Без жодної ознаки (хуки, MCP-клієнти) — українська, як і раніше.
type Lang = 'uk' | 'en';
function langOf(c: Context<AppEnv>): Lang {
  const h = c.req.header('x-lang');
  if (h === 'uk' || h === 'en') return h;
  const k = readCookie(c.req.raw, 'lang');
  if (k === 'uk' || k === 'en') return k;
  const al = c.req.header('accept-language');
  if (al) return /(^|,)\s*uk\b/i.test(al) ? 'uk' : 'en';
  return 'uk';
}
const T = (c: Context<AppEnv>, uk: string, en: string) => (langOf(c) === 'en' ? en : uk);
const errText = (c: Context<AppEnv>, e: TimerError) => (langOf(c) === 'en' && e.en) || e.message;

app.onError((err, c) => {
  if (err instanceof TimerError) return c.json({ error: errText(c, err) }, err.status as ContentfulStatusCode);
  if (err instanceof SyntaxError) return c.json({ error: T(c, 'Некоректний JSON', 'Invalid JSON') }, 400);
  console.error(err);
  return c.json({ error: 'Internal error' }, 500);
});

// Обмеження частоти: LIMITER — на користувача, IP_LIMITER — на IP для анонімних шляхів і невдалих входів.
type Limiter = { limit(o: { key: string }): Promise<{ success: boolean }> };
async function limited(env: Env, key: string, binding: 'LIMITER' | 'IP_LIMITER' = 'LIMITER'): Promise<boolean> {
  const limiter = (env as unknown as Record<string, Limiter | undefined>)[binding];
  if (!limiter) return false;
  return !(await limiter.limit({ key })).success;
}

const ip = (request: Request) => request.headers.get('cf-connecting-ip') ?? 'unknown';

// ───────────── Вхід через GitHub і Google; прив'язка другого способу входу ─────────────

type Provider = 'github' | 'google';

interface OAuthState {
  p: 'oauth';
  /** Провайдер — щоб стан від GitHub не прийняв колбек Google і навпаки. */
  v: Provider;
  s: string;
  n: string;
  tz: string;
  e: number;
  /** Прив'язка: id користувача, до якого додаємо цей спосіб входу. */
  l?: string;
}

const configured = (env: Env, v: Provider) =>
  v === 'github' ? !!(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) : !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
const NAMES: Record<Provider, string> = { github: 'GitHub', google: 'Google' };

async function startOAuth(c: Context<AppEnv>, v: Provider): Promise<Response> {
  if (!configured(c.env, v)) return c.text(T(c, `Вхід через ${NAMES[v]} ще не налаштований`, `Sign-in with ${NAMES[v]} is not configured yet`), 503);
  const now = Date.now();
  const link = c.req.query('link') === '1';
  let linkTo: string | undefined;
  if (link) {
    const me = await userFromSession(c.env.DB, c.env.SESSION_SECRET, c.req.raw, now);
    if (!me)
      return c.html(
        page(
          T(c, 'Спершу увійдіть', 'Sign in first'),
          T(c, `<p>Щоб прив’язати ${NAMES[v]}, увійдіть у трекер.</p><p><a class="btn" href="/">На головну</a></p>`, `<p>To link ${NAMES[v]}, sign in to the tracker.</p><p><a class="btn" href="/">Home</a></p>`),
          langOf(c),
        ),
        401,
      );
    linkTo = me.id;
  }
  const state = randomToken(16);
  const next = safeNext(c.req.query('next') ?? (link ? '/#settings' : '/'));
  const zone = (c.req.query('tz') ?? '').slice(0, 64);
  const cookie = await sign(c.env.SESSION_SECRET, { p: 'oauth', v, s: state, n: next, tz: zone, e: now + 10 * 60_000, l: linkTo } satisfies OAuthState);
  const redirect = `${base(c.env)}/auth/${v}/callback`;
  const url =
    v === 'github' ? new URL('https://github.com/login/oauth/authorize') : new URL('https://accounts.google.com/o/oauth2/v2/auth');
  if (v === 'github') {
    url.searchParams.set('client_id', c.env.GITHUB_CLIENT_ID);
    url.searchParams.set('scope', 'read:user');
    url.searchParams.set('allow_signup', 'true');
  } else {
    url.searchParams.set('client_id', c.env.GOOGLE_CLIENT_ID!);
    url.searchParams.set('scope', 'openid email profile');
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('prompt', 'select_account');
  }
  url.searchParams.set('redirect_uri', redirect);
  url.searchParams.set('state', state);
  return new Response(null, {
    status: 302,
    headers: {
      location: url.toString(),
      'set-cookie': `${OAUTH_STATE_COOKIE}=${cookie}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
      'cache-control': 'no-store',
    },
  });
}

async function finishOAuth(c: Context<AppEnv>, v: Provider): Promise<Response> {
  const now = Date.now();
  const st = await verify<OAuthState>(c.env.SESSION_SECRET, readCookie(c.req.raw, OAUTH_STATE_COOKIE));
  const code = c.req.query('code');
  const lang = langOf(c);
  const retry = T(
    c,
    `<p><a class="btn" href="/auth/${v}">Спробувати ще раз</a> <a class="btn" href="/">На головну</a></p>`,
    `<p><a class="btn" href="/auth/${v}">Try again</a> <a class="btn" href="/">Home</a></p>`,
  );
  if (!configured(c.env, v)) return c.text(T(c, `Вхід через ${NAMES[v]} ще не налаштований`, `Sign-in with ${NAMES[v]} is not configured yet`), 503);
  if (c.req.query('error'))
    return c.html(page(T(c, 'Вхід скасовано', 'Sign-in cancelled'), T(c, `<p>${NAMES[v]} не підтвердив вхід.</p>`, `<p>${NAMES[v]} did not confirm the sign-in.</p>`) + retry, lang), 400);
  if (!st || st.p !== 'oauth' || st.v !== v || typeof st.s !== 'string' || st.s.length < 16 || st.e < now || !code || c.req.query('state') !== st.s) {
    return c.html(
      page(T(c, 'Вхід не вдався', 'Sign-in failed'), T(c, '<p>Посилання застаріло або відкрите в іншому браузері.</p>', '<p>The link has expired or was opened in another browser.</p>') + retry, lang),
      400,
    );
  }
  const redirect = `${base(c.env)}/auth/${v}/callback`;
  const headers = new Headers({ location: safeNext(st.n), 'cache-control': 'no-store' });
  headers.append('set-cookie', `${OAUTH_STATE_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
  try {
    if (st.l) {
      // Прив'язка: та сама людина, що почала, має бути й зараз у сесії.
      const me = await userFromSession(c.env.DB, c.env.SESSION_SECRET, c.req.raw, now);
      if (!me || me.id !== st.l)
        return c.html(page(T(c, 'Не вдалося прив’язати', 'Could not link'), T(c, '<p>Сесія змінилася — увійдіть і спробуйте ще раз.</p>', '<p>Your session changed — sign in and try again.</p>') + retry, lang), 400);
      if (v === 'google') await linkGoogle(c.env.DB, me.id, await googleExchange(code, c.env.GOOGLE_CLIENT_ID!, c.env.GOOGLE_CLIENT_SECRET!, redirect));
      else await linkGithub(c.env.DB, me.id, await githubExchange(code, c.env.GITHUB_CLIENT_ID, c.env.GITHUB_CLIENT_SECRET, redirect));
      return new Response(null, { status: 302, headers });
    }
    const user =
      v === 'google'
        ? await loginGoogleUser(c.env.DB, await googleExchange(code, c.env.GOOGLE_CLIENT_ID!, c.env.GOOGLE_CLIENT_SECRET!, redirect), st.tz, now)
        : await upsertGithubUser(c.env.DB, await githubExchange(code, c.env.GITHUB_CLIENT_ID, c.env.GITHUB_CLIENT_SECRET, redirect), c.env.OWNER_GITHUB_ID ?? '', st.tz, now);
    headers.append('set-cookie', await makeSessionCookie(c.env.SESSION_SECRET, user, now));
    return new Response(null, { status: 302, headers });
  } catch (e) {
    if (e instanceof TimerError) return c.html(page(T(c, 'Вхід не вдався', 'Sign-in failed'), `<p>${esc(errText(c, e))}</p>${retry}`, lang), e.status as ContentfulStatusCode);
    throw e;
  }
}

app.get('/auth/github', (c) => startOAuth(c, 'github'));
app.get('/auth/github/callback', (c) => finishOAuth(c, 'github'));
app.get('/auth/google', (c) => startOAuth(c, 'google'));
app.get('/auth/google/callback', (c) => finishOAuth(c, 'google'));
/** Які способи входу налаштовані — для кнопок на головній. */
app.get('/auth/providers', (c) => c.json({ github: configured(c.env, 'github'), google: configured(c.env, 'google') }));

// Лише для локальної розробки (PUBLIC_URL з http://): вхід без GitHub для тестів. У проді — 404.
app.get('/auth/dev', async (c) => {
  // Два замки: явний DEV_LOGIN=1 (лише в .dev.vars) і http у PUBLIC_URL (прод завжди https).
  if (String((c.env as unknown as { DEV_LOGIN?: string }).DEV_LOGIN) !== '1' || !base(c.env).startsWith('http://')) return c.notFound();
  const login = (c.req.query('login') ?? 'dev').replace(/[^a-z0-9-]/gi, '').slice(0, 39) || 'dev';
  let id = 0;
  for (const ch of login) id = (id * 31 + ch.charCodeAt(0)) % 1_000_000_000;
  const user = await upsertGithubUser(c.env.DB, { id: 900_000_000_000 + id, login, name: login, avatar_url: null }, c.env.OWNER_GITHUB_ID ?? '', 'Europe/Kyiv', Date.now());
  const cookie = await makeSessionCookie(c.env.SESSION_SECRET, user, Date.now());
  return new Response(JSON.stringify({ user: user.id, cookie: cookie.split(';')[0] }), { headers: { 'set-cookie': cookie, 'content-type': 'application/json' } });
});

// Лише для локальної розробки: вхід/прив'язка «Google» без Google — щоб тестувати логіку акаунтів. У проді — 404.
app.get('/auth/dev-google', async (c) => {
  if (String((c.env as unknown as { DEV_LOGIN?: string }).DEV_LOGIN) !== '1' || !base(c.env).startsWith('http://')) return c.notFound();
  const now = Date.now();
  const g = { sub: (c.req.query('sub') ?? 'g1').slice(0, 64), email: c.req.query('email') ?? null, name: c.req.query('name') ?? null, picture: null };
  if (c.req.query('link') === '1') {
    const me = await userFromSession(c.env.DB, c.env.SESSION_SECRET, c.req.raw, now);
    if (!me) return c.json({ error: 'not logged in' }, 401);
    const u = await linkGoogle(c.env.DB, me.id, g);
    return c.json({ user: u.id });
  }
  const user = await loginGoogleUser(c.env.DB, g, 'Europe/Kyiv', now);
  const cookie = await makeSessionCookie(c.env.SESSION_SECRET, user, now);
  return new Response(JSON.stringify({ user: user.id, cookie: cookie.split(';')[0] }), { headers: { 'set-cookie': cookie, 'content-type': 'application/json' } });
});

app.post('/auth/logout', async (c) => {
  if (crossSite(c)) return c.json({ error: 'Cross-site request blocked' }, 403);
  // Вихід гасить усі сесії користувача (і на інших пристроях), а не лише цю cookie.
  const user = await userFromSession(c.env.DB, c.env.SESSION_SECRET, c.req.raw, Date.now());
  if (user) await bumpSessionEpoch(c.env.DB, user.id);
  return new Response(null, { status: 204, headers: { 'set-cookie': clearSessionCookie } });
});

/**
 * Запит змінює дані з cookie з іншого сайту? Sec-Fetch-Site — у всіх сучасних браузерах;
 * без нього дивимось на Origin. Тіло (якщо є) має бути JSON: форму з чужого сайту так не надішлеш.
 */
function crossSite(c: Context<AppEnv>): boolean {
  const site = c.req.header('sec-fetch-site');
  if (site) return site !== 'same-origin' && site !== 'none';
  const origin = c.req.header('origin');
  return !!origin && origin !== base(c.env);
}

function unsafeBody(c: Context<AppEnv>): boolean {
  const len = Number(c.req.header('content-length') ?? '0');
  const type = (c.req.header('content-type') ?? '').split(';')[0].trim().toLowerCase();
  return (len > 0 || !!type) && type !== 'application/json';
}

// ───────────── Згода на доступ MCP-клієнта (OAuth /authorize) ─────────────

const esc = (v: string) => v.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

function page(title: string, body: string, lang: Lang = 'uk'): string {
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · timer</title><style>
:root{color-scheme:light dark;--bg:#F6F6F3;--card:#fff;--ink:#111110;--muted:#6E6E68;--ring:#E7E7E2}
@media (prefers-color-scheme:dark){:root{--bg:#121211;--card:#1B1B1A;--ink:#EDEDE8;--muted:#9A9A93;--ring:#2B2B29}}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif;display:grid;place-items:center;min-height:100vh;padding:16px;box-sizing:border-box}
main{background:var(--card);border-radius:16px;box-shadow:0 0 0 1px var(--ring);padding:28px;max-width:440px;width:100%}
h1{font-size:19px;margin:0 0 12px}p{margin:0 0 12px;color:var(--muted)}b{color:var(--ink)}
.btn{display:inline-flex;align-items:center;height:40px;padding:0 16px;border-radius:10px;border:0;background:var(--card);color:var(--ink);box-shadow:0 0 0 1px var(--ring);font:inherit;font-weight:500;cursor:pointer;text-decoration:none}
.btn.primary{background:var(--ink);color:var(--bg);box-shadow:none}.row{display:flex;gap:10px;margin-top:18px}.warn{color:#B4261A}
</style></head><body><main>${body}</main></body></html>`;
}

function consentPage(d: ConsentDescription, handle: string, user: User, lang: Lang): string {
  const form = (approve: string, deny: string) => `<form method="post"><input type="hidden" name="handle" value="${esc(handle)}">
<div class="row"><button class="btn primary" name="decision" value="approve">${approve}</button><button class="btn" name="decision" value="deny">${deny}</button></div></form>`;
  if (lang === 'en') {
    const who = d.clientDomain ? `An app from <b>${esc(d.clientDomain)}</b>.` : 'The app registered itself — its name is not verified.';
    return page(
      'Tracker access',
      `<h1>Give “${esc(d.clientName)}” access to your tracker?</h1>
<p>${who}</p>
<p>The token goes to <b>${esc(d.redirectHost)}</b>. It will be able to read and change your projects, tasks and time entries on behalf of <b>${esc(user.login ?? user.name ?? 'you')}</b>.</p>
${d.redirectIsLoopback ? '<p class="warn"><b>Access goes to an app on your computer.</b> Approve only if you just started the connection yourself.</p>' : ''}
${form('Allow', 'Deny')}`,
      'en',
    );
  }
  const who = d.clientDomain ? `Застосунок від <b>${esc(d.clientDomain)}</b>.` : 'Застосунок зареєструвався сам — його назва не перевірена.';
  return page(
    'Доступ до трекера',
    `<h1>Дати «${esc(d.clientName)}» доступ до вашого трекера?</h1>
<p>${who}</p>
<p>Токен отримає <b>${esc(d.redirectHost)}</b>. Він зможе читати й змінювати ваші проєкти, задачі й записи часу від імені <b>${esc(user.login ?? user.name ?? 'вас')}</b>.</p>
${d.redirectIsLoopback ? '<p class="warn"><b>Доступ піде застосунку на вашому комп’ютері.</b> Погоджуйтеся, лише якщо ви щойно самі почали підключення.</p>' : ''}
${form('Дозволити', 'Відмовити')}`,
  );
}

async function authorize(c: Context<AppEnv>): Promise<Response> {
  const oauth = c.env.OAUTH_PROVIDER;
  const now = Date.now();
  const user = await userFromSession(c.env.DB, c.env.SESSION_SECRET, c.req.raw, now);
  try {
    if (c.req.method === 'GET') {
      // Спершу перевіряємо запит клієнта — і лише потім просимо увійти.
      const request = await oauth.parseAuthRequest(c.req.raw);
      if (!user) {
        const u = new URL(c.req.url);
        return c.redirect(`/auth/github?next=${encodeURIComponent(u.pathname + u.search)}`, 302);
      }
      const details = await oauth.describeConsent(request);
      const consent = await oauth.beginConsent(request);
      consent.headers.set('content-type', 'text/html; charset=utf-8');
      return new Response(consentPage(details, consent.handle, user, langOf(c)), { headers: consent.headers });
    }
    if (!user)
      return c.html(page(T(c, 'Сесія закінчилась', 'Session expired'), T(c, '<p>Увійдіть ще раз і повторіть підключення в застосунку.</p>', '<p>Sign in again and repeat the connection in the app.</p>'), langOf(c)), 401);
    const form = await c.req.formData();
    const handle = String(form.get('handle') ?? '');
    if (form.get('decision') !== 'approve') {
      const denied = await oauth.denyConsent(c.req.raw, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    const approved = await oauth.approveConsent(c.req.raw, handle);
    const { redirectTo } = await oauth.completeAuthorization({
      request: approved.request,
      userId: user.id,
      metadata: {},
      scope: approved.request.scope,
      props: { userId: user.id },
    });
    approved.headers.set('location', redirectTo);
    return new Response(null, { status: 302, headers: approved.headers });
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
    if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
      const msg = error instanceof AuthorizationError ? error.description : T(c, 'Застосунок не вдалося перевірити.', 'The app could not be verified.');
      return c.html(
        page(
          T(c, 'Підключення не вдалося', 'Connection failed'),
          `<p>${esc(msg ?? T(c, 'Помилка запиту', 'Request error'))}</p>${T(c, '<p>Почніть підключення в застосунку ще раз.</p>', '<p>Start the connection in the app again.</p>')}`,
          langOf(c),
        ),
        400,
      );
    }
    throw error;
  }
}

app.get('/authorize', authorize);
app.post('/authorize', authorize);

// ───────────── Хуки Claude Code ─────────────
// Завжди 204 з порожнім тілом: для UserPromptSubmit текст відповіді потрапив би в контекст агента,
// а помилка трекера не повинна заважати роботі. Автентифікація — API-ключ у Authorization: Bearer.
app.post('/hooks/claude', async (c) => {
  try {
    const now = Date.now();
    const key = bearer(c.req.raw);
    // Хуки приймають і hooks-ключ (той, що лежить у env агента), і повний.
    const user = key ? await userFromApiKey(c.env.DB, key, now, 'hooks') : null;
    if (!user) {
      console.warn(JSON.stringify({ hook: 'unauthorized' }));
      await limited(c.env, `fail:${ip(c.req.raw)}`, 'IP_LIMITER');
      return c.body(null, 204);
    }
    if (await limited(c.env, `hook:${user.id}`)) return c.body(null, 204);
    const input = (await c.req.json()) as HookInput;
    if (!input || typeof input !== 'object') return c.body(null, 204);
    // Корінь проєкту, якщо хук передав CLAUDE_PROJECT_DIR у заголовку (див. claude/settings.hooks.json).
    const projectDir = c.req.header('x-project-dir')?.trim();
    if (projectDir?.startsWith('/')) input.project_dir = projectDir;
    const result = await handleHook({ db: c.env.DB, uid: user.id }, input, now, { noteFromPrompt: user.note_from_prompt === 1 });
    console.log(JSON.stringify({ hook: input.hook_event_name, user: user.id.slice(0, 8), result }));
  } catch (e) {
    console.error('hook failed', e);
  }
  return c.body(null, 204);
});

// ───────────── Автентифікація API: cookie сесії (веб) або API-ключ (скрипти) ─────────────

app.use('/api/*', async (c, next) => {
  const now = Date.now();
  const key = bearer(c.req.raw);
  let user: User | null = null;
  if (key) user = await userFromApiKey(c.env.DB, key, now);
  else user = await userFromSession(c.env.DB, c.env.SESSION_SECRET, c.req.raw, now);
  if (!user) {
    if (key && (await limited(c.env, `fail:${ip(c.req.raw)}`, 'IP_LIMITER'))) return c.json({ error: T(c, 'Забагато запитів', 'Too many requests') }, 429);
    return c.json({ error: 'Unauthorized', login: '/auth/github' }, 401);
  }
  // CSRF: з cookie змінювати дані можна лише з цього ж сайту і лише JSON-тілом.
  if (!key && !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && (crossSite(c) || unsafeBody(c))) {
    return c.json({ error: 'Cross-site request blocked' }, 403);
  }
  if (await limited(c.env, `api:${user.id}`)) return c.json({ error: T(c, 'Забагато запитів, спробуйте за хвилину', 'Too many requests, try again in a minute') }, 429);
  c.set('user', user);
  c.set('viaCookie', !key);
  await next();
});

// ───────────── REST API для веб-інтерфейсу ─────────────
const api = new Hono<AppEnv>();

function num(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new TimerError(`Очікувалось число: ${v}`, 400, `Expected a number: ${v}`);
  return n;
}

function instant(v: unknown, zone: string): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  try {
    return parseInstant(v as string | number, zone);
  } catch (e) {
    throw new TimerError((e as Error).message);
  }
}

function rangeFromQuery(q: Record<string, string>, zone: string, now: number) {
  if (q.from || q.to) {
    return {
      from: instant(q.from, zone) ?? periodRange('today', now, zone).from,
      to: instant(q.to, zone) ?? now,
    };
  }
  const period = (q.period || 'today') as Period;
  if (!PERIODS.includes(period)) throw new TimerError(`period: ${PERIODS.join(' | ')}`);
  return periodRange(period, now, zone);
}

api.get('/config', (c) => c.json({ timezone: tz(c), long_running_hours: Number(c.env.LONG_RUNNING_HOURS || 8) }));

api.get('/running', async (c) => c.json({ now: Date.now(), entries: await listRunning(S(c)) }));

// Екран «Зараз»: хто працює, хто чекає на вас, шкала сьогоднішнього дня.
api.get('/now', async (c) => {
  const now = Date.now();
  const zone = tz(c);
  const { from, to } = periodRange('today', now, zone);
  const [running, waiting, today] = await Promise.all([
    listRunning(S(c)),
    listWaiting(S(c)),
    dayTimeline(S(c), from, to, now),
  ]);
  return c.json({ now, timezone: zone, running, waiting, today });
});

// ── Проєкти
api.get('/projects', async (c) => c.json(await listProjects(S(c), c.req.query('archived') === '1')));

api.post('/projects', async (c) => {
  const body = await c.req.json<{ name: string; path?: string; color?: string }>();
  return c.json(await createProject(S(c), body, Date.now()), 201);
});

api.patch('/projects/:id', async (c) => {
  const body = await c.req.json<{ name?: string; color?: string | null; archived?: boolean }>();
  return c.json(await updateProject(S(c), c.req.param('id'), body, Date.now()));
});

api.post('/projects/:id/paths', async (c) => {
  const { path } = await c.req.json<{ path: string }>();
  return c.json(await addProjectPath(S(c), c.req.param('id'), String(path ?? '')));
});

api.delete('/projects/:id/paths', async (c) => c.json(await removeProjectPath(S(c), c.req.param('id'), c.req.query('path') ?? '')));

api.post('/projects/:id/merge', async (c) => {
  const { into } = await c.req.json<{ into: string }>();
  return c.json(await mergeProjects(S(c), c.req.param('id'), into, Date.now()));
});

type StartBody = { note?: string; task_id?: string };
const startBody = (c: { req: { json: <T>() => Promise<T> } }) => c.req.json<StartBody>().catch(() => ({}) as StartBody);

api.post('/projects/:id/start', async (c) => {
  const b = await startBody(c);
  return c.json(await startManual(S(c), c.req.param('id'), b.note ?? null, Date.now(), b.task_id || null), 201);
});

api.post('/projects/:id/switch', async (c) => {
  const b = await startBody(c);
  return c.json(await switchTo(S(c), c.req.param('id'), b.note ?? null, Date.now(), b.task_id || null), 201);
});

api.post('/projects/:id/stop', async (c) => c.json(await stopManual(S(c), Date.now(), c.req.param('id'))));

// Зупинити сесію агента з вебу (і прибрати її з «Чекають на вас»).
api.post('/sessions/:id/stop', async (c) => c.json(await stopSession(S(c), c.req.param('id'), Date.now())));

api.post('/stop-all', async (c) => c.json(await stopManual(S(c), Date.now())));

// ── Задачі
const STATUSES = ['open', 'done', 'all'] as const;

api.get('/tasks', async (c) => {
  const status = (c.req.query('status') || 'open') as (typeof STATUSES)[number];
  if (!STATUSES.includes(status)) throw new TimerError('status: open | done | all');
  return c.json(await listTasks(S(c), { projectId: c.req.query('project_id') || undefined, status }, Date.now()));
});

api.post('/projects/:id/tasks', async (c) => {
  const b = await c.req.json<{ title: string; notes?: string; external_ref?: string }>();
  return c.json(await createTask(S(c), { project_id: c.req.param('id'), ...b }, Date.now()), 201);
});

api.get('/tasks/:id', async (c) => c.json(await getTask(S(c), c.req.param('id'), Date.now())));

api.patch('/tasks/:id', async (c) => {
  const b = await c.req.json<{ title?: string; notes?: string | null; external_ref?: string | null; status?: TaskStatus }>();
  return c.json(await updateTask(S(c), c.req.param('id'), b, Date.now()));
});

api.delete('/tasks/:id', async (c) => {
  await deleteTask(S(c), c.req.param('id'), Date.now());
  return c.body(null, 204);
});

// ── Записи
api.get('/entries', async (c) => {
  const now = Date.now();
  const { from, to } = rangeFromQuery(c.req.query(), tz(c), now);
  const filter = { projectId: c.req.query('project_id') || undefined, taskId: c.req.query('task_id') || undefined };
  return c.json({ from, to, now, ...(await listEntries(S(c), from, to, filter)) });
});

api.post('/entries', async (c) => {
  const b = await c.req.json<Record<string, unknown>>();
  const zone = tz(c);
  const start = instant(b.start, zone);
  if (start === undefined) throw new TimerError('Потрібен start', 400, 'start is required');
  return c.json(
    await createEntry(
      S(c),
      {
        project_id: String(b.project_id ?? ''),
        task_id: (b.task_id as string) || null,
        start,
        stop: instant(b.stop, zone),
        duration_ms: num(b.duration_ms),
        note: (b.note as string) ?? null,
      },
      Date.now(),
    ),
    201,
  );
});

api.patch('/entries/:id', async (c) => {
  const b = await c.req.json<Record<string, unknown>>();
  const zone = tz(c);
  return c.json(
    await updateEntry(
      S(c),
      c.req.param('id'),
      {
        start: instant(b.start, zone),
        stop: instant(b.stop, zone),
        duration_ms: num(b.duration_ms),
        note: b.note === undefined ? undefined : ((b.note as string) ?? null),
        project_id: (b.project_id as string) || undefined,
        task_id: b.task_id === undefined ? undefined : ((b.task_id as string) || null),
      },
      Date.now(),
    ),
  );
});

api.delete('/entries/:id', async (c) => {
  await deleteEntry(S(c), c.req.param('id'));
  return c.body(null, 204);
});

api.get('/report', async (c) => {
  const now = Date.now();
  const q = c.req.query();
  const zone = tz(c);
  const { from, to } = rangeFromQuery({ period: 'this_week', ...q }, zone, now);
  const mode = (q.mode as Mode) || 'full';
  if (!['full', 'split', 'focus'].includes(mode)) throw new TimerError('mode: full | split | focus');
  return c.json(await report(S(c), { from, to, mode, tz: zone, projectId: q.project_id || undefined }, now));
});

// ── Акаунт, налаштування, ключі
api.get('/me', async (c) => {
  const u = c.get('user');
  return c.json({
    user: { id: u.id, login: u.login, name: u.name, avatar_url: u.avatar_url, timezone: u.timezone, note_from_prompt: u.note_from_prompt === 1 },
    // Способи входу: що прив'язано і що взагалі налаштовано на сервері.
    logins: {
      github: u.github_id !== null ? { login: u.login } : null,
      google: u.google_sub !== null ? { email: u.google_email } : null,
      available: { github: configured(c.env, 'github'), google: configured(c.env, 'google') },
    },
    mcp_url: `${base(c.env)}/mcp`,
    hooks_url: `${base(c.env)}/hooks/claude`,
    keys: await listApiKeys(c.env.DB, u.id),
  });
});

api.patch('/me', async (c) => {
  const b = await c.req.json<{ timezone?: string; note_from_prompt?: boolean }>();
  const u = await updateSettings(c.env.DB, c.get('user').id, { timezone: b.timezone, note_from_prompt: b.note_from_prompt });
  return c.json({ timezone: u.timezone, note_from_prompt: u.note_from_prompt === 1 });
});

api.delete('/me', async (c) => {
  // Лише з вебу і з підтвердженням логіном — щоб ключ із хуків не міг стерти акаунт.
  if (!c.get('viaCookie')) throw new TimerError('Видалити акаунт можна лише з вебу', 403, 'The account can only be deleted from the web app');
  const b = await c.req.json<{ confirm?: string }>().catch(() => ({}) as { confirm?: string });
  const u = c.get('user');
  const ok = [u.login, u.google_email, u.id].filter(Boolean).map((x) => x!.toLowerCase());
  if (!b.confirm || !ok.includes(b.confirm.trim().toLowerCase())) throw new TimerError('Підтвердіть видалення своїм логіном GitHub або поштою Google', 400, 'Confirm the deletion with your GitHub login or Google email');
  await deleteUser(c.env.DB, u.id);
  return new Response(null, { status: 204, headers: { 'set-cookie': clearSessionCookie } });
});

api.post('/me/unlink', async (c) => {
  if (!c.get('viaCookie')) throw new TimerError('Лише з вебу', 403, 'Web app only');
  const b = await c.req.json<{ provider?: string }>().catch(() => ({}) as { provider?: string });
  if (b.provider !== 'google' && b.provider !== 'github') throw new TimerError('provider: google | github');
  await unlinkProvider(c.env.DB, c.get('user').id, b.provider);
  return c.body(null, 204);
});

api.post('/keys', async (c) => {
  if (!c.get('viaCookie')) throw new TimerError('Ключі створюються лише з вебу', 403, 'Keys can only be created from the web app');
  const b = await c.req.json<{ name?: string; scope?: 'full' | 'hooks' }>().catch(() => ({}) as { name?: string; scope?: 'full' | 'hooks' });
  return c.json(await createApiKey(c.env.DB, c.get('user').id, b.name ?? 'Claude Code', b.scope ?? 'full', Date.now()), 201);
});

api.delete('/keys/:id', async (c) => {
  if (!c.get('viaCookie')) throw new TimerError('Ключі відкликаються лише з вебу', 403, 'Keys can only be revoked from the web app');
  await revokeApiKey(c.env.DB, c.get('user').id, c.req.param('id'), Date.now());
  return c.body(null, 204);
});

app.route('/api', api);

// ───────────── MCP + OAuth ─────────────
// /mcp захищає OAuthProvider: токен із нашого OAuth (claude.ai, Claude Desktop) або API-ключ «tk_…» (Claude Code).

const mcpHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const props = (ctx as ExecutionContext & { props?: { userId?: string } }).props;
    const user = props?.userId ? await getUser(env.DB, props.userId) : null;
    if (!user) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'content-type': 'application/json' } });
    if (await limited(env, `mcp:${user.id}`)) return new Response(JSON.stringify({ error: 'Too many requests' }), { status: 429 });
    return handleMcp(request, env, ctx, { id: user.id, timezone: user.timezone });
  },
};

let provider: OAuthProvider<Env> | null = null;
function getProvider(env: Env): OAuthProvider<Env> {
  provider ??= new OAuthProvider<Env>({
    apiRoute: '/mcp',
    apiHandler: mcpHandler,
    defaultHandler: { fetch: (req, e, ctx) => app.fetch(req, e, ctx) },
    authorizeEndpoint: '/authorize',
    tokenEndpoint: '/oauth/token',
    clientRegistrationEndpoint: '/oauth/register',
    scopesSupported: ['timer'],
    resourceMetadata: { resource: `${base(env)}/mcp`, resource_name: 'timer' },
    clientIdMetadataDocumentEnabled: true,
    accessTokenTTL: 3600,
    resolveExternalToken: async ({ token, env: e }) => {
      // Лише повні ключі: hooks-ключ лежить у env агента і не повинен відкривати MCP.
      const user = await userFromApiKey(e.DB, token, Date.now(), 'full');
      return user ? { props: { userId: user.id }, audience: `${base(e)}/mcp` } : null;
    },
  });
  return provider;
}

/** Анонімні шляхи OAuth і входу — обмеження на IP, щоб їх не можна було засипати запитами. */
const ANON_LIMITED = /^\/(oauth\/|authorize|auth\/|\.well-known\/)/;

export default {
  async fetch(request, env, ctx) {
    if (ANON_LIMITED.test(new URL(request.url).pathname) && (await limited(env, `anon:${ip(request)}`, 'IP_LIMITER'))) {
      return new Response('Забагато запитів, спробуйте за хвилину', { status: 429, headers: { 'retry-after': '60' } });
    }
    return getProvider(env).fetch(request, env, ctx);
  },
  async scheduled(_controller, env, ctx) {
    const staleMs = Number(env.STALE_MINUTES || 20) * 60_000;
    ctx.waitUntil(
      closeStale(env.DB, Date.now(), staleMs).then((n) => {
        if (n > 0) console.log(JSON.stringify({ cron: 'closeStale', closed: n }));
      }),
    );
  },
} satisfies ExportedHandler<Env>;
