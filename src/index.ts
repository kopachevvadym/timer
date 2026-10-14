import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { verifyAccess } from './access';
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
  type TaskStatus,
} from './service';
import { PERIODS, parseInstant, periodRange, type Period } from './time';

const app = new Hono<{ Bindings: Env }>();

const tz = (env: Env) => env.TIMEZONE || 'Europe/Kyiv';

// Захист у глибину поверх Cloudflare Access (див. access.ts).
app.use('*', async (c, next) => {
  if (!(await verifyAccess(c.req.raw, c.env))) return c.json({ error: 'Unauthorized' }, 401);
  await next();
});

// CSRF: браузер на чужому сайті не повинен змінювати дані, навіть якщо надішле cookie Access.
// Браузери завжди додають Sec-Fetch-Site; Claude Code і curl — ні.
app.use('*', async (c, next) => {
  const site = c.req.header('sec-fetch-site');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && site && site !== 'same-origin' && site !== 'none') {
    return c.json({ error: 'Cross-site request blocked' }, 403);
  }
  await next();
});

app.onError((err, c) => {
  if (err instanceof TimerError) return c.json({ error: err.message }, err.status as ContentfulStatusCode);
  console.error(err);
  return c.json({ error: 'Internal error' }, 500);
});

// ───────────── Хуки Claude Code ─────────────
// Завжди 204 з порожнім тілом: для UserPromptSubmit текст відповіді потрапив би в контекст агента,
// а помилка трекера не повинна заважати роботі.
app.post('/hooks/claude', async (c) => {
  try {
    const input = (await c.req.json()) as HookInput;
    // Корінь проєкту, якщо хук передав CLAUDE_PROJECT_DIR у заголовку (див. claude/settings.hooks.json).
    const projectDir = c.req.header('x-project-dir')?.trim();
    if (projectDir?.startsWith('/')) input.project_dir = projectDir;
    const result = await handleHook(c.env.DB, input, Date.now(), { noteFromPrompt: String(c.env.NOTE_FROM_PROMPT) !== 'false' });
    console.log(JSON.stringify({ hook: input.hook_event_name, session: input.session_id?.slice(0, 8), result }));
  } catch (e) {
    console.error('hook failed', e);
  }
  return c.body(null, 204);
});

// ───────────── MCP ─────────────
app.all('/mcp', (c) => handleMcp(c.req.raw, c.env, c.executionCtx as ExecutionContext));

// ───────────── REST API для веб-інтерфейсу ─────────────
const api = new Hono<{ Bindings: Env }>();

function num(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new TimerError(`Очікувалось число: ${v}`);
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

api.get('/config', (c) => c.json({ timezone: tz(c.env), long_running_hours: Number(c.env.LONG_RUNNING_HOURS || 8) }));

api.get('/running', async (c) => c.json({ now: Date.now(), entries: await listRunning(c.env.DB) }));

// Екран «Зараз»: хто працює, хто чекає на вас, шкала сьогоднішнього дня.
api.get('/now', async (c) => {
  const now = Date.now();
  const zone = tz(c.env);
  const { from, to } = periodRange('today', now, zone);
  const [running, waiting, today] = await Promise.all([
    listRunning(c.env.DB),
    listWaiting(c.env.DB),
    dayTimeline(c.env.DB, from, to, now),
  ]);
  return c.json({ now, timezone: zone, running, waiting, today });
});

// ── Проєкти
api.get('/projects', async (c) => c.json(await listProjects(c.env.DB, c.req.query('archived') === '1')));

api.post('/projects', async (c) => {
  const body = await c.req.json<{ name: string; path?: string; color?: string }>();
  return c.json(await createProject(c.env.DB, body, Date.now()), 201);
});

api.patch('/projects/:id', async (c) => {
  const body = await c.req.json<{ name?: string; color?: string | null; archived?: boolean }>();
  return c.json(await updateProject(c.env.DB, c.req.param('id'), body, Date.now()));
});

api.post('/projects/:id/paths', async (c) => {
  const { path } = await c.req.json<{ path: string }>();
  return c.json(await addProjectPath(c.env.DB, c.req.param('id'), String(path ?? '')));
});

api.delete('/projects/:id/paths', async (c) => c.json(await removeProjectPath(c.env.DB, c.req.param('id'), c.req.query('path') ?? '')));

api.post('/projects/:id/merge', async (c) => {
  const { into } = await c.req.json<{ into: string }>();
  return c.json(await mergeProjects(c.env.DB, c.req.param('id'), into, Date.now()));
});

type StartBody = { note?: string; task_id?: string };
const startBody = (c: { req: { json: <T>() => Promise<T> } }) => c.req.json<StartBody>().catch(() => ({}) as StartBody);

api.post('/projects/:id/start', async (c) => {
  const b = await startBody(c);
  return c.json(await startManual(c.env.DB, c.req.param('id'), b.note ?? null, Date.now(), b.task_id || null), 201);
});

api.post('/projects/:id/switch', async (c) => {
  const b = await startBody(c);
  return c.json(await switchTo(c.env.DB, c.req.param('id'), b.note ?? null, Date.now(), b.task_id || null), 201);
});

api.post('/projects/:id/stop', async (c) => c.json(await stopManual(c.env.DB, Date.now(), c.req.param('id'))));

// Зупинити сесію агента з вебу (і прибрати її з «Чекають на вас»).
api.post('/sessions/:id/stop', async (c) => c.json(await stopSession(c.env.DB, c.req.param('id'), Date.now())));

api.post('/stop-all', async (c) => c.json(await stopManual(c.env.DB, Date.now())));

// ── Задачі
const STATUSES = ['open', 'done', 'all'] as const;

api.get('/tasks', async (c) => {
  const status = (c.req.query('status') || 'open') as (typeof STATUSES)[number];
  if (!STATUSES.includes(status)) throw new TimerError('status: open | done | all');
  return c.json(await listTasks(c.env.DB, { projectId: c.req.query('project_id') || undefined, status }, Date.now()));
});

api.post('/projects/:id/tasks', async (c) => {
  const b = await c.req.json<{ title: string; notes?: string; external_ref?: string }>();
  return c.json(await createTask(c.env.DB, { project_id: c.req.param('id'), ...b }, Date.now()), 201);
});

api.get('/tasks/:id', async (c) => c.json(await getTask(c.env.DB, c.req.param('id'), Date.now())));

api.patch('/tasks/:id', async (c) => {
  const b = await c.req.json<{ title?: string; notes?: string | null; external_ref?: string | null; status?: TaskStatus }>();
  return c.json(await updateTask(c.env.DB, c.req.param('id'), b, Date.now()));
});

api.delete('/tasks/:id', async (c) => {
  await deleteTask(c.env.DB, c.req.param('id'), Date.now());
  return c.body(null, 204);
});

// ── Записи
api.get('/entries', async (c) => {
  const now = Date.now();
  const { from, to } = rangeFromQuery(c.req.query(), tz(c.env), now);
  const filter = { projectId: c.req.query('project_id') || undefined, taskId: c.req.query('task_id') || undefined };
  return c.json({ from, to, now, ...(await listEntries(c.env.DB, from, to, filter)) });
});

api.post('/entries', async (c) => {
  const b = await c.req.json<Record<string, unknown>>();
  const zone = tz(c.env);
  const start = instant(b.start, zone);
  if (start === undefined) throw new TimerError('Потрібен start');
  return c.json(
    await createEntry(
      c.env.DB,
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
  const zone = tz(c.env);
  return c.json(
    await updateEntry(
      c.env.DB,
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
  await deleteEntry(c.env.DB, c.req.param('id'));
  return c.body(null, 204);
});

api.get('/report', async (c) => {
  const now = Date.now();
  const q = c.req.query();
  const zone = tz(c.env);
  const { from, to } = rangeFromQuery({ period: 'this_week', ...q }, zone, now);
  const mode = (q.mode as Mode) || 'full';
  if (!['full', 'split', 'focus'].includes(mode)) throw new TimerError('mode: full | split | focus');
  return c.json(await report(c.env.DB, { from, to, mode, tz: zone, projectId: q.project_id || undefined }, now));
});

app.route('/api', api);

export default {
  fetch: app.fetch,
  async scheduled(_controller, env, ctx) {
    const staleMs = Number(env.STALE_MINUTES || 20) * 60_000;
    ctx.waitUntil(
      closeStale(env.DB, Date.now(), staleMs).then((n) => {
        if (n > 0) console.log(JSON.stringify({ cron: 'closeStale', closed: n }));
      }),
    );
  },
} satisfies ExportedHandler<Env>;
