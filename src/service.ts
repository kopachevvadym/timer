/**
 * Бізнес-логіка трекера. Використовується REST API, MCP-сервером, хуками і cron.
 * Усі моменти часу — мілісекунди UTC; `now` передається ззовні (тестованість).
 *
 * Словник: проєкт (projects) — папка/репозиторій, куди хуки пишуть час агентів;
 * задача (tasks) — конкретна робота всередині проєкту; запис (time_entries) — інтервал часу
 * проєкту, за бажанням прив'язаний до задачі.
 *
 * Кілька користувачів: кожна функція отримує Scope { db, uid } і бачить лише рядки з user_id = uid.
 * Правило: КОЖЕН запит до projects / tasks / time_entries / agent_sessions / session_tasks /
 * focus_switches / project_paths має умову user_id = uid (крім cron closeStale, що працює для всіх).
 */
import { allocate, concurrency, type Mode } from './allocate';
import { days as dayRanges } from './time';

export class TimerError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

/** Доступ до даних одного користувача. */
export interface Scope {
  db: D1Database;
  uid: string;
}

export interface Project {
  id: string;
  name: string;
  /** Шляхи проєкту на диску; хук знаходить проєкт за найдовшим префіксом cwd. */
  paths: string[];
  /** Репозиторій (host/owner/name) — за ним MCP знаходить проєкт із будь-якої папки-клону. */
  repo: string | null;
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

/** Сесія агента в базі: '<user>:<session_id з Claude Code>' — чужий хук не зачепить вашу сесію. */
export function sessionKey(userId: string, raw: string): string {
  return `${userId}:${raw}`;
}

export function normalizePath(p: string): string {
  const t = p.trim();
  return t.length > 1 ? t.replace(/\/+$/, '') : t;
}

/**
 * Репозиторій до вигляду host/owner/name: git@github.com:o/n.git, https://github.com/o/n, o/n (→ github.com).
 * null — якщо не схоже на репозиторій.
 */
export function normalizeRepo(input: string | null | undefined): string | null {
  let r = (input ?? '').trim().toLowerCase();
  if (!r) return null;
  r = r.replace(/\.git$/, '').replace(/\/+$/, '');
  const scp = /^[\w.-]+@([\w.-]+):(.+)$/.exec(r); // git@host:owner/name
  if (scp) r = `${scp[1]}/${scp[2]}`;
  else r = r.replace(/^[a-z+]+:\/\//, '').replace(/^[^@/]+@/, ''); // https://, ssh://user@
  const parts = r.split('/').filter(Boolean);
  if (parts.length === 2) parts.unshift('github.com');
  if (parts.length < 3 || !parts[0].includes('.') || parts.some((x) => !/^[\w.-]+$/.test(x))) return null;
  return parts.join('/').slice(0, 200);
}

/** Тимчасові папки хмарних сесій і /tmp: за такою папкою проєкт не створюємо й шлях не прив'язуємо. */
export function isEphemeralPath(p: string): boolean {
  return /^\/(home\/claude|home\/user|root|tmp|private\/tmp|var\/folders|workspace|mnt|sessions)(\/|$)/.test(normalizePath(p));
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
  repo: string | null;
  color: string | null;
  created_at: number;
  archived_at: number | null;
}

const PROJECT_COLS = 'id, name, repo, color, created_at, archived_at';
const COLOR_RE = /^#[0-9a-f]{3,8}$/i;
/** Обмеження на користувача — щоб один акаунт не з'їв базу. */
export const LIMITS = {
  projects: 500,
  tasksPerProject: 2000,
  tasksPerUser: 10_000,
  pathsPerProject: 50,
  /** Нових записів за добу (агент на кожен промпт створює один). */
  entriesPerDay: 3000,
  entriesTotal: 500_000,
} as const;

/** Чи вичерпано ліміт записів (за добу або загалом). */
async function entryQuotaExceeded(s: Scope, now: number): Promise<boolean> {
  const r = await s.db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM time_entries WHERE user_id = ?1 AND started_at > ?2) AS day,
              (SELECT COUNT(*) FROM time_entries WHERE user_id = ?1) AS total`,
    )
    .bind(s.uid, now - 24 * 3600_000)
    .first<{ day: number; total: number }>();
  return (r?.day ?? 0) >= LIMITS.entriesPerDay || (r?.total ?? 0) >= LIMITS.entriesTotal;
}

async function assertEntryQuota(s: Scope, now: number) {
  if (await entryQuotaExceeded(s, now)) {
    throw new TimerError(`Досягнуто ліміту записів (${LIMITS.entriesPerDay} за добу або ${LIMITS.entriesTotal} загалом)`, 429);
  }
}

/** Перемикання фокусу; поспіль однаковий проєкт не пишемо — фокус від цього не змінюється. */
function focusSwitch(s: Scope, projectId: string, now: number): D1PreparedStatement {
  return s.db
    .prepare(
      `INSERT INTO focus_switches (at, project_id, user_id)
       SELECT ?1, ?2, ?3 WHERE NOT EXISTS (
         SELECT 1 FROM focus_switches f WHERE f.user_id = ?3 AND f.project_id = ?2
           AND f.at = (SELECT MAX(at) FROM focus_switches WHERE user_id = ?3))`,
    )
    .bind(now, projectId, s.uid);
}

function checkColor(color: string | null | undefined): string | null {
  if (color === undefined || color === null || color === '') return null;
  if (!COLOR_RE.test(color)) throw new TimerError('Колір — hex на кшталт #d9643a');
  return color;
}

/** Назви активних проєктів унікальні (без урахування регістру), щоб MCP міг шукати проєкт за назвою. */
async function nameTaken(s: Scope, name: string, exceptId = ''): Promise<boolean> {
  // lower() у SQLite знає лише ASCII, тому порівнюємо в JS (кирилиця).
  const key = lower(name);
  const rows = (
    await s.db
      .prepare('SELECT id, name FROM projects WHERE user_id = ? AND archived_at IS NULL AND id != ?')
      .bind(s.uid, exceptId)
      .all<{ id: string; name: string }>()
  ).results;
  return rows.some((r) => lower(r.name) === key);
}

/** «api» → «api (2)», якщо «api» вже зайнята. */
async function uniqueName(s: Scope, base: string, exceptId = ''): Promise<string> {
  let name = base;
  for (let i = 2; await nameTaken(s, name, exceptId); i++) name = `${base} (${i})`;
  return name;
}

async function withPaths(s: Scope, rows: ProjectRow[]): Promise<Project[]> {
  if (rows.length === 0) return [];
  const paths = (
    await s.db.prepare('SELECT path, project_id FROM project_paths WHERE user_id = ? ORDER BY path').bind(s.uid).all<{ path: string; project_id: string }>()
  ).results;
  const byProject = new Map<string, string[]>();
  for (const p of paths) byProject.set(p.project_id, [...(byProject.get(p.project_id) ?? []), p.path]);
  return rows.map((r) => ({ ...r, paths: byProject.get(r.id) ?? [] }));
}

export async function listProjects(s: Scope, includeArchived = false): Promise<Project[]> {
  const sql = includeArchived
    ? `SELECT ${PROJECT_COLS} FROM projects WHERE user_id = ? ORDER BY archived_at IS NOT NULL, name`
    : `SELECT ${PROJECT_COLS} FROM projects WHERE user_id = ? AND archived_at IS NULL ORDER BY name`;
  return withPaths(s, (await s.db.prepare(sql).bind(s.uid).all<ProjectRow>()).results);
}

export async function getProject(s: Scope, id: string): Promise<Project> {
  const p = await s.db.prepare(`SELECT ${PROJECT_COLS} FROM projects WHERE id = ? AND user_id = ?`).bind(id, s.uid).first<ProjectRow>();
  if (!p) throw new TimerError(`Проєкт ${id} не знайдено`, 404);
  return (await withPaths(s, [p]))[0];
}

/** Проєкт за id або назвою (активний має пріоритет над архівним). */
export async function findProjectByRef(s: Scope, ref: string): Promise<Project | null> {
  const all = await listProjects(s, true);
  const r = lower(ref);
  const byName = all.filter((p) => lower(p.name) === r);
  return all.find((p) => p.id === ref.trim()) ?? byName.find((p) => p.archived_at === null) ?? byName[0] ?? null;
}

export async function findProjectByRepo(s: Scope, repo: string): Promise<Project | null> {
  const r = normalizeRepo(repo);
  if (!r) return null;
  const p = await s.db.prepare(`SELECT ${PROJECT_COLS} FROM projects WHERE user_id = ? AND repo = ?`).bind(s.uid, r).first<ProjectRow>();
  return p ? (await withPaths(s, [p]))[0] : null;
}

/** Прив'язати репозиторій до проєкту (null — відв'язати). */
export async function setProjectRepo(s: Scope, id: string, repo: string | null): Promise<Project> {
  await getProject(s, id);
  const r = repo === null ? null : normalizeRepo(repo);
  if (repo !== null && !r) throw new TimerError('repo: очікується owner/name або URL git remote');
  if (r) {
    const other = await findProjectByRepo(s, r);
    if (other && other.id !== id) throw new TimerError(`Репозиторій ${r} уже прив'язаний до «${other.name}» — об'єднайте проєкти (merge)`, 409);
  }
  await s.db.prepare('UPDATE projects SET repo = ? WHERE id = ? AND user_id = ?').bind(r, id, s.uid).run();
  return getProject(s, id);
}

/** Проєкт, чий шлях — найдовший префікс cwd. */
export async function findProjectByPath(s: Scope, cwd: string): Promise<Project | null> {
  const path = normalizePath(cwd);
  const all = (
    await s.db.prepare('SELECT path, project_id FROM project_paths WHERE user_id = ?').bind(s.uid).all<{ path: string; project_id: string }>()
  ).results;
  let best: { path: string; project_id: string } | null = null;
  for (const p of all) {
    if ((path === p.path || path.startsWith(`${p.path}/`)) && (!best || p.path.length > best.path.length)) best = p;
  }
  return best ? getProject(s, best.project_id) : null;
}

async function assertProjectQuota(s: Scope) {
  const n = await s.db.prepare('SELECT COUNT(*) AS n FROM projects WHERE user_id = ?').bind(s.uid).first<{ n: number }>();
  if ((n?.n ?? 0) >= LIMITS.projects) throw new TimerError(`Досягнуто ліміту в ${LIMITS.projects} проєктів — об'єднайте або видаліть зайві`, 429);
}

/** Знайти проєкт для cwd або створити новий з назвою останньої папки. */
export async function resolveProject(s: Scope, cwd: string, now: number): Promise<Project> {
  const { db } = s;
  const found = await findProjectByPath(s, cwd);
  if (found) {
    if (found.archived_at !== null) {
      // Агент знову працює в архівному проєкті — повертаємо його з архіву (з вільною назвою).
      const name = await uniqueName(s, found.name, found.id);
      await db.prepare('UPDATE projects SET archived_at = NULL, name = ? WHERE id = ? AND user_id = ?').bind(name, found.id, s.uid).run();
      return { ...found, name, archived_at: null };
    }
    return found;
  }
  const path = normalizePath(cwd);
  if (!path.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(path)) throw new TimerError('cwd має бути абсолютним шляхом');
  const base = summarize(basename(cwd), 80) ?? 'project';
  // Проєкт з такою ж назвою, створений вручну (через веб чи MCP) і ще без шляху, — це він:
  // прив'язуємо папку до нього замість дубля «назва (2)».
  const sameName = (await listProjects(s)).find((p) => lower(p.name) === lower(base) && p.paths.length === 0);
  if (sameName) {
    await db.prepare('INSERT INTO project_paths (user_id, path, project_id) VALUES (?, ?, ?) ON CONFLICT(user_id, path) DO NOTHING').bind(s.uid, path, sameName.id).run();
    return (await findProjectByPath(s, cwd)) ?? getProject(s, sameName.id);
  }
  await assertProjectQuota(s);
  const id = uid();
  const name = await uniqueName(s, base);
  await db.batch([
    db.prepare('INSERT INTO projects (id, user_id, name, color, created_at) VALUES (?, ?, ?, NULL, ?)').bind(id, s.uid, name, now),
    // Два агенти одночасно в новій папці: шлях дістається першому, другий підхопить його проєкт нижче.
    db.prepare('INSERT INTO project_paths (user_id, path, project_id) VALUES (?, ?, ?) ON CONFLICT(user_id, path) DO NOTHING').bind(s.uid, path, id),
  ]);
  const owner = await findProjectByPath(s, cwd);
  if (owner && owner.id !== id) {
    await db.prepare('DELETE FROM projects WHERE id = ? AND user_id = ?').bind(id, s.uid).run();
    return owner;
  }
  return owner ?? getProject(s, id);
}

export async function createProject(
  s: Scope,
  input: { name: string; path?: string | null; color?: string | null },
  now: number,
): Promise<Project> {
  const { db } = s;
  const name = summarize(input.name, 80);
  if (!name) throw new TimerError('Потрібна назва проєкту');
  if (await nameTaken(s, name)) throw new TimerError(`Проєкт «${name}» уже є`, 409);
  await assertProjectQuota(s);
  const id = uid();
  const stmts = [
    db.prepare('INSERT INTO projects (id, user_id, name, color, created_at) VALUES (?, ?, ?, ?, ?)').bind(id, s.uid, name, checkColor(input.color), now),
  ];
  if (input.path) {
    stmts.push(db.prepare('INSERT INTO project_paths (user_id, path, project_id) VALUES (?, ?, ?)').bind(s.uid, normalizePath(input.path), id));
  }
  try {
    await db.batch(stmts);
  } catch (e) {
    if (String(e).includes('UNIQUE')) throw new TimerError(`Шлях ${input.path} уже прив'язаний до іншого проєкту`, 409);
    throw e;
  }
  return getProject(s, id);
}

export async function updateProject(
  s: Scope,
  id: string,
  patch: { name?: string; color?: string | null; archived?: boolean },
  now: number,
): Promise<Project> {
  const { db } = s;
  const p = await getProject(s, id);
  const newName = patch.name === undefined ? undefined : summarize(patch.name, 80);
  if (newName && (await nameTaken(s, newName, id))) throw new TimerError(`Проєкт «${newName}» уже є`, 409);
  if (patch.archived === false && p.archived_at !== null && (await nameTaken(s, newName || p.name, id))) {
    throw new TimerError(`Активний проєкт «${p.name}» уже є — спершу перейменуйте один із них`, 409);
  }
  const name = newName || p.name;
  const color = patch.color === undefined ? p.color : checkColor(patch.color);
  const archivedAt = patch.archived === undefined ? p.archived_at : patch.archived ? (p.archived_at ?? now) : null;
  const stmts = [db.prepare('UPDATE projects SET name = ?, color = ?, archived_at = ? WHERE id = ? AND user_id = ?').bind(name, color, archivedAt, id, s.uid)];
  // Архівний проєкт не може йти: зупиняємо його ручні таймери.
  if (patch.archived) {
    stmts.push(
      db
        .prepare('UPDATE time_entries SET stopped_at = ?, last_seen_at = ? WHERE user_id = ? AND project_id = ? AND session_id = ? AND stopped_at IS NULL')
        .bind(now, now, s.uid, id, MANUAL),
    );
  }
  await db.batch(stmts);
  return getProject(s, id);
}

/** Прив'язати шлях на диску до проєкту (хуки шукатимуть проєкт за ним). */
export async function addProjectPath(s: Scope, id: string, path: string): Promise<Project> {
  const { db } = s;
  const project = await getProject(s, id);
  const p = normalizePath(path);
  if (!p.startsWith('/') || p.length > 1000) throw new TimerError('Шлях має бути абсолютним');
  if (project.paths.length >= LIMITS.pathsPerProject) throw new TimerError(`У проєкту вже ${LIMITS.pathsPerProject} шляхів`, 429);
  const owner = await db.prepare('SELECT project_id FROM project_paths WHERE user_id = ? AND path = ?').bind(s.uid, p).first<{ project_id: string }>();
  if (owner && owner.project_id !== id) throw new TimerError(`Шлях ${p} уже прив'язаний до іншого проєкту — об'єднайте проєкти (merge)`, 409);
  await db.prepare('INSERT INTO project_paths (user_id, path, project_id) VALUES (?, ?, ?) ON CONFLICT(user_id, path) DO NOTHING').bind(s.uid, p, id).run();
  return getProject(s, id);
}

export async function removeProjectPath(s: Scope, id: string, path: string): Promise<Project> {
  await getProject(s, id);
  await s.db.prepare('DELETE FROM project_paths WHERE user_id = ? AND path = ? AND project_id = ?').bind(s.uid, normalizePath(path), id).run();
  return getProject(s, id);
}

/** Перенести записи, задачі й шляхи проєкту `fromId` у `intoId` і видалити `fromId`. */
export async function mergeProjects(s: Scope, fromId: string, intoId: string, now: number): Promise<Project> {
  const { db, uid: u } = s;
  if (fromId === intoId) throw new TimerError('Не можна об’єднати проєкт сам із собою');
  // Обидва проєкти мають належати цьому користувачу — інакше 404.
  const fromProject = await getProject(s, fromId);
  await getProject(s, intoId);
  // Ручні записи одного проєкту не перекриваються — перевіряємо до перенесення.
  const clash = await db
    .prepare(
      `SELECT a.id FROM time_entries a JOIN time_entries b
         ON a.user_id = ?1 AND b.user_id = ?1 AND a.project_id = ?2 AND b.project_id = ?3 AND a.session_id = ?4 AND b.session_id = ?4
        AND a.started_at < COALESCE(b.stopped_at, ?5) AND COALESCE(a.stopped_at, ?5) > b.started_at
       LIMIT 1`,
    )
    .bind(u, fromId, intoId, MANUAL, now)
    .first();
  if (clash) throw new TimerError('Ручні записи цих проєктів перекриваються — спершу виправте їх', 409);
  await db.batch([
    // Запущені записи зупиняємо, щоб не зламати «один запущений запис на сесію».
    db.prepare('UPDATE time_entries SET stopped_at = ?, last_seen_at = ? WHERE user_id = ? AND project_id = ? AND stopped_at IS NULL').bind(now, now, u, fromId),
    db.prepare('UPDATE time_entries SET project_id = ? WHERE user_id = ? AND project_id = ?').bind(intoId, u, fromId),
    db.prepare('UPDATE tasks SET project_id = ? WHERE user_id = ? AND project_id = ?').bind(intoId, u, fromId),
    db.prepare('UPDATE session_tasks SET project_id = ? WHERE user_id = ? AND project_id = ?').bind(intoId, u, fromId),
    db.prepare('UPDATE agent_sessions SET project_id = ? WHERE user_id = ? AND project_id = ?').bind(intoId, u, fromId),
    db.prepare('UPDATE focus_switches SET project_id = ? WHERE user_id = ? AND project_id = ?').bind(intoId, u, fromId),
    db.prepare('UPDATE project_paths SET project_id = ? WHERE user_id = ? AND project_id = ?').bind(intoId, u, fromId),
    // Репозиторій переходить до цільового проєкту, якщо в того свого немає (спершу звільняємо унікальний індекс).
    db.prepare('UPDATE projects SET repo = NULL WHERE id = ?1 AND user_id = ?2 AND (SELECT repo FROM projects WHERE id = ?3 AND user_id = ?2) IS NULL AND repo IS NOT NULL').bind(fromId, u, intoId),
    db
      .prepare('UPDATE projects SET repo = ?1 WHERE id = ?2 AND user_id = ?3 AND repo IS NULL AND ?1 IS NOT NULL')
      .bind(fromProject.repo, intoId, u),
    db.prepare('DELETE FROM projects WHERE id = ? AND user_id = ?').bind(fromId, u),
  ]);
  return getProject(s, intoId);
}

// ───────────────────────────── Задачі ─────────────────────────────

/** ?1 = now, ?2 = user_id. */
const TASK_WITH_TIME = `
  SELECT t.id, t.project_id, t.title, t.notes, t.status, t.external_ref, t.created_at, t.done_at, p.name AS project_name,
    COALESCE((SELECT SUM(COALESCE(e.stopped_at, ?1) - e.started_at) FROM time_entries e WHERE e.task_id = t.id AND e.user_id = ?2), 0) AS spent_ms,
    (SELECT COUNT(*) FROM time_entries e WHERE e.task_id = t.id AND e.user_id = ?2 AND e.stopped_at IS NULL) AS active_sessions
  FROM tasks t JOIN projects p ON p.id = t.project_id AND p.user_id = ?2
  WHERE t.user_id = ?2`;

export async function getTask(s: Scope, id: string, now = Date.now()): Promise<TaskWithTime> {
  const t = await s.db.prepare(`${TASK_WITH_TIME} AND t.id = ?3`).bind(now, s.uid, id).first<TaskWithTime>();
  if (!t) throw new TimerError(`Задачу ${id} не знайдено`, 404);
  return t;
}

/** Задачі проєкту (або всіх проєктів). open = todo + doing. */
export async function listTasks(
  s: Scope,
  q: { projectId?: string; status?: 'open' | 'done' | 'all' },
  now: number,
): Promise<TaskWithTime[]> {
  const where: string[] = [];
  const args: unknown[] = [now, s.uid];
  if (q.projectId) {
    where.push(`t.project_id = ?${args.length + 1}`);
    args.push(q.projectId);
  }
  const status = q.status ?? 'open';
  if (status === 'open') where.push("t.status != 'done'");
  if (status === 'done') where.push("t.status = 'done'");
  const sql = `${TASK_WITH_TIME}${where.map((w) => ` AND ${w}`).join('')}
    ORDER BY CASE t.status WHEN 'doing' THEN 0 WHEN 'todo' THEN 1 ELSE 2 END, COALESCE(t.done_at, t.created_at) DESC`;
  return (await s.db.prepare(sql).bind(...args).all<TaskWithTime>()).results;
}

/**
 * Задача за посиланням у межах проєкту: id, номер у трекері (LIN-42) або назва без урахування регістру.
 * Кілька збігів за назвою — помилка зі списком, щоб агент уточнив.
 */
export async function findTaskByRef(s: Scope, ref: string, projectId: string | null, now: number): Promise<TaskWithTime | null> {
  const r = ref.trim();
  const byId = await s.db.prepare(`${TASK_WITH_TIME} AND t.id = ?3`).bind(now, s.uid, r).first<TaskWithTime>();
  if (byId) return byId;
  const pool = await listTasks(s, { projectId: projectId ?? undefined, status: 'all' }, now);
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
  s: Scope,
  input: { project_id: string; title: string; notes?: string | null; external_ref?: string | null },
  now: number,
): Promise<TaskWithTime> {
  const project = await getProject(s, input.project_id);
  if (project.archived_at !== null) throw new TimerError(`Проєкт «${project.name}» в архіві`);
  const title = summarize(input.title, 200);
  if (!title) throw new TimerError('Потрібна назва задачі');
  const n = await s.db
    .prepare('SELECT (SELECT COUNT(*) FROM tasks WHERE user_id = ?1 AND project_id = ?2) AS inProject, (SELECT COUNT(*) FROM tasks WHERE user_id = ?1) AS total')
    .bind(s.uid, project.id)
    .first<{ inProject: number; total: number }>();
  if ((n?.inProject ?? 0) >= LIMITS.tasksPerProject) throw new TimerError(`У проєкті вже ${LIMITS.tasksPerProject} задач`, 429);
  if ((n?.total ?? 0) >= LIMITS.tasksPerUser) throw new TimerError(`Досягнуто ліміту в ${LIMITS.tasksPerUser} задач — видаліть старі`, 429);
  const id = uid();
  await s.db
    .prepare('INSERT INTO tasks (id, user_id, project_id, title, notes, status, external_ref, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, s.uid, project.id, title, summarize(input.notes, 1000), 'todo', summarize(input.external_ref, 60), now)
    .run();
  return getTask(s, id, now);
}

/** Запущені записи агентів над задачею — щоб продовжити їх без задачі. */
async function runningForTask(s: Scope, taskId: string) {
  return (
    await s.db
      .prepare(
        "SELECT project_id, session_id, note FROM time_entries WHERE user_id = ? AND task_id = ? AND stopped_at IS NULL AND source = 'claude_code' AND session_id NOT LIKE ?",
      )
      .bind(s.uid, taskId, `${s.uid}:mcp:%`)
      .all<{ project_id: string; session_id: string; note: string | null }>()
  ).results;
}

// ───────────── Таймер задачі через MCP (клієнти без хуків) ─────────────
//
// claude.ai, Claude Desktop і хмарні сесії не мають хуків Claude Code, тож час їхніх задач
// рахується від timer_task_start до timer_task_done окремим записом із сесією `<uid>:mcp:<task_id>`.
// Якщо хук потім прив'яже до задачі справжню сесію агента (Claude Code CLI), цей запис прибираємо,
// щоб час не рахувався двічі.

export const mcpSessionId = (uid: string, taskId: string) => `${uid}:mcp:${taskId}`;
export const isMcpSession = (sessionId: string) => /^[^:]+:mcp:/.test(sessionId);
/** Таймер задачі через MCP без жодного виклику довше за це — вважаємо забутим і закриваємо на останній активності. */
export const MCP_IDLE_MS = 4 * 3600_000;

/** Запустити таймер задачі, якщо час у неї ще не йде (ні від хука, ні від MCP). true — запущено. */
export async function startMcpTimer(s: Scope, task: { id: string; project_id: string }, now: number): Promise<boolean> {
  const running = await s.db
    .prepare("SELECT 1 FROM time_entries WHERE user_id = ? AND task_id = ? AND stopped_at IS NULL AND source = 'claude_code' LIMIT 1")
    .bind(s.uid, task.id)
    .first();
  if (running) return false;
  await assertEntryQuota(s, now);
  try {
    await insertEntry(s, task.project_id, task.id, mcpSessionId(s.uid, task.id), 'claude_code', now, null).run();
  } catch (e) {
    // Паралельний виклик уже запустив (one_running_per_session) — це не помилка.
    if (String(e).includes('UNIQUE')) return false;
    throw e;
  }
  return true;
}

/**
 * Виклик MCP про цей проєкт — ознака, що агент у ньому живий: продовжуємо таймери задач лише цього проєкту.
 * (Раніше продовжували всі — і забуті таймери одних проєктів жили за рахунок агентів інших.)
 */
export function touchMcpTimers(s: Scope, now: number, projectId: string): Promise<unknown> {
  return s.db
    .prepare('UPDATE time_entries SET last_seen_at = ? WHERE user_id = ? AND project_id = ? AND stopped_at IS NULL AND session_id LIKE ?')
    .bind(now, s.uid, projectId, `${s.uid}:mcp:%`)
    .run();
}

export async function updateTask(
  s: Scope,
  id: string,
  patch: { title?: string; notes?: string | null; external_ref?: string | null; status?: TaskStatus },
  now: number,
): Promise<TaskWithTime> {
  const { db, uid: u } = s;
  const t = await getTask(s, id, now);
  const title = patch.title === undefined ? t.title : summarize(patch.title, 200);
  if (!title) throw new TimerError('Назва задачі не може бути порожньою');
  const status = patch.status ?? t.status;
  if (!['todo', 'doing', 'done'].includes(status)) throw new TimerError('status: todo | doing | done');
  const doneAt = status === 'done' ? (t.done_at ?? now) : null;
  const stmts: D1PreparedStatement[] = [];
  if ((status === 'done' && t.status !== 'done') || (status === 'todo' && t.status === 'doing')) {
    // Закриваємо всі поточні інтервали задачі: хуки, таймер MCP і ручний таймер.
    // Сесії агентів із хуками працюють далі вже без задачі.
    // Порядок: спершу закрити (інакше впремося в one_running_per_session), потім відкрити продовження.
    const reopen = await runningForTask(s, id);
    stmts.push(
      db.prepare('UPDATE time_entries SET stopped_at = ?1, last_seen_at = ?1 WHERE user_id = ?2 AND task_id = ?3 AND stopped_at IS NULL').bind(now, u, id),
      ...reopen.map((r) => insertEntry(s, r.project_id, null, r.session_id, 'claude_code', now, r.note)),
      db.prepare('DELETE FROM session_tasks WHERE user_id = ? AND task_id = ?').bind(u, id),
    );
  }
  stmts.push(
    db
      .prepare('UPDATE tasks SET title = ?, notes = ?, external_ref = ?, status = ?, done_at = ? WHERE id = ? AND user_id = ?')
      .bind(
        title,
        patch.notes === undefined ? t.notes : summarize(patch.notes, 1000),
        patch.external_ref === undefined ? t.external_ref : summarize(patch.external_ref, 60),
        status,
        doneAt,
        id,
        u,
      ),
  );
  await db.batch(stmts);
  return getTask(s, id, now);
}

/**
 * Видалити задачу. Час не губиться: записи лишаються в проєкті без задачі.
 * Запущені записи агентів розриваються так само, як при «готово».
 */
export async function deleteTask(s: Scope, id: string, now: number): Promise<void> {
  const { db, uid: u } = s;
  await getTask(s, id, now);
  // Порядок важливий: спершу закрити запущений інтервал задачі, потім відкрити продовження без задачі
  // (інакше впремося в one_running_per_session), і лише тоді відв'язати старі записи.
  const reopen = await runningForTask(s, id);
  await db.batch([
    db.prepare('UPDATE time_entries SET stopped_at = ?1, last_seen_at = ?1 WHERE user_id = ?2 AND task_id = ?3 AND stopped_at IS NULL').bind(now, u, id),
    db.prepare('UPDATE time_entries SET task_id = NULL WHERE user_id = ? AND task_id = ?').bind(u, id),
    ...reopen.map((r) => insertEntry(s, r.project_id, null, r.session_id, 'claude_code', now, r.note)),
    db.prepare('DELETE FROM session_tasks WHERE user_id = ? AND task_id = ?').bind(u, id),
    db.prepare('DELETE FROM tasks WHERE id = ? AND user_id = ?').bind(id, u),
  ]);
}

/**
 * Почати роботу над задачею: статус doing, і час сесії агента відтепер іде в задачу.
 * Сесію знає лише хук (PostToolUse після timer_task_start несе session_id). MCP-виклик сам сесію
 * не вгадує: при кількох агентах у проєкті так легко віддати час чужій сесії.
 * sessionId — вже з префіксом користувача (sessionKey).
 */
export async function startTask(
  s: Scope,
  taskId: string,
  now: number,
  sessionId?: string,
): Promise<{ task: TaskWithTime; bound: boolean }> {
  const { db, uid: u } = s;
  const t = await getTask(s, taskId, now);
  if (t.status === 'done') throw new TimerError(`Задача «${t.title}» уже виконана — відкрийте її знову (status: todo)`);
  let bound = false;
  const stmts: D1PreparedStatement[] = [];
  if (t.status === 'todo') stmts.push(db.prepare("UPDATE tasks SET status = 'doing' WHERE id = ? AND user_id = ?").bind(t.id, u));
  if (sessionId && sessionId !== MANUAL && sessionId.startsWith(`${u}:`)) {
    bound = true;
    stmts.push(
      db
        .prepare(
          `INSERT INTO session_tasks (session_id, user_id, task_id, project_id, set_at) VALUES (?1, ?5, ?2, ?3, ?4)
           ON CONFLICT(session_id) DO UPDATE SET task_id = ?2, project_id = ?3, set_at = ?4 WHERE user_id = ?5`,
        )
        .bind(sessionId, t.id, t.project_id, now, u),
    );
    const running = await db
      .prepare('SELECT * FROM time_entries WHERE user_id = ? AND session_id = ? AND project_id = ? AND stopped_at IS NULL')
      .bind(u, sessionId, t.project_id)
      .first<Entry>();
    if (running && running.task_id === null) {
      // Хід агента щойно почався без задачі — віддаємо його задачі цілком.
      stmts.push(db.prepare('UPDATE time_entries SET task_id = ?, last_seen_at = ? WHERE id = ? AND user_id = ?').bind(t.id, now, running.id, u));
    } else if (running && running.task_id !== t.id) {
      // Агент переключився з іншої задачі посеред ходу — ріжемо інтервал.
      stmts.push(db.prepare('UPDATE time_entries SET stopped_at = ?, last_seen_at = ? WHERE id = ? AND user_id = ?').bind(now, now, running.id, u));
      stmts.push(insertEntry(s, t.project_id, t.id, sessionId, 'claude_code', now, running.note));
    }
  }
  if (bound) {
    // Час задачі тепер рахує хук: таймер MCP цієї задачі зайвий. Щойно запущений (той самий виклик
    // timer_task_start) — видаляємо; давніший — закриваємо, щоб не втратити вже пораховане.
    const mcp = mcpSessionId(u, t.id);
    stmts.push(
      db.prepare('DELETE FROM time_entries WHERE user_id = ? AND session_id = ? AND stopped_at IS NULL AND started_at >= ?').bind(u, mcp, now - 5 * 60_000),
      db.prepare('UPDATE time_entries SET stopped_at = ?1, last_seen_at = ?1 WHERE user_id = ?2 AND session_id = ?3 AND stopped_at IS NULL').bind(now, u, mcp),
    );
  }
  if (stmts.length) await db.batch(stmts);
  return { task: await getTask(s, t.id, now), bound };
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
async function boundTask(s: Scope, sessionId: string, projectId: string): Promise<string | null> {
  const row = await s.db
    .prepare(
      `SELECT st.task_id FROM session_tasks st JOIN tasks t ON t.id = st.task_id AND t.user_id = st.user_id
       WHERE st.user_id = ? AND st.session_id = ? AND st.project_id = ? AND t.status != 'done'`,
    )
    .bind(s.uid, sessionId, projectId)
    .first<{ task_id: string }>();
  return row?.task_id ?? null;
}

/** Сесія працює: upsert стану. */
function sessionWorking(s: Scope, sessionId: string, projectId: string, now: number, prompt: string | null): D1PreparedStatement {
  return s.db
    .prepare(
      `INSERT INTO agent_sessions (session_id, user_id, project_id, state, last_prompt, waiting_reason, waiting_since, started_at, updated_at)
       VALUES (?1, ?5, ?2, 'working', ?3, NULL, NULL, ?4, ?4)
       ON CONFLICT(session_id) DO UPDATE SET project_id = ?2, state = 'working', last_prompt = COALESCE(?3, last_prompt),
         waiting_reason = NULL, waiting_since = NULL, stopped_by_user_at = NULL, updated_at = ?4
       WHERE user_id = ?5`,
    )
    .bind(sessionId, projectId, prompt, now, s.uid);
}

function stopSessionEntries(s: Scope, sessionId: string, now: number): D1PreparedStatement {
  return s.db
    .prepare('UPDATE time_entries SET stopped_at = ?, last_seen_at = ? WHERE user_id = ? AND session_id = ? AND stopped_at IS NULL')
    .bind(now, now, s.uid, sessionId);
}

/**
 * Подія хука Claude Code. `input.session_id` — сирий id з Claude Code; у базі він зберігається
 * з префіксом користувача, тож сесії різних людей ніколи не перетинаються.
 */
export async function handleHook(
  s: Scope,
  input: HookInput,
  now: number,
  opts: { noteFromPrompt: boolean },
): Promise<'started' | 'heartbeat' | 'stopped' | 'waiting' | 'ended' | 'bound' | 'ignored'> {
  const { db, uid: u } = s;
  const event = input.hook_event_name ?? '';
  const raw = typeof input.session_id === 'string' ? input.session_id.slice(0, 200) : '';
  if (!raw || raw === MANUAL) return 'ignored';
  const sessionId = sessionKey(u, raw);

  if (inList(HOOK_EVENTS.end, event)) {
    await db.batch([
      stopSessionEntries(s, sessionId, now),
      // Сесія закрита — її прив'язка до задачі більше не потрібна.
      db.prepare('DELETE FROM session_tasks WHERE user_id = ? AND session_id = ?').bind(u, sessionId),
      db
        .prepare("UPDATE agent_sessions SET state = 'ended', waiting_since = NULL, waiting_reason = NULL, updated_at = ? WHERE user_id = ? AND session_id = ?")
        .bind(now, u, sessionId),
    ]);
    return 'ended';
  }

  if (inList(HOOK_EVENTS.stop, event)) {
    await db.batch([
      stopSessionEntries(s, sessionId, now),
      db
        .prepare(
          `UPDATE agent_sessions SET state = 'waiting', waiting_reason = ?, waiting_since = ?, updated_at = ?
           WHERE user_id = ? AND session_id = ? AND state != 'ended'`,
        )
        .bind(event === 'StopFailure' ? 'Хід обірвався з помилкою API' : null, now, now, u, sessionId),
    ]);
    return 'stopped';
  }

  if (inList(HOOK_EVENTS.wait, event)) {
    // Запит дозволу посеред ходу або нагадування після ходу: зупиняємо облік, позначаємо «чекає».
    // Наступний PostToolUse (дозвіл дали) відновить запис через самовідновлення нижче.
    await db.batch([
      stopSessionEntries(s, sessionId, now),
      db
        .prepare(
          // Причину беремо лише з сповіщення посеред ходу (запит дозволу); нагадування після ходу її не перетирає.
          `UPDATE agent_sessions SET waiting_reason = CASE WHEN state = 'working' THEN ? ELSE waiting_reason END,
             state = 'waiting', waiting_since = COALESCE(waiting_since, ?), updated_at = ?
           WHERE user_id = ? AND session_id = ? AND state != 'ended'`,
        )
        .bind(summarize(input.message, 200), now, now, u, sessionId),
    ]);
    return 'waiting';
  }

  const dir = input.project_dir || input.cwd;
  if (!dir) return 'ignored';

  if (inList(HOOK_EVENTS.start, event)) {
    const project = await resolveProject(s, dir, now);
    const note = opts.noteFromPrompt ? summarize(input.prompt) : null;
    const bound = await boundTask(s, sessionId, project.id);
    const running = (
      await db.prepare('SELECT * FROM time_entries WHERE user_id = ? AND session_id = ? AND stopped_at IS NULL').bind(u, sessionId).all<Entry>()
    ).results;
    const stmts: D1PreparedStatement[] = [];
    let alreadyRunning = false;
    for (const r of running) {
      if (r.project_id === project.id) {
        alreadyRunning = true;
        stmts.push(db.prepare('UPDATE time_entries SET last_seen_at = ? WHERE id = ? AND user_id = ?').bind(now, r.id, u));
      } else {
        // Сесія перейшла в інший проєкт (змінився cwd) — закриваємо старий запис.
        stmts.push(db.prepare('UPDATE time_entries SET stopped_at = ?, last_seen_at = ? WHERE id = ? AND user_id = ?').bind(now, now, r.id, u));
      }
    }
    if (!alreadyRunning) {
      // Ліміт вичерпано — хук мовчки нічого не пише (агенту помилка не потрібна).
      if (await entryQuotaExceeded(s, now)) return 'ignored';
      stmts.push(insertEntry(s, project.id, bound, sessionId, 'claude_code', now, note));
    }
    stmts.push(focusSwitch(s, project.id, now));
    stmts.push(sessionWorking(s, sessionId, project.id, now, note));
    await db.batch(stmts);
    return 'started';
  }

  if (inList(HOOK_EVENTS.heartbeat, event)) {
    const res = await db
      .prepare('UPDATE time_entries SET last_seen_at = ? WHERE user_id = ? AND session_id = ? AND stopped_at IS NULL')
      .bind(now, u, sessionId)
      .run();
    let result: 'started' | 'heartbeat' | 'bound' = 'heartbeat';
    let projectId: string | null = null;
    if (res.meta.changes === 0) {
      // Немає запущеного запису: дозвіл щойно дали, трекер встановили посеред ходу або cron закрив запис.
      // Продовжуємо облік — з тією самою задачею, до якої прив'язана сесія.
      // Виняток: сесію зупинили вручну з вебу — тоді чекаємо нового промпту.
      const session = await db
        .prepare('SELECT last_prompt, stopped_by_user_at FROM agent_sessions WHERE user_id = ? AND session_id = ?')
        .bind(u, sessionId)
        .first<{ last_prompt: string | null; stopped_by_user_at: number | null }>();
      if (session?.stopped_by_user_at || (await entryQuotaExceeded(s, now))) return 'ignored';
      const project = await resolveProject(s, dir, now);
      projectId = project.id;
      await insertEntry(s, project.id, await boundTask(s, sessionId, project.id), sessionId, 'claude_code', now, session?.last_prompt ?? null).run();
      result = 'started';
    }
    if (projectId) await sessionWorking(s, sessionId, projectId, now, null).run();
    else {
      await db
        .prepare(
          "UPDATE agent_sessions SET state = 'working', waiting_since = NULL, waiting_reason = NULL, updated_at = ? WHERE user_id = ? AND session_id = ? AND state != 'ended'",
        )
        .bind(now, u, sessionId)
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
          ? await findProjectByRef(s, projectRef)
          : await findProjectByPath(s, typeof ti.cwd === 'string' && ti.cwd ? ti.cwd : dir);
        if (ref && project) {
          const task = await findTaskByRef(s, ref, project.id, now).catch(() => null);
          if (task && task.status !== 'done') {
            await startTask(s, task.id, now, sessionId);
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
  s: Scope,
  projectId: string,
  taskId: string | null,
  sessionId: string,
  source: Entry['source'],
  start: number,
  note: string | null,
  stop: number | null = null,
): D1PreparedStatement {
  return s.db
    .prepare(
      'INSERT INTO time_entries (id, user_id, project_id, task_id, session_id, source, started_at, stopped_at, last_seen_at, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(uid(), s.uid, projectId, taskId, sessionId, source, start, stop, stop ?? start, note);
}

/**
 * Зупинити сесію агента вручну (з вебу): закрити її запущені записи й прибрати з «Працюють» / «Чекають».
 * Heartbeat-и цієї сесії більше не відновлюють облік; новий промпт (UserPromptSubmit) — відновлює.
 * Прив'язка до задачі лишається: якщо агент продовжить, час знову піде в ту саму задачу.
 * sessionId — внутрішній (з префіксом користувача), як його повертають listRunning / listWaiting.
 */
export async function stopSession(s: Scope, sessionId: string, now: number): Promise<{ stopped: number }> {
  if (!sessionId || sessionId === MANUAL) throw new TimerError('Ручні таймери зупиняються за проєктом: POST /api/projects/:id/stop');
  if (!sessionId.startsWith(`${s.uid}:`)) throw new TimerError(`Сесію ${sessionId} не знайдено`, 404);
  const [res, sess] = await s.db.batch([
    stopSessionEntries(s, sessionId, now),
    s.db
      .prepare(
        `UPDATE agent_sessions SET state = 'ended', waiting_reason = NULL, waiting_since = NULL, stopped_by_user_at = ?1, updated_at = ?1
         WHERE user_id = ?2 AND session_id = ?3`,
      )
      .bind(now, s.uid, sessionId),
  ]);
  const stopped = res.meta.changes ?? 0;
  if (stopped === 0 && (sess.meta.changes ?? 0) === 0) throw new TimerError(`Сесію ${sessionId} не знайдено`, 404);
  return { stopped };
}

/**
 * Cron: закрити записи агентів без heartbeat, прибрати порожні й підчистити стан сесій — для всіх користувачів.
 * Сесія, що «працює» без запущеного запису (агент упав, термінал закрили), вважається завершеною;
 * «чекає» довше доби — теж.
 */
export async function closeStale(db: D1Database, now: number, staleMs: number): Promise<number> {
  const [closed, closedMcp] = await db.batch([
    db
      .prepare(
        "UPDATE time_entries SET stopped_at = last_seen_at WHERE stopped_at IS NULL AND source = 'claude_code' AND session_id NOT LIKE '%:mcp:%' AND last_seen_at < ?",
      )
      .bind(now - staleMs),
    // Таймери задач через MCP не мають хуків-«пульсу»: живуть довше, закриваються на останньому виклику MCP.
    db
      .prepare("UPDATE time_entries SET stopped_at = last_seen_at WHERE stopped_at IS NULL AND session_id LIKE '%:mcp:%' AND last_seen_at < ?")
      .bind(now - MCP_IDLE_MS),
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
  return (closed.meta.changes ?? 0) + (closedMcp.meta.changes ?? 0);
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

export async function listWaiting(s: Scope): Promise<WaitingSession[]> {
  return (
    await s.db
      .prepare(
        `SELECT s.session_id, s.project_id, p.name AS project_name, p.color AS project_color, s.last_prompt, s.waiting_reason, s.waiting_since,
                t.title AS task_title, t.external_ref AS task_ref,
                le.id AS entry_id, le.started_at AS entry_started_at, le.stopped_at AS entry_stopped_at
         FROM agent_sessions s
         JOIN projects p ON p.id = s.project_id AND p.user_id = ?1
         LEFT JOIN time_entries le ON le.id = (
           SELECT id FROM time_entries WHERE user_id = ?1 AND session_id = s.session_id ORDER BY started_at DESC LIMIT 1)
         LEFT JOIN session_tasks st ON st.session_id = s.session_id AND st.project_id = s.project_id AND st.user_id = ?1
         LEFT JOIN tasks t ON t.id = st.task_id AND t.status != 'done' AND t.user_id = ?1
         WHERE s.user_id = ?1 AND s.state = 'waiting'
         ORDER BY s.waiting_since`,
      )
      .bind(s.uid)
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
  /** Потоки проєкту (сесії агентів, таймери задач, ручний таймер) — для розгорнутої смуги. */
  streams: TimelineStream[];
}

export interface TimelineStream {
  key: string;
  kind: 'agent' | 'mcp' | 'manual';
  /** Підпис рядка: задача, нотатка або вид потоку. */
  label: string;
  total_ms: number;
  segments: TimelineSegment[];
}

export interface TimelineSegment {
  entry_id: string;
  /** Запис цілком (без обрізання межами дня) — для правки. */
  entry_started_at: number;
  entry_stopped_at: number | null;
  start: number;
  /** null — іде зараз. */
  stop: number | null;
  task_title: string | null;
  task_ref: string | null;
  note: string | null;
}

export interface Timeline {
  from: number;
  to: number;
  now: number;
  wall_ms: number;
  /** Сума по проєктах: кожен проєкт — увесь свій час (кілька сесій одного проєкту — один раз). */
  sum_full_ms: number;
  /** Сума по потоках: кожна сесія агента, таймер задачі й ручний таймер — окремо. */
  sum_streams_ms: number;
  /** sum_streams / wall: скільки потоків роботи в середньому йшло одночасно. */
  parallelism: number;
  /** Найбільше потоків одночасно. */
  peak_streams: number;
  lanes: TimelineLane[];
}

/** Потік роботи запису: сесія агента (і таймер задачі MCP) — своя; ручні таймери — по одному на проєкт. */
function streamKey(e: { session_id: string; project_id: string }): string {
  return e.session_id === MANUAL ? `manual:${e.project_id}` : e.session_id;
}

/** Потоки одного проєкту за день: сегменти обрізані межами, підпис — задача або нотатка. */
function laneStreams(
  rows: { id: string; session_id: string; project_id: string; started_at: number; stopped_at: number | null; note: string | null; task_title: string | null; task_ref: string | null }[],
  from: number,
  end: number,
  now: number,
): TimelineStream[] {
  const by = new Map<string, TimelineStream>();
  for (const r of rows) {
    const st = Math.max(r.started_at, from);
    const x = Math.min(r.stopped_at ?? now, end);
    if (x <= st) continue;
    const key = streamKey(r);
    const kind: TimelineStream['kind'] = r.session_id === MANUAL ? 'manual' : isMcpSession(r.session_id) ? 'mcp' : 'agent';
    let stream = by.get(key);
    if (!stream) {
      stream = { key, kind, label: '', total_ms: 0, segments: [] };
      by.set(key, stream);
    }
    stream.total_ms += x - st;
    stream.segments.push({
      entry_id: r.id,
      entry_started_at: r.started_at,
      entry_stopped_at: r.stopped_at,
      start: st,
      stop: r.stopped_at === null && x >= end ? null : x,
      task_title: r.task_title,
      task_ref: r.task_ref,
      note: r.note,
    });
  }
  for (const st of by.values()) {
    // Підпис — остання задача потоку, інакше остання нотатка, інакше вид.
    const last = [...st.segments].reverse();
    const task = last.find((g) => g.task_title);
    const note = last.find((g) => g.note);
    st.label = task
      ? `${task.task_ref ? `${task.task_ref} ` : ''}${task.task_title}`
      : (note?.note ?? (st.kind === 'manual' ? 'Вручну' : st.kind === 'mcp' ? 'Задача через MCP' : `Сесія ${st.key.split(':').pop()?.slice(0, 6) ?? ''} · без задачі`));
  }
  return [...by.values()].sort((a, b) => a.segments[0].start - b.segments[0].start);
}

/** Шкала дня: коли працював кожен проєкт і скільки разом. */
export async function dayTimeline(s: Scope, from: number, to: number, now: number): Promise<Timeline> {
  const entries = (
    await s.db
      .prepare(
        `SELECT e.id, e.project_id, e.session_id, e.started_at, e.stopped_at, e.note, t.title AS task_title, t.external_ref AS task_ref
         FROM time_entries e LEFT JOIN tasks t ON t.id = e.task_id AND t.user_id = e.user_id
         WHERE e.user_id = ? AND e.started_at < ? AND (e.stopped_at IS NULL OR e.stopped_at > ?)
         ORDER BY e.started_at`,
      )
      .bind(s.uid, to, from)
      .all<{
        id: string;
        project_id: string;
        session_id: string;
        started_at: number;
        stopped_at: number | null;
        note: string | null;
        task_title: string | null;
        task_ref: string | null;
      }>()
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
    const st = Math.max(e.started_at, from);
    const live = e.stopped_at === null;
    const x = Math.min(e.stopped_at ?? now, end);
    if (x <= st) continue;
    byProject.set(e.project_id, [...(byProject.get(e.project_id) ?? []), { s: st, e: x, live }]);
  }
  const projects = new Map((await listProjects(s, true)).map((p) => [p.id, p]));
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
      streams: laneStreams(entries.filter((e) => e.project_id === pid), from, end, now),
    };
  });
  lanes.sort((a, b) => b.total_ms - a.total_ms);
  const sum = Object.values(full.perTask).reduce((a, b) => a + b, 0);
  const st = concurrency(
    entries.map((e) => ({ key: streamKey(e), start: e.started_at, stop: e.stopped_at })),
    from,
    end,
    now,
  );
  return {
    from,
    to,
    now,
    wall_ms: full.wall,
    sum_full_ms: sum,
    sum_streams_ms: st.sum,
    parallelism: st.wall ? st.sum / st.wall : 0,
    peak_streams: st.peak,
    lanes,
  };
}

// ───────────────────────────── Ручний таймер ─────────────────────────────

async function checkTaskInProject(s: Scope, taskId: string | null | undefined, projectId: string, now: number) {
  if (!taskId) return null;
  const t = await getTask(s, taskId, now);
  if (t.project_id !== projectId) throw new TimerError(`Задача «${t.title}» належить проєкту «${t.project_name}»`);
  return t;
}

export async function startManual(
  s: Scope,
  projectId: string,
  note: string | null,
  now: number,
  taskId?: string | null,
): Promise<Entry> {
  const { db, uid: u } = s;
  const project = await getProject(s, projectId);
  if (project.archived_at !== null) throw new TimerError(`Проєкт «${project.name}» в архіві`);
  const task = await checkTaskInProject(s, taskId, projectId, now);
  if (task?.status === 'done') throw new TimerError(`Задача «${task.title}» уже виконана`);
  const running = await db
    .prepare('SELECT id FROM time_entries WHERE user_id = ? AND project_id = ? AND session_id = ? AND stopped_at IS NULL')
    .bind(u, projectId, MANUAL)
    .first();
  if (running) throw new TimerError(`Таймер «${project.name}» уже йде`, 409);
  await assertEntryQuota(s, now);
  const stmts = [
    insertEntry(s, projectId, task?.id ?? null, MANUAL, 'manual', now, summarize(note, 500)),
    // Ручний старт теж переносить фокус (режим focus у звітах).
    focusSwitch(s, projectId, now),
  ];
  if (task?.status === 'todo') stmts.push(db.prepare("UPDATE tasks SET status = 'doing' WHERE id = ? AND user_id = ?").bind(task.id, u));
  try {
    await db.batch(stmts);
  } catch (e) {
    // Подвійний клік: друга вставка впирається в one_running_per_session.
    if (String(e).includes('UNIQUE')) throw new TimerError(`Таймер «${project.name}» уже йде`, 409);
    throw e;
  }
  return (await db
    .prepare('SELECT * FROM time_entries WHERE user_id = ? AND project_id = ? AND session_id = ? AND stopped_at IS NULL')
    .bind(u, projectId, MANUAL)
    .first<Entry>())!;
}

/** Зупинити ручні таймери (одного проєкту або всіх). Короткі записи відкидаються. */
export async function stopManual(s: Scope, now: number, projectId?: string): Promise<{ stopped: number; discarded: number }> {
  const { db, uid: u } = s;
  const running = (
    await db
      .prepare(`SELECT * FROM time_entries WHERE user_id = ? AND session_id = ? AND stopped_at IS NULL${projectId ? ' AND project_id = ?' : ''}`)
      .bind(...(projectId ? [u, MANUAL, projectId] : [u, MANUAL]))
      .all<Entry>()
  ).results;
  if (running.length === 0) return { stopped: 0, discarded: 0 };
  let discarded = 0;
  const stmts = running.map((r) => {
    if (now - r.started_at < MIN_MANUAL_MS) {
      discarded++;
      return db.prepare('DELETE FROM time_entries WHERE id = ? AND user_id = ?').bind(r.id, u);
    }
    return db.prepare('UPDATE time_entries SET stopped_at = ?, last_seen_at = ? WHERE id = ? AND user_id = ?').bind(now, now, r.id, u);
  });
  await db.batch(stmts);
  return { stopped: running.length - discarded, discarded };
}

/** Зупинити всі ручні таймери і запустити один — звична поведінка Toggl. */
export async function switchTo(s: Scope, projectId: string, note: string | null, now: number, taskId?: string | null): Promise<Entry> {
  const project = await getProject(s, projectId);
  // Перевіряємо до зупинки інших таймерів, щоб невдалий перемикач нічого не зламав.
  if (project.archived_at !== null) throw new TimerError(`Проєкт «${project.name}» в архіві`);
  const task = await checkTaskInProject(s, taskId, projectId, now);
  if (task?.status === 'done') throw new TimerError(`Задача «${task.title}» уже виконана`);
  await stopManual(s, now);
  return startManual(s, projectId, note, now, taskId);
}

// ───────────────────────────── Записи ─────────────────────────────

async function assertNoManualOverlap(s: Scope, projectId: string, start: number, stop: number, now: number, excludeId?: string) {
  const clash = await s.db
    .prepare(
      `SELECT id FROM time_entries
       WHERE user_id = ? AND project_id = ? AND session_id = ? AND id != ?
         AND started_at < ? AND COALESCE(stopped_at, ?) > ?
       LIMIT 1`,
    )
    .bind(s.uid, projectId, MANUAL, excludeId ?? '', stop, now, start)
    .first();
  if (clash) throw new TimerError('Ручні записи одного проєкту не можуть перекриватися', 409);
}

export async function createEntry(
  s: Scope,
  input: { project_id: string; task_id?: string | null; start: number; stop?: number; duration_ms?: number; note?: string | null },
  now: number,
): Promise<Entry> {
  await getProject(s, input.project_id);
  const task = await checkTaskInProject(s, input.task_id, input.project_id, now);
  const start = input.start;
  const stop = input.stop ?? (input.duration_ms !== undefined ? start + input.duration_ms : undefined);
  if (stop === undefined) throw new TimerError('Потрібен stop або duration_ms');
  if (!(start < stop)) throw new TimerError('Початок має бути раніше за кінець');
  if (stop - start < MIN_MANUAL_MS) throw new TimerError('Ручний запис має тривати щонайменше хвилину');
  if (stop > now) throw new TimerError('Кінець не може бути в майбутньому');
  await assertNoManualOverlap(s, input.project_id, start, stop, now);
  await assertEntryQuota(s, now);
  const id = uid();
  await s.db
    .prepare(
      'INSERT INTO time_entries (id, user_id, project_id, task_id, session_id, source, started_at, stopped_at, last_seen_at, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(id, s.uid, input.project_id, task?.id ?? null, MANUAL, 'manual', start, stop, stop, summarize(input.note, 500))
    .run();
  return getEntry(s, id);
}

const ENTRY_COLS = 'id, project_id, task_id, session_id, source, started_at, stopped_at, last_seen_at, note';

export async function getEntry(s: Scope, id: string): Promise<Entry> {
  const e = await s.db.prepare(`SELECT ${ENTRY_COLS} FROM time_entries WHERE id = ? AND user_id = ?`).bind(id, s.uid).first<Entry>();
  if (!e) throw new TimerError(`Запис ${id} не знайдено`, 404);
  return e;
}

/**
 * Правка як у Toggl: нова тривалість рухає кінець, початок лишається.
 * У запущеного запису можна змінити початок, нотатку, проєкт, задачу або зупинити його (stop).
 * task_id: null — відв'язати від задачі; undefined — не чіпати.
 */
export async function updateEntry(
  s: Scope,
  id: string,
  patch: { start?: number; stop?: number; duration_ms?: number; note?: string | null; project_id?: string; task_id?: string | null },
  now: number,
): Promise<Entry> {
  const e = await getEntry(s, id);
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
  if (patch.project_id) await getProject(s, patch.project_id);
  let taskId = patch.task_id === undefined ? e.task_id : patch.task_id;
  // Запис переїхав в інший проєкт — стара задача йому вже не пасує.
  if (patch.project_id && patch.project_id !== e.project_id && patch.task_id === undefined) taskId = null;
  await checkTaskInProject(s, taskId, projectId, now);
  if (e.session_id === MANUAL) {
    if (stop !== null && stop - start < MIN_MANUAL_MS) throw new TimerError('Ручний запис має тривати щонайменше хвилину');
    await assertNoManualOverlap(s, projectId, start, stop ?? now, now, id);
  }
  const note = patch.note === undefined ? e.note : summarize(patch.note, 500);
  try {
    await s.db
      .prepare('UPDATE time_entries SET started_at = ?, stopped_at = ?, last_seen_at = ?, note = ?, project_id = ?, task_id = ? WHERE id = ? AND user_id = ?')
      .bind(start, stop, Math.max(e.last_seen_at, stop ?? start), note, projectId, taskId, id, s.uid)
      .run();
  } catch (err) {
    if (String(err).includes('UNIQUE')) throw new TimerError('У цьому проєкті вже йде такий таймер', 409);
    throw err;
  }
  return getEntry(s, id);
}

export async function deleteEntry(s: Scope, id: string): Promise<void> {
  await getEntry(s, id);
  await s.db.prepare('DELETE FROM time_entries WHERE id = ? AND user_id = ?').bind(id, s.uid).run();
}

/** ?1 = user_id. */
const ENTRY_WITH_PROJECT = `SELECT e.id, e.project_id, e.task_id, e.session_id, e.source, e.started_at, e.stopped_at, e.last_seen_at, e.note,
    p.name AS project_name, p.color AS project_color, t.title AS task_title, t.external_ref AS task_ref
  FROM time_entries e JOIN projects p ON p.id = e.project_id AND p.user_id = ?1
  LEFT JOIN tasks t ON t.id = e.task_id AND t.user_id = ?1
  WHERE e.user_id = ?1`;

export const ENTRIES_LIMIT = 1000;

/** Записи, що перетинають [from, to), найновіші першими. truncated = є ще старіші за ліміт. */
export async function listEntries(
  s: Scope,
  from: number,
  to: number,
  filter: { projectId?: string; taskId?: string } = {},
  limit = ENTRIES_LIMIT,
): Promise<{ entries: EntryWithProject[]; truncated: boolean }> {
  const cond: string[] = [];
  const args: unknown[] = [s.uid, to, from];
  if (filter.projectId) {
    args.push(filter.projectId);
    cond.push(`e.project_id = ?${args.length}`);
  }
  if (filter.taskId) {
    args.push(filter.taskId);
    cond.push(`e.task_id = ?${args.length}`);
  }
  args.push(limit + 1);
  const rows = (
    await s.db
      .prepare(
        `${ENTRY_WITH_PROJECT} AND e.started_at < ?2 AND (e.stopped_at IS NULL OR e.stopped_at > ?3)${cond.map((c) => ` AND ${c}`).join('')}
         ORDER BY e.started_at DESC LIMIT ?${args.length}`,
      )
      .bind(...args)
      .all<EntryWithProject>()
  ).results;
  return { entries: rows.slice(0, limit), truncated: rows.length > limit };
}

export async function listRunning(s: Scope): Promise<EntryWithProject[]> {
  return (await s.db.prepare(`${ENTRY_WITH_PROJECT} AND e.stopped_at IS NULL ORDER BY e.started_at`).bind(s.uid).all<EntryWithProject>()).results;
}

/** Підписати запущений запис агента в проєкті (MCP timer_label). */
export async function labelRunning(s: Scope, cwd: string, note: string, now: number): Promise<number> {
  const project = await findProjectByPath(s, cwd);
  if (!project) {
    throw new TimerError(`Для ${cwd} немає проєкту — агент тут ще не стартував або шлях не прив'язаний (timer_projects add_path)`, 404);
  }
  const res = await s.db
    .prepare(
      `UPDATE time_entries SET note = ?1, last_seen_at = ?2
       WHERE user_id = ?3 AND id = (SELECT id FROM time_entries WHERE user_id = ?3 AND project_id = ?4 AND source = 'claude_code' AND stopped_at IS NULL
                   ORDER BY last_seen_at DESC LIMIT 1)`,
    )
    .bind(summarize(note, 500), now, s.uid, project.id)
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
  /** Сума по потоках: кожна сесія агента, таймер задачі й ручний таймер — окремо. */
  sum_streams_ms: number;
  /** sum_streams / wall: скільки потоків роботи (сесій, задач) у середньому йшло одночасно. */
  parallelism: number;
  /** Найбільше потоків одночасно. */
  peak_streams: number;
  /** Середнє за день = реальний час / дні з записами (як у Toggl). */
  avg_daily_ms: number;
  days_with_entries: number;
  running_included: boolean;
  projects: ReportRow[];
  /** Задачі з часом за період, за спаданням (до 50). */
  tasks: ReportTaskRow[];
  days: { date: string; wall_ms: number; sum_full_ms: number; sum_streams_ms: number; projects: Record<string, number> }[];
}

/** Найдовший звіт: рік — щоб один запит не перебирав усю історію. */
const MAX_REPORT_MS = 400 * 24 * 3600_000;

export async function report(
  s: Scope,
  q: { from: number; to: number; mode: Mode; tz: string; projectId?: string },
  now: number,
): Promise<Report> {
  if (!(q.from < q.to)) throw new TimerError('from має бути раніше за to');
  if (q.to - q.from > MAX_REPORT_MS) throw new TimerError('Звіт — щонайбільше за рік');
  const to = Math.min(q.to, Math.max(now, q.from + 1));
  const entries = (
    await s.db
      .prepare(
        `SELECT project_id, task_id, session_id, started_at, stopped_at FROM time_entries
         WHERE user_id = ? AND started_at < ? AND (stopped_at IS NULL OR stopped_at > ?)${q.projectId ? ' AND project_id = ?' : ''}`,
      )
      .bind(...(q.projectId ? [s.uid, to, q.from, q.projectId] : [s.uid, to, q.from]))
      .all<{ project_id: string; task_id: string | null; session_id: string; started_at: number; stopped_at: number | null }>()
  ).results;
  const intervals = entries.map((e) => ({ taskId: e.project_id, start: e.started_at, stop: e.stopped_at }));
  const streams = entries.map((e) => ({ key: streamKey(e), start: e.started_at, stop: e.stopped_at }));

  const focus =
    q.mode === 'focus'
      ? (
          await s.db
            .prepare(
              `SELECT at, project_id FROM focus_switches
               WHERE user_id = ?1 AND at < ?2 AND at >= COALESCE((SELECT MAX(at) FROM focus_switches WHERE user_id = ?1 AND at <= ?3), 0)
               ORDER BY at`,
            )
            .bind(s.uid, to, q.from)
            .all<{ at: number; project_id: string | null }>()
        ).results.map((f) => ({ at: f.at, taskId: f.project_id }))
      : [];

  const main = allocate(intervals, q.from, to, now, q.mode, focus);
  const full = q.mode === 'full' ? main : allocate(intervals, q.from, to, now, 'full');
  const sumFull = Object.values(full.perTask).reduce((a, b) => a + b, 0);
  const st = concurrency(streams, q.from, to, now);

  const projects = new Map((await listProjects(s, true)).map((p) => [p.id, p]));
  const rows: ReportRow[] = Object.entries(main.perTask)
    .map(([project_id, ms]) => ({ project_id, ms, name: projects.get(project_id)?.name ?? '?', color: projects.get(project_id)?.color ?? null }))
    .sort((a, b) => b.ms - a.ms);

  // Задачі: повний режим (час агентів над задачею); дві сесії над однією задачею рахуються один раз.
  const taskIntervals = entries.filter((e) => e.task_id).map((e) => ({ taskId: e.task_id!, start: e.started_at, stop: e.stopped_at }));
  const taskTimes = allocate(taskIntervals, q.from, to, now, 'full').perTask;
  const taskIds = Object.keys(taskTimes);
  const taskInfo = new Map<string, TaskWithTime>();
  for (const t of await listTasks(s, { status: 'all' }, now)) if (taskTimes[t.id] !== undefined) taskInfo.set(t.id, t);
  const tasks: ReportTaskRow[] = taskIds
    .filter((id) => taskInfo.has(id))
    .map((id) => {
      const t = taskInfo.get(id)!;
      return { task_id: id, title: t.title, project_id: t.project_id, project_name: t.project_name, status: t.status, ms: taskTimes[id] };
    })
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 50);

  const days = dayRanges(q.from, q.to, q.tz).map((d) => {
    if (d.start >= to) return { date: d.date, wall_ms: 0, sum_full_ms: 0, sum_streams_ms: 0, projects: {} };
    const st = Math.max(d.start, q.from);
    const e = Math.min(d.end, to);
    const a = allocate(intervals, st, e, now, q.mode, focus);
    const f = q.mode === 'full' ? a : allocate(intervals, st, e, now, 'full');
    return {
      date: d.date,
      wall_ms: a.wall,
      sum_full_ms: Object.values(f.perTask).reduce((x, y) => x + y, 0),
      sum_streams_ms: concurrency(streams, st, e, now).sum,
      projects: a.perTask,
    };
  });
  const daysWith = days.filter((d) => d.wall_ms > 0).length;

  return {
    from: q.from,
    to: q.to,
    mode: q.mode,
    timezone: q.tz,
    wall_ms: main.wall,
    sum_full_ms: sumFull,
    sum_streams_ms: st.sum,
    parallelism: st.wall > 0 ? st.sum / st.wall : 0,
    peak_streams: st.peak,
    avg_daily_ms: daysWith > 0 ? main.wall / daysWith : 0,
    days_with_entries: daysWith,
    running_included: entries.some((e) => e.stopped_at === null),
    projects: rows,
    tasks,
    days,
  };
}
