-- Кілька користувачів: кожен бачить і змінює лише своє.
-- Наявні дані переходять до користувача 'owner'; перший вхід через GitHub з числовим id OWNER_GITHUB_ID
-- забирає цей рядок собі (див. src/users.ts).

CREATE TABLE users (
  id               TEXT PRIMARY KEY,
  github_id        INTEGER UNIQUE,
  login            TEXT,
  name             TEXT,
  avatar_url       TEXT,
  timezone         TEXT NOT NULL DEFAULT 'Europe/Kyiv',
  -- Зберігати початок промпту як нотатку запису (приватні дані — за замовчуванням вимкнено).
  note_from_prompt INTEGER NOT NULL DEFAULT 0,
  -- Збільшується при виході: усі видані cookie сесії стають недійсними.
  session_epoch    INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  last_login_at    INTEGER
);

-- Власник наявних даних: нотатки з промптів у нього вже були ввімкнені.
INSERT INTO users (id, timezone, note_from_prompt, created_at) VALUES ('owner', 'Europe/Kyiv', 1, CAST(strftime('%s','now') AS INTEGER) * 1000);

-- Ключі для хуків і MCP з Claude Code. Зберігаємо лише SHA-256; prefix — щоб упізнати ключ у списку.
CREATE TABLE api_keys (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  prefix       TEXT NOT NULL,
  hash         TEXT NOT NULL UNIQUE,
  -- hooks — лише /hooks/claude (ключ лежить у env агента); full — ще /api і /mcp.
  scope        TEXT NOT NULL DEFAULT 'full' CHECK (scope IN ('full', 'hooks')),
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at   INTEGER
);
CREATE INDEX api_keys_user ON api_keys (user_id);

-- user_id без DEFAULT і без REFERENCES: SQLite не додає REFERENCES-колонку з default до непорожньої таблиці,
-- а забутий у новому INSERT user_id дасть NULL — такий рядок не побачить ніхто (а не «власник»).
ALTER TABLE projects ADD COLUMN user_id TEXT;
ALTER TABLE tasks ADD COLUMN user_id TEXT;
ALTER TABLE time_entries ADD COLUMN user_id TEXT;
ALTER TABLE focus_switches ADD COLUMN user_id TEXT;
ALTER TABLE agent_sessions ADD COLUMN user_id TEXT;
ALTER TABLE session_tasks ADD COLUMN user_id TEXT;
UPDATE projects SET user_id = 'owner';
UPDATE tasks SET user_id = 'owner';
UPDATE time_entries SET user_id = 'owner';
UPDATE focus_switches SET user_id = 'owner';
UPDATE agent_sessions SET user_id = 'owner';
UPDATE session_tasks SET user_id = 'owner';

CREATE INDEX projects_user ON projects (user_id);
CREATE INDEX tasks_user ON tasks (user_id, status);
CREATE INDEX entries_user_started ON time_entries (user_id, started_at);
CREATE INDEX focus_user_at ON focus_switches (user_id, at);
CREATE INDEX agent_sessions_user ON agent_sessions (user_id, state);

-- Сесії агентів тепер мають префікс користувача ('<user>:<session>'), щоб чужий хук
-- не міг зачепити вашу сесію, навіть знаючи її id.
UPDATE time_entries SET session_id = 'owner:' || session_id WHERE session_id != 'manual';
UPDATE agent_sessions SET session_id = 'owner:' || session_id;
UPDATE session_tasks SET session_id = 'owner:' || session_id;

-- Шляхи: однаковий шлях у різних людей — різні проєкти. Ключ (user_id, path).
CREATE TABLE project_paths_new (
  user_id    TEXT NOT NULL REFERENCES users(id),
  path       TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, path)
);
INSERT INTO project_paths_new (user_id, path, project_id) SELECT 'owner', path, project_id FROM project_paths;
DROP TABLE project_paths;
ALTER TABLE project_paths_new RENAME TO project_paths;
