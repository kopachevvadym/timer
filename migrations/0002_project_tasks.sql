-- Проєкти й справжні задачі всередині них.
-- Досі таблиця tasks зберігала проєкти — перейменовуємо, щоб «задача» означала задачу.

ALTER TABLE tasks RENAME TO projects;
ALTER TABLE task_paths RENAME TO project_paths;
ALTER TABLE project_paths RENAME COLUMN task_id TO project_id;
ALTER TABLE time_entries RENAME COLUMN task_id TO project_id;
ALTER TABLE focus_switches RENAME COLUMN task_id TO project_id;

-- Конкретні задачі проєкту: «LIN-42: експорт CSV», «Третій рівень і бос».
CREATE TABLE tasks (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id),
  title        TEXT NOT NULL,
  notes        TEXT,
  status       TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'doing', 'done')),
  -- Номер у трекері: LIN-42, #128 тощо.
  external_ref TEXT,
  created_at   INTEGER NOT NULL,
  done_at      INTEGER
);

CREATE INDEX tasks_project ON tasks (project_id, status);

-- Запис часу може належати задачі (NULL = просто робота в проєкті).
ALTER TABLE time_entries ADD COLUMN task_id TEXT REFERENCES tasks(id);
CREATE INDEX entries_task ON time_entries (task_id);

-- Над якою задачею зараз працює сесія агента. Нові записи сесії в тому ж проєкті
-- отримують цю задачу, доки агент не закриє її або не почне іншу.
CREATE TABLE session_tasks (
  session_id TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL REFERENCES tasks(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  set_at     INTEGER NOT NULL
);
