-- Сесію агента зупинили вручну з вебу: доки не прийде новий промпт, heartbeat-и її не відновлюють.
ALTER TABLE agent_sessions ADD COLUMN stopped_by_user_at INTEGER;
