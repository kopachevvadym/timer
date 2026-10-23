-- Репозиторій проєкту (host/owner/name з git remote). Хмарні сесії клонують репо в тимчасові папки
-- з довільними назвами (/home/claude/alee-1718), тож проєкт шукаємо за репозиторієм, а не за папкою.
ALTER TABLE projects ADD COLUMN repo TEXT;
CREATE UNIQUE INDEX projects_user_repo ON projects(user_id, repo) WHERE repo IS NOT NULL;
