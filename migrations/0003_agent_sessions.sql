-- Стан сесій агентів для екрана «Зараз»: хто працює, а хто чекає на вас.
-- working — агент виконує хід; waiting — закінчив хід або просить дозволу; ended — сесію закрито.
CREATE TABLE agent_sessions (
  session_id     TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id),
  state          TEXT NOT NULL CHECK (state IN ('working', 'waiting', 'ended')),
  -- Початок останнього промпту (якщо NOTE_FROM_PROMPT не вимкнено).
  last_prompt    TEXT,
  -- Чому чекає: NULL = закінчив хід; інакше текст сповіщення Claude Code (напр. запит дозволу).
  waiting_reason TEXT,
  waiting_since  INTEGER,
  started_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE INDEX agent_sessions_state ON agent_sessions (state, updated_at);
