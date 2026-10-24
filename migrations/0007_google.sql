-- Вхід через Google: акаунт Google (sub — незмінний id) можна прив'язати до наявного користувача
-- або створити нового. Пошта лише для показу; входимо завжди за sub.
ALTER TABLE users ADD COLUMN google_sub TEXT;
ALTER TABLE users ADD COLUMN google_email TEXT;
CREATE UNIQUE INDEX users_google_sub ON users(google_sub) WHERE google_sub IS NOT NULL;
