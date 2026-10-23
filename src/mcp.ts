/**
 * MCP-сервер (Streamable HTTP, без стану) на шляху /mcp.
 * Хуки відповідають «коли агент працював», MCP — «над чим» (проєкти й задачі) і «скільки всього».
 */
import { McpServer } from '@modelcontextprotocol/server';
import { createMcpHandler } from 'agents/mcp/server';
import { z } from 'zod';
import type { Mode } from './allocate';
import {
  TimerError,
  addProjectPath,
  createEntry,
  createProject,
  createTask,
  deleteEntry,
  deleteTask,
  findProjectByPath,
  getEntry,
  findProjectByRef,
  findTaskByRef,
  labelRunning,
  listEntries,
  listProjects,
  listRunning,
  listTasks,
  listWaiting,
  mergeProjects,
  isMcpSession,
  startMcpTimer,
  touchMcpTimers,
  normalizeRepo,
  isEphemeralPath,
  findProjectByRepo,
  setProjectRepo,
  removeProjectPath,
  report,
  resolveProject,
  startManual,
  startTask,
  stopManual,
  switchTo,
  updateEntry,
  updateProject,
  updateTask,
  type Project,
  type Scope,
  type TaskWithTime,
} from './service';
import { PERIODS, hm, parseInstant, periodRange, type Period } from './time';

const MODES = ['full', 'split', 'focus'] as const;

const TIME_HINT =
  'ISO 8601 зі зсувом (2026-10-14T10:00:00+03:00) або локальний час без зсуву (2026-10-14 10:00) — тоді в поясі трекера.';
const CWD_HINT = 'Ваша робоча директорія (абсолютний шлях). За нею трекер знаходить проєкт. Замість cwd можна передати project.';
const PROJECT_HINT = 'Назва або id проєкту. Якщо не задано — проєкт визначається за repo або cwd.';
const REPO_HINT =
  'Репозиторій: вивід `git remote get-url origin` або owner/name. Передавайте завжди, коли працюєте в git: за ним проєкт знаходиться з будь-якої папки чи клону (хмарні сесії).';

type ToolResult = { content: { type: 'text'; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };

function ok(text: string, data?: unknown): ToolResult {
  return {
    content: [{ type: 'text', text }],
    ...(data !== undefined ? { structuredContent: { result: data } } : {}),
  };
}

function fail(e: unknown): ToolResult {
  const msg = e instanceof TimerError || e instanceof Error ? e.message : String(e);
  return { content: [{ type: 'text', text: `Помилка: ${msg}` }], isError: true };
}

async function guard(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (e) {
    return fail(e);
  }
}

function fmtTime(ms: number, tz: string): string {
  return new Intl.DateTimeFormat('uk-UA', {
    timeZone: tz,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(ms));
}

/** Короткий id сесії Claude Code без префікса користувача. */
const rawSession = (id: string) => id.slice(id.indexOf(':') + 1, id.indexOf(':') + 9);

const STATUS_UA = { todo: 'до роботи', doing: 'в роботі', done: 'готово' } as const;

function taskLine(t: TaskWithTime, withProject = false): string {
  const ref = t.external_ref ? `${t.external_ref} · ` : '';
  const live = t.active_sessions > 0 ? ` · зараз працює агентів: ${t.active_sessions}` : '';
  return `- [${STATUS_UA[t.status]}] ${ref}${t.title}${withProject ? ` (${t.project_name})` : ''} · ${hm(t.spent_ms)} · id ${t.id}${live}`;
}

async function requireProject(db: Scope, ref: string): Promise<Project> {
  const p = await findProjectByRef(db, ref);
  if (!p) throw new TimerError(`Проєкт «${ref}» не знайдено. Подивіться список: timer_projects action=list`);
  return p;
}

type Where = { project?: string; cwd?: string; repo?: string };

/**
 * Проєкт за project → repo → cwd. create=true — створити за cwd, як це робить хук.
 * Хмарні сесії клонують репозиторій у тимчасові папки з різними назвами (/home/claude/alee-1718),
 * тож для них проєкт визначає repo, а не папка: інакше кожен клон ставав окремим проєктом.
 */
async function projectFrom(db: Scope, args: Where, now: number, create = false): Promise<Project> {
  const p = await locateProject(db, args, now, create);
  await touchMcpTimers(db, now, p.id);
  return p;
}

async function locateProject(db: Scope, args: Where, now: number, create: boolean): Promise<Project> {
  const repo = args.repo ? normalizeRepo(args.repo) : null;
  if (args.repo && !repo) throw new TimerError('repo: очікується owner/name або URL з git remote get-url origin');
  if (args.project) {
    const p = await requireProject(db, args.project);
    if (repo && !p.repo && !(await findProjectByRepo(db, repo))) return setProjectRepo(db, p.id, repo);
    return p;
  }
  if (repo) {
    const byRepo = await findProjectByRepo(db, repo);
    if (byRepo) {
      // Постійна папка на диску, ще ні до чого не прив'язана, — запам'ятовуємо: хуки знайдуть проєкт за нею.
      if (args.cwd && !isEphemeralPath(args.cwd) && !(await findProjectByPath(db, args.cwd))) {
        await addProjectPath(db, byRepo.id, args.cwd).catch(() => null);
      }
      return byRepo;
    }
  }
  if (args.cwd) {
    const byPath = await findProjectByPath(db, args.cwd);
    if (byPath) return repo && !byPath.repo ? setProjectRepo(db, byPath.id, repo) : byPath;
    if (isEphemeralPath(args.cwd)) {
      // Тимчасова папка: за нею проєкт не створюємо — нехай агент назве проєкт або репозиторій.
      if (create && repo) {
        const name = repo.split('/').pop() ?? 'project';
        const existing = await findProjectByRef(db, name);
        const p = existing && !existing.repo ? existing : await createProject(db, { name: await freeName(db, name) }, now);
        return setProjectRepo(db, p.id, repo);
      }
      const names = (await listProjects(db)).map((x) => x.name).slice(0, 30);
      throw new TimerError(
        `${args.cwd} — тимчасова папка (хмарна сесія), за нею проєкт не визначити. Передайте repo (git remote get-url origin) або project${names.length ? ` — один із: ${names.join(', ')}` : ''}.`,
      );
    }
    if (create) {
      const p = await resolveProject(db, args.cwd, now);
      return repo && !p.repo ? setProjectRepo(db, p.id, repo) : p;
    }
    throw new TimerError(`Для ${args.cwd} проєкту ще немає. Передайте project або repo, або прив'яжіть шлях: timer_projects add_path`);
  }
  throw new TimerError('Вкажіть repo (git remote get-url origin), cwd (вашу робочу директорію) або project');
}

/** Назва без конфлікту: «name», «name (2)»… */
async function freeName(db: Scope, base: string): Promise<string> {
  const taken = new Set((await listProjects(db, true)).map((p) => p.name.toLowerCase()));
  let name = base;
  for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${base} (${i})`;
  return name;
}

async function requireTask(db: Scope, ref: string, projectId: string | null, now: number): Promise<TaskWithTime> {
  const t = await findTaskByRef(db, ref, projectId, now);
  if (!t) throw new TimerError(`Задачу «${ref}» не знайдено. Подивіться список: timer_task_list`);
  await touchMcpTimers(db, now, t.project_id);
  return t;
}

function range(
  args: { period?: Period; from?: string; to?: string },
  tz: string,
  now: number,
): { from: number; to: number; label: string } {
  if (args.from || args.to) {
    const from = args.from ? parseInstant(args.from, tz) : periodRange('this_week', now, tz).from;
    const to = args.to ? parseInstant(args.to, tz) : now;
    return { from, to, label: `${fmtTime(from, tz)} – ${fmtTime(to, tz)}` };
  }
  const period = args.period ?? 'this_week';
  return { ...periodRange(period, now, tz), label: period };
}

export interface McpUser {
  id: string;
  timezone: string;
}

export function buildServer(env: Env, user: McpUser): McpServer {
  // Усе, що бачить цей MCP-сервер, — дані одного користувача (з OAuth-токена або API-ключа).
  const db: Scope = { db: env.DB, uid: user.id };
  const tz = user.timezone || 'Europe/Kyiv';
  const server = new McpServer(
    { name: 'timer', version: '0.2.0' },
    {
      instructions:
        'Трекер часу агентів. Коли починаєте конкретну задачу — викличте timer_task_start (або timer_task_add з start=true для нової), коли закінчили — обов’язково timer_task_done: без хуків Claude Code (claude.ai, Claude Desktop, хмарні сесії) час задачі рахується саме від старту до done. Задача без старту отримує 0 хв. У кожному виклику передавайте repo (git remote get-url origin), якщо працюєте в git-репозиторії, і cwd — вашу робочу директорію: у хмарних сесіях папка тимчасова, і проєкт визначає саме repo.',
    },
  );

  // ───────────── Що йде, звіти ─────────────

  server.registerTool(
    'timer_status',
    {
      title: 'Що йде зараз',
      description:
        'Що зараз: агенти, які працюють (і ручні таймери), та агенти, які закінчили хід або просять дозволу й чекають на людину — з проєктом, задачею і тривалістю.',
      inputSchema: z.object({}),
    },
    async () =>
      guard(async () => {
        const now = Date.now();
        const [running, waiting] = await Promise.all([listRunning(db), listWaiting(db)]);
        if (running.length === 0 && waiting.length === 0) return ok('Зараз нічого не йде і ніхто не чекає.', { running, waiting });
        const lines: string[] = [];
        if (waiting.length) {
          lines.push(`Чекають на людину: ${waiting.length}`);
          for (const w of waiting) {
            const what = w.task_title ? `${w.task_ref ? `${w.task_ref} ` : ''}${w.task_title}` : (w.last_prompt ?? '');
            lines.push(`- ${w.project_name} (агент ${rawSession(w.session_id)}): ${hm(now - w.waiting_since)}${w.waiting_reason ? ` — ${w.waiting_reason}` : ''}${what ? ` · ${what}` : ''}`);
          }
        }
        if (running.length) {
          lines.push(`Працюють: ${running.length}`);
          for (const r of running) {
            const who = r.source !== 'claude_code' ? 'вручну' : isMcpSession(r.session_id) ? 'задача через MCP' : `агент ${rawSession(r.session_id)}`;
            const task = r.task_title ? ` → ${r.task_title}` : '';
            lines.push(`- ${r.project_name}${task} (${who}): ${hm(now - r.started_at)} з ${fmtTime(r.started_at, tz)}${r.note ? ` — ${r.note}` : ''}`);
          }
        }
        return ok(lines.join('\n'), { running, waiting });
      }),
  );

  server.registerTool(
    'timer_report',
    {
      title: 'Звіт',
      description:
        'Звіт за період: проєкти й задачі. Реальний час = коли йшов хоча б один запис. Режими проєктів: full — кожен проєкт отримує весь свій час (час роботи агентів); split — паралельний час ділиться порівну; focus — час іде проєкту, куди востаннє надіслано промпт. Час задач — завжди full.',
      inputSchema: z.object({
        period: z.enum(PERIODS).optional().describe('Типово this_week. Ігнорується, якщо задано from/to.'),
        from: z.string().optional().describe(TIME_HINT),
        to: z.string().optional().describe(TIME_HINT),
        mode: z.enum(MODES).optional().describe('Типово full'),
        project: z.string().optional().describe('Лише цей проєкт (назва або id)'),
      }),
    },
    async (args) =>
      guard(async () => {
        const now = Date.now();
        const r = range(args, tz, now);
        const mode: Mode = args.mode ?? 'full';
        const p = args.project ? await requireProject(db, args.project) : null;
        const rep = await report(db, { from: r.from, to: r.to, mode, tz, projectId: p?.id }, now);
        const lines = [
          `Період: ${r.label} (${tz}), режим ${mode}${p ? `, проєкт ${p.name}` : ''}${rep.running_included ? ', з урахуванням запущених записів' : ''}`,
          `Реальний час: ${hm(rep.wall_ms)} · сума по проєктах (full): ${hm(rep.sum_full_ms)} · паралельність: ×${rep.parallelism.toFixed(2)}`,
          `Середнє за день із записами: ${hm(rep.avg_daily_ms)} (${rep.days_with_entries} дн.)`,
          '',
          'Проєкти:',
          ...rep.projects.map((t) => {
            const pct = rep.wall_ms > 0 && mode !== 'full' ? ` (${Math.round((t.ms / rep.wall_ms) * 100)}%)` : '';
            return `- ${t.name}: ${hm(t.ms)}${pct}`;
          }),
        ];
        if (rep.tasks.length) {
          lines.push('', 'Задачі:', ...rep.tasks.slice(0, 15).map((t) => `- ${t.title} (${t.project_name}, ${STATUS_UA[t.status]}): ${hm(t.ms)}`));
        }
        const activeDays = rep.days.filter((d) => d.wall_ms > 0);
        if (activeDays.length > 1) {
          lines.push('', 'По днях (реальний час):', ...activeDays.map((d) => `- ${d.date}: ${hm(d.wall_ms)}`));
        }
        return ok(lines.join('\n'), rep);
      }),
  );

  // ───────────── Задачі ─────────────

  server.registerTool(
    'timer_task_list',
    {
      title: 'Задачі проєкту',
      description: 'Задачі проєкту з витраченим часом. Без project і cwd — задачі всіх проєктів.',
      inputSchema: z.object({
        cwd: z.string().optional().describe(CWD_HINT),
        repo: z.string().optional().describe(REPO_HINT),
        project: z.string().optional().describe(PROJECT_HINT),
        status: z.enum(['open', 'done', 'all']).optional().describe('open (типово) = до роботи + в роботі'),
      }),
    },
    async (args) =>
      guard(async () => {
        const now = Date.now();
        const p = args.project || args.cwd || args.repo ? await projectFrom(db, args, now) : null;
        const tasks = await listTasks(db, { projectId: p?.id, status: args.status ?? 'open' }, now);
        if (tasks.length === 0) return ok(p ? `У «${p.name}» задач немає.` : 'Задач немає.', []);
        return ok(`${p ? `«${p.name}»` : 'Усі проєкти'}:\n${tasks.map((t) => taskLine(t, !p)).join('\n')}`, tasks);
      }),
  );

  server.registerTool(
    'timer_task_add',
    {
      title: 'Додати задачу',
      description:
        'Нова задача в проєкті. start=true — одразу почати її: таймер задачі піде до timer_task_done. Проєкт за cwd створюється, якщо його ще немає.',
      inputSchema: z.object({
        title: z.string().min(1).describe('Коротко, що треба зробити'),
        cwd: z.string().optional().describe(CWD_HINT),
        repo: z.string().optional().describe(REPO_HINT),
        project: z.string().optional().describe(PROJECT_HINT),
        notes: z.string().optional(),
        external_ref: z.string().optional().describe('Номер у трекері: LIN-42, #128'),
        start: z.boolean().optional(),
      }),
    },
    async (args) =>
      guard(async () => {
        const now = Date.now();
        const p = await projectFrom(db, args, now, true);
        const t = await createTask(db, { project_id: p.id, title: args.title, notes: args.notes, external_ref: args.external_ref }, now);
        if (!args.start) return ok(`Додано в «${p.name}»: ${t.title} (id ${t.id}).`, t);
        const res = await startTask(db, t.id, now);
        const timer = await startMcpTimer(db, res.task, now);
        return ok(`Додано й почато в «${p.name}»: ${t.title} (id ${t.id}). ${bindNote(timer)}`, res.task);
      }),
  );

  server.registerTool(
    'timer_task_start',
    {
      title: 'Почати задачу',
      description:
        'Викличте, коли починаєте працювати над задачею: статус «в роботі», і відтепер час іде в неї до timer_task_done. Кілька задач можуть іти паралельно. Задача — id, номер у трекері або назва.',
      inputSchema: z.object({
        task: z.string().min(1),
        cwd: z.string().optional().describe(CWD_HINT),
        repo: z.string().optional().describe(REPO_HINT),
        project: z.string().optional().describe(PROJECT_HINT),
      }),
    },
    async (args) =>
      guard(async () => {
        const now = Date.now();
        const p = args.project || args.cwd || args.repo ? await projectFrom(db, args, now) : null;
        const t = await requireTask(db, args.task, p?.id ?? null, now);
        const res = await startTask(db, t.id, now);
        const timer = await startMcpTimer(db, res.task, now);
        return ok(`В роботі: ${t.title} (${t.project_name}). ${bindNote(timer)}`, res.task);
      }),
  );

  server.registerTool(
    'timer_task_done',
    {
      title: 'Завершити задачу',
      description: 'Позначити задачу виконаною й зупинити її таймер (сесія з хуками далі рахується в проєкт без задачі). Задача — id, номер у трекері або назва.',
      inputSchema: z.object({
        task: z.string().min(1),
        cwd: z.string().optional().describe(CWD_HINT),
        repo: z.string().optional().describe(REPO_HINT),
        project: z.string().optional().describe(PROJECT_HINT),
      }),
    },
    async (args) =>
      guard(async () => {
        const now = Date.now();
        const p = args.project || args.cwd || args.repo ? await projectFrom(db, args, now) : null;
        const t = await requireTask(db, args.task, p?.id ?? null, now);
        const done = await updateTask(db, t.id, { status: 'done' }, now);
        const zero = done.spent_ms < 60_000 ? ' Часу майже не записано — наступного разу викличте timer_task_start на початку роботи (або timer_task_add з start=true).' : '';
        return ok(`Готово: ${done.title} (${done.project_name}) · витрачено ${hm(done.spent_ms)}.${zero}`, done);
      }),
  );

  server.registerTool(
    'timer_task_update',
    {
      title: 'Змінити задачу',
      description: 'Перейменувати, змінити нотатки, номер у трекері чи статус (todo / doing / done), або видалити (delete=true — час лишиться в проєкті).',
      inputSchema: z.object({
        task: z.string().min(1).describe('id, номер у трекері або назва'),
        cwd: z.string().optional().describe(CWD_HINT),
        repo: z.string().optional().describe(REPO_HINT),
        project: z.string().optional().describe(PROJECT_HINT),
        title: z.string().optional(),
        notes: z.string().optional(),
        external_ref: z.string().optional(),
        status: z.enum(['todo', 'doing', 'done']).optional(),
        delete: z.boolean().optional(),
      }),
    },
    async (args) =>
      guard(async () => {
        const now = Date.now();
        const p = args.project || args.cwd || args.repo ? await projectFrom(db, args, now) : null;
        const t = await requireTask(db, args.task, p?.id ?? null, now);
        if (args.delete) {
          await deleteTask(db, t.id, now);
          return ok(`Задачу «${t.title}» видалено; ${hm(t.spent_ms)} лишилися в проєкті «${t.project_name}» без задачі.`);
        }
        const u = await updateTask(db, t.id, { title: args.title, notes: args.notes, external_ref: args.external_ref, status: args.status }, now);
        return ok(`Оновлено: ${taskLine(u)}`, u);
      }),
  );

  // ───────────── Записи і ручний таймер ─────────────

  server.registerTool(
    'timer_label',
    {
      title: 'Підписати поточну роботу агента',
      description:
        'Оновлює нотатку найсвіжішого запущеного запису агента в проєкті з цим cwd. Для конкретної задачі краще timer_task_start.',
      inputSchema: z.object({
        cwd: z.string().describe(CWD_HINT),
        note: z.string().min(1).describe('Коротко: над чим робота'),
      }),
    },
    async ({ cwd, note }) =>
      guard(async () => {
        const n = await labelRunning(db, cwd, note, Date.now());
        return ok(n > 0 ? `Підписано: ${note}` : 'Запущеного запису агента в цьому проєкті немає — нічого не змінено.');
      }),
  );

  server.registerTool(
    'timer_start',
    {
      title: 'Запустити ручний таймер',
      description:
        'Ручний таймер для роботи без агента (зустріч, дзвінок). Проєкт — id або назва; якщо такого немає, його буде створено. task — задача цього проєкту. switch=true спершу зупиняє інші ручні таймери.',
      inputSchema: z.object({
        project: z.string().min(1),
        task: z.string().optional(),
        note: z.string().optional(),
        switch: z.boolean().optional(),
      }),
    },
    async (args) =>
      guard(async () => {
        const now = Date.now();
        const p = (await findProjectByRef(db, args.project)) ?? (await createProject(db, { name: args.project }, now));
        const t = args.task ? await requireTask(db, args.task, p.id, now) : null;
        const e = args.switch
          ? await switchTo(db, p.id, args.note ?? null, now, t?.id)
          : await startManual(db, p.id, args.note ?? null, now, t?.id);
        return ok(`Запущено «${p.name}»${t ? ` → ${t.title}` : ''} о ${fmtTime(e.started_at, tz)}.`, e);
      }),
  );

  server.registerTool(
    'timer_stop',
    {
      title: 'Зупинити ручний таймер',
      description: 'Зупиняє ручний таймер проєкту або, без project, усі ручні таймери. Записи агентів керуються хуками і тут не зупиняються.',
      inputSchema: z.object({ project: z.string().optional() }),
    },
    async ({ project }) =>
      guard(async () => {
        const now = Date.now();
        const p = project ? await requireProject(db, project) : null;
        const res = await stopManual(db, now, p?.id);
        if (res.stopped + res.discarded === 0) return ok('Ручних таймерів, що йдуть, немає.', res);
        return ok(`Зупинено: ${res.stopped}${res.discarded ? `; відкинуто коротших за хвилину: ${res.discarded}` : ''}.`, res);
      }),
  );

  server.registerTool(
    'timer_entries',
    {
      title: 'Записи за період',
      description: 'Список записів з id (потрібні для timer_edit_entry).',
      inputSchema: z.object({
        period: z.enum(PERIODS).optional().describe('Типово today'),
        from: z.string().optional().describe(TIME_HINT),
        to: z.string().optional().describe(TIME_HINT),
        project: z.string().optional().describe('Фільтр: назва або id проєкту'),
        task: z.string().optional().describe('Фільтр: задача (id, номер або назва)'),
      }),
    },
    async (args) =>
      guard(async () => {
        const now = Date.now();
        const r = range({ ...args, period: args.period ?? (args.from || args.to ? undefined : 'today') }, tz, now);
        const p = args.project ? await requireProject(db, args.project) : null;
        const t = args.task ? await requireTask(db, args.task, p?.id ?? null, now) : null;
        const { entries, truncated } = await listEntries(db, r.from, r.to, { projectId: p?.id, taskId: t?.id });
        if (entries.length === 0) return ok('Записів немає.', []);
        const lines = entries.map(
          (e) =>
            `- ${e.id} · ${e.project_name}${e.task_title ? ` → ${e.task_title}` : ''} · ${fmtTime(e.started_at, tz)}–${e.stopped_at ? fmtTime(e.stopped_at, tz) : 'зараз'} · ${hm((e.stopped_at ?? now) - e.started_at)} · ${e.source === 'claude_code' ? 'агент' : 'вручну'}${e.note ? ` · ${e.note}` : ''}`,
        );
        if (truncated) lines.push(`… показано ${entries.length} найновіших; звузьте період, щоб побачити старіші.`);
        return ok(lines.join('\n'), entries);
      }),
  );

  server.registerTool(
    'timer_edit_entry',
    {
      title: 'Виправити або видалити запис',
      description:
        'Змінює запис. Нова тривалість рухає кінець, початок лишається (як у Toggl). task="none" відв’язує від задачі. delete=true видаляє запис.',
      inputSchema: z.object({
        entry_id: z.string(),
        start: z.string().optional().describe(TIME_HINT),
        stop: z.string().optional().describe(TIME_HINT),
        duration_minutes: z.number().positive().optional(),
        note: z.string().optional(),
        project: z.string().optional().describe('Перенести в інший проєкт (назва або id)'),
        task: z.string().optional().describe('Задача (id, номер або назва) або "none"'),
        delete: z.boolean().optional(),
      }),
    },
    async (args) =>
      guard(async () => {
        const now = Date.now();
        if (args.delete) {
          await deleteEntry(db, args.entry_id);
          return ok('Запис видалено.');
        }
        const p = args.project ? await requireProject(db, args.project) : null;
        let taskId: string | null | undefined;
        if (args.task === 'none') taskId = null;
        else if (args.task) {
          const projectId = p?.id ?? (await getEntry(db, args.entry_id)).project_id;
          taskId = (await requireTask(db, args.task, projectId, now)).id;
        }
        const e = await updateEntry(
          db,
          args.entry_id,
          {
            start: args.start ? parseInstant(args.start, tz) : undefined,
            stop: args.stop ? parseInstant(args.stop, tz) : undefined,
            duration_ms: args.duration_minutes ? Math.round(args.duration_minutes * 60_000) : undefined,
            note: args.note,
            project_id: p?.id,
            task_id: taskId,
          },
          now,
        );
        return ok(
          `Запис оновлено: ${fmtTime(e.started_at, tz)}–${e.stopped_at ? fmtTime(e.stopped_at, tz) : 'зараз'} (${hm((e.stopped_at ?? now) - e.started_at)}).`,
          e,
        );
      }),
  );

  server.registerTool(
    'timer_add_entry',
    {
      title: 'Додати запис вручну',
      description: 'Додає завершений ручний запис (минулий час). Проєкт — id або назва (створюється, якщо немає); task — задача проєкту.',
      inputSchema: z.object({
        project: z.string().min(1),
        task: z.string().optional(),
        start: z.string().describe(TIME_HINT),
        stop: z.string().optional().describe(TIME_HINT),
        duration_minutes: z.number().positive().optional(),
        note: z.string().optional(),
      }),
    },
    async (args) =>
      guard(async () => {
        const now = Date.now();
        const p = (await findProjectByRef(db, args.project)) ?? (await createProject(db, { name: args.project }, now));
        const t = args.task ? await requireTask(db, args.task, p.id, now) : null;
        const e = await createEntry(
          db,
          {
            project_id: p.id,
            task_id: t?.id,
            start: parseInstant(args.start, tz),
            stop: args.stop ? parseInstant(args.stop, tz) : undefined,
            duration_ms: args.duration_minutes ? Math.round(args.duration_minutes * 60_000) : undefined,
            note: args.note,
          },
          now,
        );
        return ok(`Додано «${p.name}»${t ? ` → ${t.title}` : ''}: ${fmtTime(e.started_at, tz)}–${fmtTime(e.stopped_at!, tz)}.`, e);
      }),
  );

  // ───────────── Проєкти ─────────────

  server.registerTool(
    'timer_projects',
    {
      title: 'Проєкти',
      description:
        'list — список; create — новий проєкт (name, path?); rename — project + name; add_path / remove_path — project + path (абсолютний шлях на диску, за яким хуки знаходять проєкт; шляхів може бути кілька); set_repo — project + repo (git remote; порожній repo відв’язує); merge — project + into (перенести записи, задачі, шляхи й репозиторій, видалити project); archive / unarchive — project.',
      inputSchema: z.object({
        action: z.enum(['list', 'create', 'rename', 'add_path', 'remove_path', 'set_repo', 'merge', 'archive', 'unarchive']),
        project: z.string().optional(),
        repo: z.string().optional(),
        name: z.string().optional(),
        path: z.string().optional(),
        into: z.string().optional(),
        include_archived: z.boolean().optional(),
      }),
    },
    async (args) =>
      guard(async () => {
        const now = Date.now();
        switch (args.action) {
          case 'list': {
            const projects = await listProjects(db, args.include_archived ?? false);
            if (projects.length === 0) return ok('Проєктів ще немає. Вони з’являються автоматично, коли агент стартує в новій папці.', []);
            return ok(
              projects
                .map((p) => `- ${p.name} · ${p.id}${p.repo ? ` · ${p.repo}` : ''}${p.paths.length ? ` · ${p.paths.join(', ')}` : ''}${p.archived_at ? ' · архів' : ''}`)
                .join('\n'),
              projects,
            );
          }
          case 'create': {
            if (!args.name) throw new TimerError('Потрібен name');
            const p = await createProject(db, { name: args.name, path: args.path ?? null }, now);
            return ok(`Створено «${p.name}» (${p.id}).`, p);
          }
          case 'rename': {
            if (!args.project || !args.name) throw new TimerError('Потрібні project і name');
            const p = await updateProject(db, (await requireProject(db, args.project)).id, { name: args.name }, now);
            return ok(`Перейменовано на «${p.name}».`, p);
          }
          case 'add_path':
          case 'remove_path': {
            if (!args.project || !args.path) throw new TimerError('Потрібні project і path');
            const id = (await requireProject(db, args.project)).id;
            const p = args.action === 'add_path' ? await addProjectPath(db, id, args.path) : await removeProjectPath(db, id, args.path);
            return ok(`Шляхи «${p.name}»: ${p.paths.length ? p.paths.join(', ') : 'немає'}.`, p);
          }
          case 'set_repo': {
            if (!args.project) throw new TimerError('Потрібен project');
            const p = await setProjectRepo(db, (await requireProject(db, args.project)).id, args.repo?.trim() ? args.repo : null);
            return ok(p.repo ? `«${p.name}» ← ${p.repo}.` : `У «${p.name}» репозиторій відв’язано.`, p);
          }
          case 'merge': {
            if (!args.project || !args.into) throw new TimerError('Потрібні project і into');
            const from = await requireProject(db, args.project);
            const into = await requireProject(db, args.into);
            const p = await mergeProjects(db, from.id, into.id, now);
            return ok(`«${from.name}» об’єднано в «${p.name}».`, p);
          }
          case 'archive':
          case 'unarchive': {
            if (!args.project) throw new TimerError('Потрібен project');
            const p = await updateProject(db, (await requireProject(db, args.project)).id, { archived: args.action === 'archive' }, now);
            return ok(args.action === 'archive' ? `«${p.name}» в архіві.` : `«${p.name}» повернуто з архіву.`, p);
          }
        }
      }),
  );

  return server;
}

function bindNote(timerStarted: boolean): string {
  return timerStarted
    ? 'Таймер задачі пішов; зупиниться на timer_task_done (якщо у вас є хуки Claude Code — час рахуватиме ваша сесія).'
    : 'Час у цю задачу вже йде.';
}

export function handleMcp(request: Request, env: Env, ctx: ExecutionContext, user: McpUser): Promise<Response> {
  return createMcpHandler(() => buildServer(env, user), { route: '/mcp' })(request, env, ctx);
}
