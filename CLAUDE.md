# Timer — нотатки для агента

Трекер часу AI-агентів для кількох користувачів: хуки Claude Code → Worker (Hono) → D1; MCP-сервер на `/mcp` (OAuth через `@cloudflare/workers-oauth-provider` або API-ключ); вхід у веб через GitHub; статичний UI в `public/`.

- Словник: проєкт (`projects`) — папка, куди хуки пишуть час; задача (`tasks`) — конкретна робота в проєкті; запис (`time_entries`) належить проєкту і, за бажанням, задачі. Сесію агента до задачі прив'язує лише хук (`session_tasks`), не MCP.
- **Ізоляція користувачів:** кожна функція `service.ts` отримує `Scope { db, uid }`, і КОЖЕН SQL-запит до даних має `user_id = uid`. Сесії агентів у базі — `<uid>:<session_id>`. Новий запит без `user_id` = витік чужих даних. Після змін — `python3 scripts/isolation.py`.
- Бізнес-логіка лише в `src/service.ts`; REST (`src/index.ts`) і MCP (`src/mcp.ts`) — тонкі обгортки над нею.
- Таймер задачі через MCP (клієнти без хуків) — запис із сесією `<uid>:mcp:<task_id>`, source `claude_code`; хук, що прив'язав справжню сесію, прибирає його (`startTask`). Не рахуйте його двічі.
- Проєкт для MCP: `project` → `repo` (`projects.repo`, host/owner/name) → `cwd`. Тимчасові папки (`isEphemeralPath`: /home/claude, /tmp…) не створюють проєктів і не прив'язуються як шляхи.
- Час — мілісекунди UTC; `now` передається у функції параметром.
- Розподіл паралельного часу — `src/allocate.ts`; змінюєте його — оновіть `test/allocate.test.ts`.
- Нова колонка/таблиця = нова міграція в `migrations/NNNN_*.sql`, старі не редагувати.
- `/hooks/claude` завжди відповідає 204 з порожнім тілом: текст у відповіді на `UserPromptSubmit` потрапив би в контекст агента.
- Після змін у `wrangler.jsonc` — `npm run types`.
- Перевірка: `npm test`, `npx tsc --noEmit`, `wrangler dev --local-upstream 127.0.0.1:8787` + `python3 scripts/isolation.py` + `python3 scripts/mcp-timer.py` + `TIMER_KEY=… npm run smoke`.
- Тексти для користувача — українською.
