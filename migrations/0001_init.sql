-- Час зберігається як мілісекунди UTC (integer).

CREATE TABLE tasks (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  color       TEXT,
  created_at  INTEGER NOT NULL,
  archived_at INTEGER
);

-- Шляхи проєкту на диску (корінь, worktree тощо). Хук визначає задачу
-- за найдовшим шляхом, що є префіксом cwd. Один шлях — одна задача.
CREATE TABLE task_paths (
  path    TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE TABLE time_entries (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL REFERENCES tasks(id),
  -- session_id з Claude Code; для ручного таймера — 'manual'.
  session_id   TEXT NOT NULL DEFAULT 'manual',
  source       TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'claude_code')),
  started_at   INTEGER NOT NULL,
  stopped_at   INTEGER,          -- NULL = запис іде
  last_seen_at INTEGER NOT NULL, -- останній heartbeat
  note         TEXT,
  CHECK (stopped_at IS NULL OR stopped_at >= started_at)
);

-- Паралельність: різні задачі й різні сесії можуть іти одночасно,
-- але одна сесія в одній задачі — лише один запущений запис.
CREATE UNIQUE INDEX one_running_per_session
  ON time_entries (task_id, session_id) WHERE stopped_at IS NULL;

CREATE INDEX entries_started ON time_entries (started_at);
CREATE INDEX entries_running ON time_entries (session_id) WHERE stopped_at IS NULL;

-- Куди ви востаннє надіслали промпт = ваш фокус (для режиму focus у звітах).
CREATE TABLE focus_switches (
  at      INTEGER NOT NULL,
  task_id TEXT REFERENCES tasks(id)
);

CREATE INDEX focus_at ON focus_switches (at);
