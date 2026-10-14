/**
 * Бізнес-логіка трекера. Використовується REST API, MCP-сервером, хуками і cron.
 * Усі моменти часу — мілісекунди UTC; `now` передається ззовні (тестованість).
 *
 * Словник: проєкт (projects) — папка/репозиторій, куди хуки пишуть час агентів;
 * задача (tasks) — конкретна робота всередині проєкту; запис (time_entries) — інтервал часу
 * проєкту, за бажанням прив'язаний до задачі.
 */
import { allocate, type Mode } from './allocate';
import { days as dayRanges } from './time';

export class TimerError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

export interface Project {
  id: string;
  name: string;
  /** Шляхи проєкту на диску; хук знаходить проєкт за найдовшим префіксом cwd. */
  paths: string[];
  color: string | null;
  created_at: number;
  archived_at: number | null;
}

export type TaskStatus = 'todo' | 'doing' | 'done';

export interface Task {
  id: string;
  project_id: string;
  title: string;
  notes: string | null;
  status: TaskStatus;
  external_ref: string | null;
  created_at: number;
  done_at: number | null;
}

export interface TaskWithTime extends Task {
  project_name: string;
  /** Сумарний час записів задачі (час агентів, без розподілу), мс. */
  spent_ms: number;
  /** Скільки сесій агентів зараз працюють над задачею. */
  active_sessions: number;
}

export interface Entry {
  id: string;
  project_id: string;
  task_id: string | null;
  session_id: string;
  source: 'manual' | 'claude_code';
  started_at: number;
  stopped_at: number | null;
  last_seen_at: number;
  note: string | null;
}

export interface EntryWithProject extends Entry {
  project_name: string;
  project_color: string | null;
  task_title: string | null;
  task_ref: string | null;
}

export const MANUAL = 'manual';
/** Ручні записи коротші за хвилину — майже завжди випадковий клік. */
export const MIN_MANUAL_MS = 60_000;

const uid = () => crypto.randomUUID();

export function normalizePath(p: string): string {
  const t = p.trim();
  return t.length > 1 ? t.replace(/\/+$/, '') : t;
}

function basename(p: string): string {
  const parts = normalizePath(p).split('/').filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/** Один рядок, до 140 символів. */
export function summarize(text: string | null | undefined, max = 140): string | null {
  if (!text) return null;
  const one = text.replace(/\s+/g, ' ').trim();
  if (!one) return null;
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

const lower = (s: string) => s.trim().toLocaleLowerCase('uk');

// ───────────────────────────── Проєкти ─────────────────────────────

interface ProjectRow {
  id: string;
  name: string;
  color: string | null;
  created_at: number;
  archived_at: number | null;
}

const COLOR_RE = /^#[0-9a-f]{3,8}$/i;

function checkColor(color: string | null | undefined): string | null {
  if (color === undefined || color === null || color === '') return null;
  if (!COLOR_RE.test(color)) throw new TimerError('Колір — hex на кшталт #d9643a');
  return color;
}

/** Назви активних проєктів унікальні (без урахування регістру), щоб MCP міг шукати проєкт за назвою. */
async function nameTaken(db: D1Database, name: string, exceptId = ''): Promise<boolean> {
  // lower() у SQLite знає лише ASCII, тому порівнюємо в JS (кирилиця).
  const key = lower(name);
  const rows = (
    await db.prepare('SELECT id, name FROM projects WHERE archived_at IS NULL AND id != ?').bind(exceptId).all<{ id: string; name: string }>()
  ).results;
  return rows.some((r) => lower(r.name) === key);
}

/** «api» → «api (2)», якщо «api» вже зайнята. */
async function uniqueName(db: D1Database, base: string, exceptId = ''): Promise<string> {
  let name = base;
  for (let i = 2; await nameTaken(db, name, exceptId); i++) name = `${base} (${i})`;
  return name;
}

async function withPaths(db: D1Database, rows: ProjectRow[]): Promise<Project[]> {
  if (rows.length === 0) return [];
  const paths = (await db.prepare('SELECT path, project_id FROM project_paths ORDER BY path').all<{ path: string; project_id: string }>()).results;
  const byProject = new Map<string, string[]>();
  for (const p of paths) byProject.set(p.project_id, [...(byProject.get(p.project_id) ?? []), p.path]);
  return rows.map((r) => ({ ...r, paths: byProject.get(r.id) ?? [] }));
}

export async function listProjects(db: D1Database, includeArchived = false): Promise<Project[]> {
  const sql = includeArchived
    ? 'SELECT * FROM projects ORDER BY archived_at IS NOT NULL, name'
    : 'SELECT * FROM projects WHERE archived_at IS NULL ORDER BY name';
  return withPaths(db, (await db.prepare(sql).all<ProjectRow>()).results);
}

export async function getProject(db: D1Database, id: string): Promise<Project> {
  const p = await db.prepare('SELECT * FROM projects WHERE id = ?').bind(id).first<ProjectRow>();
  if (!p) throw new TimerError(`Проєкт ${id} не знайдено`, 404);
  return (await withPaths(db, [p]))[0];
}

/** Проєкт за id або назвою (активний має пріоритет над архівним). */
export async function findProjectByRef(db: D1Database, ref: string): Promise<Project | null> {
  const all = await listProjects(db, true);
  const r = lower(ref);
  const byName = all.filter((p) => lower(p.name) === r);
  return all.find((p) => p.id === ref.trim()) ?? byName.find((p) => p.archived_at === null) ?? byName[0] ?? null;
}

/** Проєкт, чий шлях — найдовший префікс cwd. */
export async function findProjectByPath(db: D1Database, cwd: string): Promise<Project | null> {
  const path = normalizePath(cwd);
  const all = (await db.prepare('SELECT path, project_id FROM project_paths').all<{ path: string; project_id: string }>()).results;
  let best: { path: string; project_id: string } | null = null;
  for (const p of all) {
    if ((path === p.path || path.startsWith(`${p.path}/`)) && (!best || p.path.length > best.path.length)) best = p;
  }
  return best ? getProject(db, best.project_id) : null;
}

/** Знайти проєкт для cwd або створити новий з назвою останньої папки. */
export async function resolveProject(db: D1Database, cwd: string, now: number): Promise<Project> {
  const found = await findProjectByPath(db, cwd);
  if (found) {
    if (found.archived_at !== null) {
      // Агент знову працює в архівному проєкті — повертаємо його з архіву (з вільною назвою).
      const name = await uniqueName(db, found.name, found.id);
      await db.prepare('UPDATE projects SET archived_at = NULL, name = ? WHERE id = ?').bind(name, found.id).run();
      return { ...found, name, archived_at: null };
    }
    return found;
  }
  const path = normalizePath(cwd);
  const id = uid();
  const name = await uniqueName(db, basename(cwd));
  await db.batch([
    db.prepare('INSERT INTO projects (id, name, color, created_at) VALUES (?, ?, NULL, ?)').bind(id, name, now),
    // Два агенти одночасно в новій папці: шлях дістається першому, другий підхопить його проєкт нижче.
    db.prepare('INSERT INTO project_paths (path, project_id) VALUES (?, ?) ON CONFLICT(path) DO NOTHING').bind(path, id),
  ]);
  const owner = await findProjectByPath(db, cwd);
  if (owner && owner.id !== id) {
    await db.prepare('DELETE FROM projects WHERE id = ?').bind(id).run();
    return owner;
  }
  return owner ?? getProject(db, id);
}

export async function createProject(
  db: D1Database,
  input: { name: string; path?: string | null; color?: string | null },
  now: number,
): Promise<Project> {
  const name = input.name?.trim();
  if (!name) throw new TimerError('Потрібна назва проєкту');
  if (await nameTaken(db, name)) throw new TimerError(`Проєкт «${name}» уже є`, 409);
  const id = uid();
  const stmts = [db.prepare('INSERT INTO projects (id, name, color, created_at) VALUES (?, ?, ?, ?)').bind(id, name, checkColor(input.color), now)];
  if (input.path) stmts.push(db.prepare('INSERT INTO project_paths (path, project_id) VALUES (?, ?)').bind(normalizePath(input.path), id));
  try {
    await db.batch(stmts);
  } catch (e) {
    if (String(e).includes('UNIQUE')) throw new TimerError(`Шлях ${input.path} уже прив'язаний до іншого проєкту`, 409);
    throw e;
  }
  return getProject(db, id);
}

export async function updateProject(
  db: D1Database,
  id: string,
  patch: { name?: string; color?: string | null; archived?: boolean },
  now: number,
): Promise<Project> {
  const p = await getProject(db, id);
  const newName = patch.name?.trim();
  if (newName && (await nameTaken(db, newName, id))) throw new TimerError(`Проєкт «${newName}» уже є`, 409);
  if (patch.archived === false && p.archived_at !== null && (await nameTaken(db, newName || p.name, id))) {
    throw new TimerError(`Активний проєкт «${p.name}» уже є — спершу перейменуйте один із них`, 409);
  }
  const name = newName || p.name;
  const color = patch.color === undefined ? p.color : checkColor(patch.color);
  const archivedAt = patch.archived === undefined ? p.archived_at : patch.archived ? (p.archived_at ?? now) : null;
  const stmts = [db.prepare('UPDATE projects SET name = ?, color = ?, archived_at = ? WHERE id = ?').bind(name, color, archivedAt, id)];
  // Архівний проєкт не може йти: зупиняємо його ручні таймери.
  if (patch.archived) {
    stmts.push(
      db
        .prepare('UPDATE time_entries SET stopped_at = ?, last_seen_at = ? WHERE project_id = ? AND session_id = ? AND stopped_at IS NULL')
        .bind(now, now, id, MANUAL),
    );
  }
  await db.batch(stmts);
  return getProject(db, id);
}

/** Прив'язати шлях на диску до проєкту (хуки шукатимуть проєкт за ним). */
export async function addProjectPath(db: D1Database, id: string, path: string): Promise<Project> {
  await getProject(db, id);
  const p = normalizePath(path);
  if (!p.startsWith('/')) throw new TimerError('Шлях має бути абсолютним');
  const owner = await db.prepare('SELECT project_id FROM project_paths WHERE path = ?').bind(p).first<{ project_id: string }>();
  if (owner && owner.project_id !== id) throw new TimerError(`Шлях ${p} уже прив'язаний до іншого проєкту — об'єднайте проєкти (merge)`, 409);
  await db.prepare('INSERT INTO project_paths (path, project_id) VALUES (?, ?) ON CONFLICT(path) DO NOTHING').bind(p, id).run();
  return getProject(db, id);
}

export async function removeProjectPath(db: D1Database, id: string, path: string): Promise<Project> {
  await db.prepare('DELETE FROM project_paths WHERE path = ? AND project_id = ?').bind(normalizePath(path), id).run();
  return getProject(db, id);
}

/** Перенести записи, задачі й шляхи проєкту `fromId` у `intoId` і видалити `fromId`. */
export async function mergeProjects(db: D1Database, fromId: string, intoId: string, now: number): Promise<Project> {
  if (fromId === intoId) throw new TimerError('Не можна об’єднати проєкт сам із собою');
  await getProject(db, fromId);
  await getProject(db, intoId);
  // Ручні записи одного проєкту не перекриваються — перевіряємо до перенесення.
  const clash = await db
    .prepare(
      `SELECT a.id FROM time_entries a JOIN time_entries b
         ON a.project_id = ? AND b.project_id = ? AND a.session_id = ? AND b.session_id = ?
        AND a.started_at < COALESCE(b.stopped_at, ?) AND COALESCE(a.stopped_at, ?) > b.started_at
       LIMIT 1`,
    )
    .bind(fromId, intoId, MANUAL, MANUAL, now, now)
    .first();
  if (clash) throw new TimerError('Ручні записи цих проєктів перекриваються — спершу виправте їх', 409);
  await db.batch([
    // Запущені записи зупиняємо, щоб не зламати «один запущений запис на сесію».
    db.prepare('UPDATE time_entries SET stopped_at = ?, last_seen_at = ? WHERE project_id = ? AND stopped_at IS NULL').bind(now, now, fromId),
    db.prepare('UPDATE time_entries SET project_id = ? WHERE project_id = ?').bind(intoId, fromId),
    db.prepare('UPDATE tasks SET project_id = ? WHERE project_id = ?').bind(intoId, fromId),
    db.prepare('UPDATE session_tasks SET project_id = ? WHERE project_id = ?').bind(intoId, fromId),
    db.prepare('UPDATE agent_sessions SET project_id = ? WHERE project_id = ?').bind(intoId, fromId),
    db.prepare('UPDATE focus_switches SET project_id = ? WHERE project_id = ?').bind(intoId, fromId),
    db.prepare('UPDATE project_paths SET project_id = ? WHERE project_id = ?').bind(intoId, fromId),
    db.prepare('DELETE FROM projects WHERE id = ?').bind(fromId),
  ]);
  return getProject(db, intoId);
}

// ───────────────────────────── Задачі ─────────────────────────────

const TASK_WITH_TIME = (nowParam: string) => `
  SELECT t.*, p.name AS project_name,
    COALESCE((SELECT SUM(COALESCE(e.stopped_at, ${nowParam}) - e.started_at) FROM time_entries e WHERE e.task_id = t.id), 0) AS spent_ms,
    (SELECT COUNT(*) FROM time_entries e WHERE e.task_id = t.id AND e.stopped_at IS NULL) AS active_sessions
  FROM tasks t JOIN projects p ON p.id = t.project_id`;

export async function getTask(db: D1Database, id: string, now = Date.now()): Promise<TaskWithTime> {
  const t = await db.prepare(`${TASK_WITH_TIME('?1')} WHERE t.id = ?2`).bind(now, id).first<TaskWithTime>();
  if (!t) throw new TimerError(`Задачу ${id} не знайдено`, 404);
  return t;
}

/** Задачі проєкту (або всіх проєктів). open = todo + doing. */
export async function listTasks(
  db: D1Database,
  q: { projectId?: string; status?: 'open' | 'done' | 'all' },
  now: number,
): Promise<TaskWithTime[]> {
  const where: string[] = [];
  const args: unknown[] = [now];
  if (q.projectId) {
    where.push(`t.project_id = ?${args.length + 1}`);
    args.push(q.projectId);
  }
  const status = q.status ?? 'open';
  if (status === 'open') where.push("t.status != 'done'");
  if (status === 'done') where.push("t.status = 'done'");
  const sql = `${TASK_WITH_TIME('?1')}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
    ORDER BY CASE t.status WHEN 'doing' THEN 0 WHEN 'todo' THEN 1 ELSE 2 END, COALESCE(t.done_at, t.created_at) DESC`;
  return (await db.prepare(sql).bind(...args).all<TaskWithTime>()).results;
}

/**
 * Задача за посиланням у межах проєкту: id, номер у трекері (LIN-42) або назва без урахування регістру.
 * Кілька збігів за назвою — помилка зі списком, щоб агент уточнив.
 */
export async function findTaskByRef(db: D1Database, ref: string, projectId: string | null, now: number): Promise<TaskWithTime | null> {
  const r = ref.trim();
  const byId = await db.prepare(`${TASK_WITH_TIME('?1')} WHERE t.id = ?2`).bind(now, r).first<TaskWithTime>();
  if (byId) return byId;
  const pool = await listTasks(db, { projectId: projectId ?? undefined, status: 'all' }, now);
  const key = lower(r);
  const byRef = pool.filter((t) => t.external_ref && lower(t.external_ref) === key);
  const byTitle = pool.filter((t) => lower(t.title) === key);
  const candidates = byRef.length ? byRef : byTitle;
  const open = candidates.filter((t) => t.status !== 'done');
  const pick = open.length ? open : candidates;
  if (pick.length > 1) {
    throw new TimerError(
      `Під «${r}» кілька задач: ${pick.map((t) => `${t.title} (${t.project_name}, ${t.id})`).join('; ')}. Передайте id.`,
      409,
    );
  }
  return pick[0] ?? null;
}

export async function createTask(
  db: D1Database,
  input: { project_id: string; title: string; notes?: string | null; external_ref?: string | null },
  now: number,
): Promise<TaskWithTime> {
  const project = await getProject(db, input.project_id);
  if (project.archived_at !== null) throw new TimerError(`Проєкт «${project.name}» в архіві`);
  const title = summarize(input.title, 200);
  if (!title) throw new TimerError('Потрібна назва задачі');
  const id = uid();
  await db
    .prepare('INSERT INTO tasks (id, project_id, title, notes, status, external_ref, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, project.id, title, input.notes?.trim() || null, 'todo', input.external_ref?.trim() || null, now)
    .run();
  return getTask(db, id, now);
}

/** Запущені записи агентів над задачею — щоб продовжити їх без задачі. */
async function runningForTask(db: D1Database, taskId: string) {
  return (
    await db
      .prepare("SELECT project_id, session_id, note FROM time_entries WHERE task_id = ? AND stopped_at IS NULL AND source = 'claude_code'")
      .bind(taskId)
      .all<{ project_id: string; session_id: string; note: string | null }>()
  ).results;
}

export async function updateTask(
  db: D1Database,
  id: string,
  patch: { title?: string; notes?: string | null; external_ref?: string | null; status?: TaskStatus },
  now: number,
): Promise<TaskWithTime> {
  const t = await getTask(db, id, now);
  const title = patch.title === undefined ? t.title : summarize(patch.title, 200);
  if (!title) throw new TimerError('Назва задачі не може бути порожньою');
  const status = patch.status ?? t.status;
  if (!['todo', 'doing', 'done'].includes(status)) throw new TimerError('status: todo | doing | done');
  const doneAt = status === 'done' ? (t.done_at ?? now) : null;
  const stmts: D1PreparedStatement[] = [];
  if (status === 'done' && t.status !== 'done') {
    // Закриваємо поточні інтервали задачі; агенти продовжують працювати вже без задачі.
    // Порядок: спершу закрити (інакше впремося в one_running_per_session), потім відкрити продовження.
    const reopen = await runningForTask(db, id);
    stmts.push(
      db.prepare("UPDATE time_entries SET stopped_at = ?1, last_seen_at = ?1 WHERE task_id = ?2 AND stopped_at IS NULL AND source = 'claude_code'").bind(now, id),
      ...reopen.map((r) => insertEntry(db, r.project_id, null, r.session_id, 'claude_code', now, r.note)),
      db.prepare('DELETE FROM session_tasks WHERE task_id = ?').bind(id),
    );
  }
  stmts.push(
    db
      .prepare('UPDATE tasks SET title = ?, notes = ?, external_ref = ?, status = ?, done_at = ? WHERE id = ?')
      .bind(
        title,
        patch.notes === undefined ? t.notes : patch.notes?.trim() || null,
        patch.external_ref === undefined ? t.external_ref : patch.external_ref?.trim() || null,
        status,
        doneAt,
        id,
      ),
  );
  await db.batch(stmts);
  return getTask(db, id, now);
}

/**
 * Видалити задачу. Час не губиться: записи лишаються в проєкті без задачі.
 * Запущені записи агентів розриваються так само, як при «готово».
 */
export async function deleteTask(db: D1Database, id: string, now: number): Promise<void> {
  await getTask(db, id, now);
  // Порядок важливий: спершу закрити запущений інтервал задачі, потім відкрити продовження без задачі
  // (інакше впремося в one_running_per_session), і лише тоді відв'язати старі записи.
  const reopen = await runningForTask(db, id);
  await db.batch([
    db.prepare("UPDATE time_entries SET stopped_at = ?1, last_seen_at = ?1 WHERE task_id = ?2 AND stopped_at IS NULL").bind(now, id),
    db.prepare('UPDATE time_entries SET task_id = NULL WHERE task_id = ?').bind(id),
    ...reopen.map((r) => insertEntry(db, r.project_id, null, r.session_id, 'claude_code', now, r.note)),
    db.prepare('DELETE FROM session_tasks WHERE task_id = ?').bind(id),
    db.prepare('DELETE FROM tasks WHERE id = ?').bind(id),
  ]);
}

/**
 * Почати роботу над задачею: статус doing, і час сесії агента відтепер іде в задачу.
 * Сесію знає лише хук (PostToolUse після timer_task_start несе session_id). MCP-виклик сам сесію
 * не вгадує: при кількох агентах у проєкті так легко віддати час чужій сесії.
 */
export async function startTask(
  db: D1Database,
  taskId: string,
  now: number,
  sessionId?: string,
): Promise<{ task: TaskWithTime; bound: boolean }> {
  const t = await getTask(db, taskId, now);
  if (t.status === 'done') throw new TimerError(`Задача «${t.title}» уже виконана — відкрийте її знову (status: todo)`);
  const session = sessionId;
  let bound = false;
  const stmts: D1PreparedStatement[] = [];
  if (t.status === 'todo') stmts.push(db.prepare("UPDATE tasks SET status = 'doing' WHERE id = ?").bind(t.id));
  if (session && session !== MANUAL) {
    bound = true;
    stmts.push(
      db
        .prepare(
          `INSERT INTO session_tasks (session_id, task_id, project_id, set_at) VALUES (?1, ?2, ?3, ?4)
           ON CONFLICT(session_id) DO UPDATE SET task_id = ?2, project_id = ?3, set_at = ?4`,
        )
        .bind(session, t.id, t.project_id, now),
    );
    const running = await db
      .prepare('SELECT * FROM time_entries WHERE session_id = ? AND project_id = ? AND stopped_at IS NULL')
      .bind(session, t.project_id)
      .first<Entry>();
    if (running && running.task_id === null) {
      // Хід агента щойно почався без задачі — віддаємо його задачі цілком.
      stmts.push(db.prepare('UPDATE time_entries SET task_id = ?, last_seen_at = ? WHERE id = ?').bind(t.id, now, running.id));
    } else if (running && running.task_id !== t.id) {
      // Агент переключився з іншої задачі посеред ходу — ріжемо інтервал.
      stmts.push(db.prepare('UPDATE time_entries SET stopped_at = ?, last_seen_at = ? WHERE id = ?').bind(now, now, running.id));
      stmts.push(insertEntry(db, t.project_id, t.id, session, 'claude_code', now, running.note));
    }
  }
  if (stmts.length) await db.batch(stmts);
  return { task: await getTask(db, t.id, now), bound };
}

// ───────────────────────────── Хуки Claude Code ─────────────────────────────

export interface HookInput {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  /** Текст сповіщення (подія Notification). */
  message?: string;
  /** Корінь проєкту з заголовка X-Project-Dir (CLAUDE_PROJECT_DIR); має пріоритет над cwd. */
  project_dir?: string;
}

export const HOOK_EVENTS = {
  start: ['UserPromptSubmit'],
  heartbeat: ['PostToolUse', 'PostToolUseFailure', 'PostToolBatch', 'SubagentStart', 'SubagentStop'],
  /** Хід закінчено — агент чекає на вас. */
  stop: ['Stop', 'StopFailure'],
  /** Агент просить дозволу або нагадує, що чекає: час не рахуємо, доки він знову не почне працювати. */
  wait: ['Notification'],
  end: ['SessionEnd'],
} as const;

const inList = (list: readonly string[], e: string) => list.includes(e);

/** MCP-інструменти трекера, після яких хук точно прив'язує сесію до задачі. */
const TASK_START_TOOL = /__timer_task_(start|add)$/;

/** Задача, до якої прив'язана сесія в цьому проєкті (якщо вона ще не виконана). */
async function boundTask(db: D1Database, sessionId: string, projectId: string): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT st.task_id FROM session_tasks st JOIN tasks t ON t.id = st.task_id
       WHERE st.session_id = ? AND st.project_id = ? AND t.status != 'done'`,
    )
    .bind(sessionId, projectId)
    .first<{ task_id: string }>();
  return row?.task_id ?? null;
}

/** Сесія працює: upsert стану. */
function sessionWorking(db: D1Database, sessionId: string, projectId: string, now: number, prompt: string | null): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO agent_sessions (session_id, project_id, state, last_prompt, waiting_reason, waiting_since, started_at, updated_at)
       VALUES (?1, ?2, 'working', ?3, NULL, NULL, ?4, ?4)
       ON CONFLICT(session_id) DO UPDATE SET project_id = ?2, state = 'working', last_prompt = COALESCE(?3, last_prompt),
         waiting_reason = NULL, waiting_since = NULL, stopped_by_user_at = NULL, updated_at = ?4`,
    )
    .bind(sessionId, projectId, prompt, now);
}

function stopSessionEntries(db: D1Database, sessionId: string, now: number): D1PreparedStatement {
  return db.prepare('UPDATE time_entries SET stopped_at = ?, last_seen_at = ? WHERE session_id = ? AND stopped_at IS NULL').bind(now, now, sessionId);
}

export async function handleHook(
  db: D1Database,
  input: HookInput,
  now: number,
  opts: { noteFromPrompt: boolean },
): Promise<'started' | 'heartbeat' | 'stopped' | 'waiting' | 'ended' | 'bound' | 'ignored'> {
  const event = input.hook_event_name ?? '';
  const sessionId = input.session_id;
  if (!sessionId || sessionId === MANUAL) return 'ignored';

  if (inList(HOOK_EVENTS.end, event)) {
    await db.batch([
      stopSessionEntries(db, sessionId, now),
      // Сесія закрита — її прив'язка до задачі більше не потрібна.
      db.prepare('DELETE FROM session_tasks WHERE session_id = ?').bind(sessionId),
      db.prepare("UPDATE agent_sessions SET state = 'ended', waiting_since = NULL, waiting_reason = NULL, updated_at = ? WHERE session_id = ?").bind(now, sessionId),
    ]);
    return 'ended';
  }

  if (inList(HOOK_EVENTS.stop, event)) {
    await db.batch([
      stopSessionEntries(db, sessionId, now),
      db
        .prepare(
          `UPDATE agent_sessions SET state = 'waiting', waiting_reason = ?, waiting_since = ?, updated_at = ?
           WHERE session_id = ? AND state != 'ended'`,
        )
        .bind(event === 'StopFailure' ? 'Хід обірвався з помилкою API' : null, now, now, sessionId),
    ]);
    return 'stopped';
  }

  if (inList(HOOK_EVENTS.wait, event)) {
    // Запит дозволу посеред ходу або нагадування після ходу: зупиняємо облік, позначаємо «чекає».
    // Наступний PostToolUse (дозвіл дали) відновить запис через самовідновлення нижче.
    await db.batch([
      stopSessionEntries(db, sessionId, now),
      db
        .prepare(
          // Причину беремо лише з сповіщення посеред ходу (запит дозволу); нагадування після ходу її не перетирає.
          `UPDATE agent_sessions SET waiting_reason = CASE WHEN state = 'working' THEN ? ELSE waiting_reason END,
             state = 'waiting', waiting_since = COALESCE(waiting_since, ?), updated_at = ?
           WHERE session_id = ? AND state != 'ended'`,
        )
        .bind(summarize(input.message, 200), now, now, sessionId),
    ]);
    return 'waiting';
  }

  const dir = input.project_dir || input.cwd;
  if (!dir) return 'ignored';

  if (inList(HOOK_EVENTS.start, event)) {
    const project = await resolveProject(db, dir, now);
    const note = opts.noteFromPrompt ? summarize(input.prompt) : null;
    const bound = await boundTask(db, sessionId, project.id);
    const running = (
      await db.prepare('SELECT * FROM time_entries WHERE session_id = ? AND stopped_at IS NULL').bind(sessionId).all<Entry>()
    ).results;
    const stmts: D1PreparedStatement[] = [];
    let alreadyRunning = false;
    for (const r of running) {
      if (r.project_id === project.id) {
        alreadyRunning = true;
        stmts.push(db.prepare('UPDATE time_entries SET last_seen_at = ? WHERE id = ?').bind(now, r.id));
      } else {
        // Сесія перейшла в інший проєкт (змінився cwd) — закриваємо старий запис.
        stmts.push(db.prepare('UPDATE time_entries SET stopped_at = ?, last_seen_at = ? WHERE id = ?').bind(now, now, r.id));
      }
    }
    if (!alreadyRunning) stmts.push(insertEntry(db, project.id, bound, sessionId, 'claude_code', now, note));
    stmts.push(db.prepare('INSERT INTO focus_switches (at, project_id) VALUES (?, ?)').bind(now, project.id));
    stmts.push(sessionWorking(db, sessionId, project.id, now, note));
    await db.batch(stmts);
    return 'started';
  }

  if (inList(HOOK_EVENTS.heartbeat, event)) {
    const res = await db
      .prepare('UPDATE time_entries SET last_seen_at = ? WHERE session_id = ? AND stopped_at IS NULL')
      .bind(now, sessionId)
      .run();
    let result: 'started' | 'heartbeat' | 'bound' = 'heartbeat';
    let projectId: string | null = null;
    if (res.meta.changes === 0) {
      // Немає запущеного запису: дозвіл щойно дали, трекер встановили посеред ходу або cron закрив запис.
      // Продовжуємо облік — з тією самою задачею, до якої прив'язана сесія.
      // Виняток: сесію зупинили вручну з вебу — тоді чекаємо нового промпту.
      const session = await db
        .prepare('SELECT last_prompt, stopped_by_user_at FROM agent_sessions WHERE session_id = ?')
        .bind(sessionId)
        .first<{ last_prompt: string | null; stopped_by_user_at: number | null }>();
      if (session?.stopped_by_user_at) return 'ignored';
      const project = await resolveProject(db, dir, now);
      projectId = project.id;
      await insertEntry(db, project.id, await boundTask(db, sessionId, project.id), sessionId, 'claude_code', now, session?.last_prompt ?? null).run();
      result = 'started';
    }
    if (projectId) await sessionWorking(db, sessionId, projectId, now, null).run();
    else {
      await db
        .prepare("UPDATE agent_sessions SET state = 'working', waiting_since = NULL, waiting_reason = NULL, updated_at = ? WHERE session_id = ? AND state != 'ended'")
        .bind(now, sessionId)
        .run();
    }
    // Агент викликав timer_task_start / timer_task_add(start) — тепер знаємо його сесію точно.
    if (event === 'PostToolUse' && input.tool_name && TASK_START_TOOL.test(input.tool_name)) {
      const ti = input.tool_input ?? {};
      const isAdd = input.tool_name.endsWith('__timer_task_add');
      if (!isAdd || ti.start === true) {
        const ref = String((isAdd ? ti.title : ti.task) ?? '').trim();
        const projectRef = typeof ti.project === 'string' ? ti.project : null;
        const project = projectRef
          ? await findProjectByRef(db, projectRef)
          : await findProjectByPath(db, typeof ti.cwd === 'string' && ti.cwd ? ti.cwd : dir);
        if (ref && project) {
          const task = await findTaskByRef(db, ref, project.id, now).catch(() => null);
          if (task && task.status !== 'done') {
            await startTask(db, task.id, now, sessionId);
            result = 'bound';
          }
        }
      }
    }
    return result;
  }

  return 'ignored';
}

function insertEntry(
  db: D1Database,
  projectId: string,
  taskId: string | null,
  sessionId: string,
  source: Entry['source'],
  start: number,
  note: string | null,
  stop: number | null = null,
): D1PreparedStatement {
  return db
    .prepare(
      'INSERT INTO time_entries (id, project_id, task_id, session_id, source, started_at, stopped_at, last_seen_at, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(uid(), projectId, taskId, sessionId, source, start, stop, stop ?? start, note);
}

/**
 * Зупинити сесію агента вручну (з вебу): закрити її запущені записи й прибрати з «Працюють» / «Чекають».
 * Heartbeat-и цієї сесії більше не відновлюють облік; новий промпт (UserPromptSubmit) — відновлює.
 * Прив'язка до задачі лишається: якщо агент продовжить, час знову піде в ту саму задачу.
 */
export async function stopSession(db: D1Database, sessionId: string, now: number): Promise<{ stopped: number }> {
  if (!sessionId || sessionId === MANUAL) throw new TimerError('Ручні таймери зупиняються за проєктом: POST /api/projects/:id/stop');
  const [res, sess] = await db.batch([
    stopSessionEntries(db, sessionId, now),
    db
      .prepare(
        `UPDATE agent_sessions SET state = 'ended', waiting_reason = NULL, waiting_since = NULL, stopped_by_user_at = ?1, updated_at = ?1
         WHERE session_id = ?2`,
      )
      .bind(now, sessionId),
  ]);
  const stopped = res.meta.changes ?? 0;
  if (stopped === 0 && (sess.meta.changes ?? 0) === 0) throw new TimerError(`Сесію ${sessionId} не знайдено`, 404);
  return { stopped };
}

/**
 * Cron: закрити записи агентів без heartbeat, прибрати порожні й підчистити стан сесій.
 * Сесія, що «працює» без запущеного запису (агент упав, термінал закрили), вважається завершеною;
 * «чекає» довше доби — теж.
 */
export async function closeStale(db: D1Database, now: number, staleMs: number): Promise<number> {
  const [closed] = await db.batch([
    db
      .prepare("UPDATE time_entries SET stopped_at = last_seen_at WHERE stopped_at IS NULL AND source = 'claude_code' AND last_seen_at < ?")
      .bind(now - staleMs),
    db.prepare("DELETE FROM time_entries WHERE source = 'claude_code' AND stopped_at IS NOT NULL AND stopped_at - started_at < 1000"),
    db
      .prepare(
        `UPDATE agent_sessions SET state = 'ended', updated_at = ?1
         WHERE (state = 'working' AND updated_at < ?2
                AND session_id NOT IN (SELECT session_id FROM time_entries WHERE stopped_at IS NULL))
            OR (state = 'waiting' AND waiting_since < ?3)`,
      )
      .bind(now, now - staleMs, now - 24 * 3600_000),
    db.prepare("DELETE FROM agent_sessions WHERE state = 'ended' AND updated_at < ?").bind(now - 7 * 24 * 3600_000),
  ]);
  return closed.meta.changes ?? 0;
}

// ───────────────────────────── Екран «Зараз» ─────────────────────────────

export interface WaitingSession {
  session_id: string;
  project_id: string;
  project_name: string;
  project_color: string | null;
  last_prompt: string | null;
  waiting_reason: string | null;
  waiting_since: number;
  task_title: string | null;
  task_ref: string | null;
  /** Останній запис сесії — щоб підправити його час з екрана «Зараз». */
  entry_id: string | null;
  entry_started_at: number | null;
  entry_stopped_at: number | null;
}

export async function listWaiting(db: D1Database): Promise<WaitingSession[]> {
  return (
    await db
      .prepare(
        `SELECT s.session_id, s.project_id, p.name AS project_name, p.color AS project_color, s.last_prompt, s.waiting_reason, s.waiting_since,
                t.title AS task_title, t.external_ref AS task_ref,
                le.id AS entry_id, le.started_at AS entry_started_at, le.stopped_at AS entry_stopped_at
         FROM agent_sessions s
         JOIN projects p ON p.id = s.project_id
         LEFT JOIN time_entries le ON le.id = (
           SELECT id FROM time_entries WHERE session_id = s.session_id ORDER BY started_at DESC LIMIT 1)
         LEFT JOIN session_tasks st ON st.session_id = s.session_id AND st.project_id = s.project_id
         LEFT JOIN tasks t ON t.id = st.task_id AND t.status != 'done'
         WHERE s.state = 'waiting'
         ORDER BY s.waiting_since`,
      )
      .all<WaitingSession>()
  ).results;
}

export interface TimelineLane {
  project_id: string;
  name: string;
  color: string | null;
  /** Час проєкту за день (повний режим), мс. */
  total_ms: number;
  /** Об'єднані інтервали проєкту, обрізані межами дня; stop = null — іде зараз. */
  intervals: [number, number | null][];
}

export interface Timeline {
  from: number;
  to: number;
  now: number;
  wall_ms: number;
  sum_full_ms: number;
  parallelism: number;
  lanes: TimelineLane[];
}

/** Шкала дня: коли працював кожен проєкт і скільки разом. */
export async function dayTimeline(db: D1Database, from: number, to: number, now: number): Promise<Timeline> {
  const entries = (
    await db
      .prepare('SELECT project_id, started_at, stopped_at FROM time_entries WHERE started_at < ? AND (stopped_at IS NULL OR stopped_at > ?)')
      .bind(to, from)
      .all<{ project_id: string; started_at: number; stopped_at: number | null }>()
  ).results;
  const end = Math.min(to, now);
  const full = allocate(
    entries.map((e) => ({ taskId: e.project_id, start: e.started_at, stop: e.stopped_at })),
    from,
    end,
    now,
    'full',
  );
  const byProject = new Map<string, { s: number; e: number; live: boolean }[]>();
  for (const e of entries) {
    const s = Math.max(e.started_at, from);
    const live = e.stopped_at === null;
    const x = Math.min(e.stopped_at ?? now, end);
    if (x <= s) continue;
    byProject.set(e.project_id, [...(byProject.get(e.project_id) ?? []), { s, e: x, live }]);
  }
  const projects = new Map((await listProjects(db, true)).map((p) => [p.id, p]));
  const lanes: TimelineLane[] = [...byProject.entries()].map(([pid, list]) => {
    list.sort((a, b) => a.s - b.s);
    const merged: { s: number; e: number; live: boolean }[] = [];
    for (const iv of list) {
      const last = merged[merged.length - 1];
      if (last && iv.s <= last.e) {
        last.e = Math.max(last.e, iv.e);
        last.live = last.live || iv.live;
      } else merged.push({ ...iv });
    }
    const p = projects.get(pid);
    return {
      project_id: pid,
      name: p?.name ?? '?',
      color: p?.color ?? null,
      total_ms: full.perTask[pid] ?? 0,
      intervals: merged.map((m) => [m.s, m.live && m.e >= end ? null : m.e] as [number, number | null]),
    };
  });
  lanes.sort((a, b) => b.total_ms - a.total_ms);
  const sum = Object.values(full.perTask).reduce((a, b) => a + b, 0);
  return { from, to, now, wall_ms: full.wall, sum_full_ms: sum, parallelism: full.wall ? sum / full.wall : 0, lanes };
}

// ───────────────────────────── Ручний таймер ─────────────────────────────

async function checkTaskInProject(db: D1Database, taskId: string | null | undefined, projectId: string, now: number) {
  if (!taskId) return null;
  const t = await getTask(db, taskId, now);
  if (t.project_id !== projectId) throw new TimerError(`Задача «${t.title}» належить проєкту «${t.project_name}»`);
  return t;
}

export async function startManual(
  db: D1Database,
  projectId: string,
  note: string | null,
  now: number,
  taskId?: string | null,
): Promise<Entry> {
  const project = await getProject(db, projectId);
  if (project.archived_at !== null) throw new TimerError(`Проєкт «${project.name}» в архіві`);
  const task = await checkTaskInProject(db, taskId, projectId, now);
  if (task?.status === 'done') throw new TimerError(`Задача «${task.title}» уже виконана`);
  const running = await db
    .prepare('SELECT id FROM time_entries WHERE project_id = ? AND session_id = ? AND stopped_at IS NULL')
    .bind(projectId, MANUAL)
    .first();
  if (running) throw new TimerError(`Таймер «${project.name}» уже йде`, 409);
  const stmts = [
    insertEntry(db, projectId, task?.id ?? null, MANUAL, 'manual', now, summarize(note, 500)),
    // Ручний старт теж переносить фокус (режим focus у звітах).
    db.prepare('INSERT INTO focus_switches (at, project_id) VALUES (?, ?)').bind(now, projectId),
  ];
  if (task?.status === 'todo') stmts.push(db.prepare("UPDATE tasks SET status = 'doing' WHERE id = ?").bind(task.id));
  try {
    await db.batch(stmts);
  } catch (e) {
    // Подвійний клік: друга вставка впирається в one_running_per_session.
    if (String(e).includes('UNIQUE')) throw new TimerError(`Таймер «${project.name}» уже йде`, 409);
    throw e;
  }
  return (await db
    .prepare('SELECT * FROM time_entries WHERE project_id = ? AND session_id = ? AND stopped_at IS NULL')
    .bind(projectId, MANUAL)
    .first<Entry>())!;
}

/** Зупинити ручні таймери (одного проєкту або всіх). Короткі записи відкидаються. */
export async function stopManual(
  db: D1Database,
  now: number,
  projectId?: string,
): Promise<{ stopped: number; discarded: number }> {
  const running = (
    await db
      .prepare(`SELECT * FROM time_entries WHERE session_id = ? AND stopped_at IS NULL${projectId ? ' AND project_id = ?' : ''}`)
      .bind(...(projectId ? [MANUAL, projectId] : [MANUAL]))
      .all<Entry>()
  ).results;
  if (running.length === 0) return { stopped: 0, discarded: 0 };
  let discarded = 0;
  const stmts = running.map((r) => {
    if (now - r.started_at < MIN_MANUAL_MS) {
      discarded++;
      return db.prepare('DELETE FROM time_entries WHERE id = ?').bind(r.id);
    }
    return db.prepare('UPDATE time_entries SET stopped_at = ?, last_seen_at = ? WHERE id = ?').bind(now, now, r.id);
  });
  await db.batch(stmts);
  return { stopped: running.length - discarded, discarded };
}

/** Зупинити всі ручні таймери і запустити один — звична поведінка Toggl. */
export async function switchTo(
  db: D1Database,
  projectId: string,
  note: string | null,
  now: number,
  taskId?: string | null,
): Promise<Entry> {
  const project = await getProject(db, projectId);
  // Перевіряємо до зупинки інших таймерів, щоб невдалий перемикач нічого не зламав.
  if (project.archived_at !== null) throw new TimerError(`Проєкт «${project.name}» в архіві`);
  const task = await checkTaskInProject(db, taskId, projectId, now);
  if (task?.status === 'done') throw new TimerError(`Задача «${task.title}» уже виконана`);
  await stopManual(db, now);
  return startManual(db, projectId, note, now, taskId);
}

// ───────────────────────────── Записи ─────────────────────────────

async function assertNoManualOverlap(
  db: D1Database,
  projectId: string,
  start: number,
  stop: number,
  now: number,
  excludeId?: string,
) {
  const clash = await db
    .prepare(
      `SELECT id FROM time_entries
       WHERE project_id = ? AND session_id = ? AND id != ?
         AND started_at < ? AND COALESCE(stopped_at, ?) > ?
       LIMIT 1`,
    )
    .bind(projectId, MANUAL, excludeId ?? '', stop, now, start)
    .first();
  if (clash) throw new TimerError('Ручні записи одного проєкту не можуть перекриватися', 409);
}

export async function createEntry(
  db: D1Database,
  input: { project_id: string; task_id?: string | null; start: number; stop?: number; duration_ms?: number; note?: string | null },
  now: number,
): Promise<Entry> {
  await getProject(db, input.project_id);
  const task = await checkTaskInProject(db, input.task_id, input.project_id, now);
  const start = input.start;
  const stop = input.stop ?? (input.duration_ms !== undefined ? start + input.duration_ms : undefined);
  if (stop === undefined) throw new TimerError('Потрібен stop або duration_ms');
  if (!(start < stop)) throw new TimerError('Початок має бути раніше за кінець');
  if (stop - start < MIN_MANUAL_MS) throw new TimerError('Ручний запис має тривати щонайменше хвилину');
  if (stop > now) throw new TimerError('Кінець не може бути в майбутньому');
  await assertNoManualOverlap(db, input.project_id, start, stop, now);
  const id = uid();
  await db
    .prepare(
      'INSERT INTO time_entries (id, project_id, task_id, session_id, source, started_at, stopped_at, last_seen_at, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(id, input.project_id, task?.id ?? null, MANUAL, 'manual', start, stop, stop, summarize(input.note, 500))
    .run();
  return getEntry(db, id);
}

export async function getEntry(db: D1Database, id: string): Promise<Entry> {
  const e = await db.prepare('SELECT * FROM time_entries WHERE id = ?').bind(id).first<Entry>();
  if (!e) throw new TimerError(`Запис ${id} не знайдено`, 404);
  return e;
}

/**
 * Правка як у Toggl: нова тривалість рухає кінець, початок лишається.
 * У запущеного запису можна змінити початок, нотатку, проєкт, задачу або зупинити його (stop).
 * task_id: null — відв'язати від задачі; undefined — не чіпати.
 */
export async function updateEntry(
  db: D1Database,
  id: string,
  patch: { start?: number; stop?: number; duration_ms?: number; note?: string | null; project_id?: string; task_id?: string | null },
  now: number,
): Promise<Entry> {
  const e = await getEntry(db, id);
  const start = patch.start ?? e.started_at;
  let stop = e.stopped_at;
  if (patch.stop !== undefined) stop = patch.stop;
  else if (patch.duration_ms !== undefined) {
    if (e.stopped_at === null) throw new TimerError('У запущеного запису тривалість не задається — змініть початок або зупиніть його');
    stop = start + patch.duration_ms;
  }
  if (stop !== null && !(start < stop)) throw new TimerError('Початок має бути раніше за кінець');
  if ((stop ?? start) > now) throw new TimerError('Час не може бути в майбутньому');
  const projectId = patch.project_id ?? e.project_id;
  if (patch.project_id) await getProject(db, patch.project_id);
  let taskId = patch.task_id === undefined ? e.task_id : patch.task_id;
  // Запис переїхав в інший проєкт — стара задача йому вже не пасує.
  if (patch.project_id && patch.project_id !== e.project_id && patch.task_id === undefined) taskId = null;
  await checkTaskInProject(db, taskId, projectId, now);
  if (e.session_id === MANUAL) {
    if (stop !== null && stop - start < MIN_MANUAL_MS) throw new TimerError('Ручний запис має тривати щонайменше хвилину');
    await assertNoManualOverlap(db, projectId, start, stop ?? now, now, id);
  }
  const note = patch.note === undefined ? e.note : summarize(patch.note, 500);
  try {
    await db
      .prepare('UPDATE time_entries SET started_at = ?, stopped_at = ?, last_seen_at = ?, note = ?, project_id = ?, task_id = ? WHERE id = ?')
      .bind(start, stop, Math.max(e.last_seen_at, stop ?? start), note, projectId, taskId, id)
      .run();
  } catch (err) {
    if (String(err).includes('UNIQUE')) throw new TimerError('У цьому проєкті вже йде такий таймер', 409);
    throw err;
  }
  return getEntry(db, id);
}

export async function deleteEntry(db: D1Database, id: string): Promise<void> {
  await getEntry(db, id);
  await db.prepare('DELETE FROM time_entries WHERE id = ?').bind(id).run();
}

const ENTRY_WITH_PROJECT = `SELECT e.*, p.name AS project_name, p.color AS project_color, t.title AS task_title, t.external_ref AS task_ref
  FROM time_entries e JOIN projects p ON p.id = e.project_id LEFT JOIN tasks t ON t.id = e.task_id`;

export const ENTRIES_LIMIT = 1000;

/** Записи, що перетинають [from, to), найновіші першими. truncated = є ще старіші за ліміт. */
export async function listEntries(
  db: D1Database,
  from: number,
  to: number,
  filter: { projectId?: string; taskId?: string } = {},
  limit = ENTRIES_LIMIT,
): Promise<{ entries: EntryWithProject[]; truncated: boolean }> {
  const cond: string[] = [];
  const args: unknown[] = [to, from];
  if (filter.projectId) {
    cond.push('e.project_id = ?');
    args.push(filter.projectId);
  }
  if (filter.taskId) {
    cond.push('e.task_id = ?');
    args.push(filter.taskId);
  }
  args.push(limit + 1);
  const rows = (
    await db
      .prepare(
        `${ENTRY_WITH_PROJECT} WHERE e.started_at < ? AND (e.stopped_at IS NULL OR e.stopped_at > ?)${cond.map((c) => ` AND ${c}`).join('')}
         ORDER BY e.started_at DESC LIMIT ?`,
      )
      .bind(...args)
      .all<EntryWithProject>()
  ).results;
  return { entries: rows.slice(0, limit), truncated: rows.length > limit };
}

export async function listRunning(db: D1Database): Promise<EntryWithProject[]> {
  return (await db.prepare(`${ENTRY_WITH_PROJECT} WHERE e.stopped_at IS NULL ORDER BY e.started_at`).all<EntryWithProject>()).results;
}

/** Підписати запущений запис агента в проєкті (MCP timer_label). */
export async function labelRunning(db: D1Database, cwd: string, note: string, now: number): Promise<number> {
  const project = await findProjectByPath(db, cwd);
  if (!project) {
    throw new TimerError(`Для ${cwd} немає проєкту — агент тут ще не стартував або шлях не прив'язаний (timer_projects add_path)`, 404);
  }
  const res = await db
    .prepare(
      `UPDATE time_entries SET note = ?, last_seen_at = ?
       WHERE id = (SELECT id FROM time_entries WHERE project_id = ? AND source = 'claude_code' AND stopped_at IS NULL
                   ORDER BY last_seen_at DESC LIMIT 1)`,
    )
    .bind(summarize(note, 500), now, project.id)
    .run();
  return res.meta.changes ?? 0;
}

// ───────────────────────────── Звіти ─────────────────────────────

export interface ReportRow {
  project_id: string;
  name: string;
  color: string | null;
  ms: number;
}

export interface ReportTaskRow {
  task_id: string;
  title: string;
  project_id: string;
  project_name: string;
  status: TaskStatus;
  /** Час задачі в повному режимі (час агентів над нею) за період. */
  ms: number;
}

export interface Report {
  from: number;
  to: number;
  mode: Mode;
  timezone: string;
  /** Реальний час: коли йшов хоча б один запис. */
  wall_ms: number;
  /** Сума в повному режимі (кожен проєкт — весь свій час). */
  sum_full_ms: number;
  /** sum_full / wall: скільки проєктів у середньому йшло одночасно. */
  parallelism: number;
  /** Середнє за день = реальний час / дні з записами (як у Toggl). */
  avg_daily_ms: number;
  days_with_entries: number;
  running_included: boolean;
  projects: ReportRow[];
  /** Задачі з часом за період, за спаданням (до 50). */
  tasks: ReportTaskRow[];
  days: { date: string; wall_ms: number; sum_full_ms: number; projects: Record<string, number> }[];
}

export async function report(
  db: D1Database,
  q: { from: number; to: number; mode: Mode; tz: string; projectId?: string },
  now: number,
): Promise<Report> {
  if (!(q.from < q.to)) throw new TimerError('from має бути раніше за to');
  const to = Math.min(q.to, Math.max(now, q.from + 1));
  const entries = (
    await db
      .prepare(
        `SELECT project_id, task_id, started_at, stopped_at FROM time_entries
         WHERE started_at < ? AND (stopped_at IS NULL OR stopped_at > ?)${q.projectId ? ' AND project_id = ?' : ''}`,
      )
      .bind(...(q.projectId ? [to, q.from, q.projectId] : [to, q.from]))
      .all<{ project_id: string; task_id: string | null; started_at: number; stopped_at: number | null }>()
  ).results;
  const intervals = entries.map((e) => ({ taskId: e.project_id, start: e.started_at, stop: e.stopped_at }));

  const focus =
    q.mode === 'focus'
      ? (
          await db
            .prepare(
              `SELECT at, project_id FROM focus_switches
               WHERE at < ? AND at >= COALESCE((SELECT MAX(at) FROM focus_switches WHERE at <= ?), 0)
               ORDER BY at`,
            )
            .bind(to, q.from)
            .all<{ at: number; project_id: string | null }>()
        ).results.map((f) => ({ at: f.at, taskId: f.project_id }))
      : [];

  const main = allocate(intervals, q.from, to, now, q.mode, focus);
  const full = q.mode === 'full' ? main : allocate(intervals, q.from, to, now, 'full');
  const sumFull = Object.values(full.perTask).reduce((a, b) => a + b, 0);

  const projects = new Map((await listProjects(db, true)).map((p) => [p.id, p]));
  const rows: ReportRow[] = Object.entries(main.perTask)
    .map(([project_id, ms]) => ({ project_id, ms, name: projects.get(project_id)?.name ?? '?', color: projects.get(project_id)?.color ?? null }))
    .sort((a, b) => b.ms - a.ms);

  // Задачі: повний режим (час агентів над задачею); дві сесії над однією задачею рахуються один раз.
  const taskIntervals = entries.filter((e) => e.task_id).map((e) => ({ taskId: e.task_id!, start: e.started_at, stop: e.stopped_at }));
  const taskTimes = allocate(taskIntervals, q.from, to, now, 'full').perTask;
  const taskIds = Object.keys(taskTimes);
  const taskInfo = new Map<string, TaskWithTime>();
  for (const t of await listTasks(db, { status: 'all' }, now)) if (taskTimes[t.id] !== undefined) taskInfo.set(t.id, t);
  const tasks: ReportTaskRow[] = taskIds
    .filter((id) => taskInfo.has(id))
    .map((id) => {
      const t = taskInfo.get(id)!;
      return { task_id: id, title: t.title, project_id: t.project_id, project_name: t.project_name, status: t.status, ms: taskTimes[id] };
    })
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 50);

  const days = dayRanges(q.from, q.to, q.tz).map((d) => {
    if (d.start >= to) return { date: d.date, wall_ms: 0, sum_full_ms: 0, projects: {} };
    const s = Math.max(d.start, q.from);
    const e = Math.min(d.end, to);
    const a = allocate(intervals, s, e, now, q.mode, focus);
    const f = q.mode === 'full' ? a : allocate(intervals, s, e, now, 'full');
    return { date: d.date, wall_ms: a.wall, sum_full_ms: Object.values(f.perTask).reduce((x, y) => x + y, 0), projects: a.perTask };
  });
  const daysWith = days.filter((d) => d.wall_ms > 0).length;

  return {
    from: q.from,
    to: q.to,
    mode: q.mode,
    timezone: q.tz,
    wall_ms: main.wall,
    sum_full_ms: sumFull,
    parallelism: main.wall > 0 ? sumFull / main.wall : 0,
    avg_daily_ms: daysWith > 0 ? main.wall / daysWith : 0,
    days_with_entries: daysWith,
    running_included: entries.some((e) => e.stopped_at === null),
    projects: rows,
    tasks,
    days,
  };
}
