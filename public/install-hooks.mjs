#!/usr/bin/env node
// Підключає Claude Code до трекера timer однією командою:
//  - HTTP-хуки в ~/.claude/settings.json (для всіх проєктів) і ключ TIMER_API_KEY у env того ж файлу;
//  - MCP-сервер `timer` (scope user) без ключа — вхід через GitHub при першому /mcp → Authenticate.
// Повторний запуск не дублює ні хуки, ні MCP.
//
//   curl -fsSL https://timer.kopachev.life/install-hooks.mjs | node --input-type=module - https://timer.kopachev.life tk_...
//   (або ключ у змінній TIMER_KEY замість аргументу — щоб не лишався в історії shell)
//   node install-hooks.mjs --remove
// Сюди йде ключ «лише для хуків»: він лежить у env агента, тож не відкриває ні API, ні MCP.
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const [arg, argKey] = process.argv.slice(2);
const key = argKey || process.env.TIMER_KEY;
if (!arg) {
  console.error('Використання: node install-hooks.mjs https://timer.<домен> tk_<ключ> | --remove');
  process.exit(1);
}
const remove = arg === '--remove';
const base = remove ? null : arg.replace(/\/+$/, '');
if (base && !/^https:\/\//.test(base) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(base)) {
  console.error('Очікувався https-URL на кшталт https://timer.kopachev.life (ключ не можна слати без шифрування)');
  process.exit(1);
}
if (!remove && key && !key.startsWith('tk_')) {
  console.error('Ключ має починатися з tk_ (створіть його в «Налаштуваннях» на сайті)');
  process.exit(1);
}

const EVENTS = ['UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure', 'Notification', 'Stop', 'StopFailure', 'SessionEnd'];
const isOurs = (h) => typeof h?.url === 'string' && h.url.endsWith('/hooks/claude');

const dir = join(homedir(), '.claude');
const file = join(dir, 'settings.json');
mkdirSync(dir, { recursive: true });
const existed = existsSync(file);
const settings = existed ? JSON.parse(readFileSync(file, 'utf8')) : {};
if (existed) copyFileSync(file, `${file}.bak-timer`);

settings.hooks ??= {};
for (const event of EVENTS) {
  const groups = (settings.hooks[event] ?? [])
    .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isOurs(h)) }))
    .filter((g) => g.hooks.length > 0);
  if (!remove) {
    groups.push({
      hooks: [
        {
          type: 'http',
          url: `${base}/hooks/claude`,
          timeout: 5,
          headers: {
            Authorization: 'Bearer $TIMER_API_KEY',
            'X-Project-Dir': '$CLAUDE_PROJECT_DIR',
          },
          allowedEnvVars: ['TIMER_API_KEY', 'CLAUDE_PROJECT_DIR'],
        },
      ],
    });
  }
  if (groups.length > 0) settings.hooks[event] = groups;
  else delete settings.hooks[event];
}
if (Object.keys(settings.hooks).length === 0) delete settings.hooks;

settings.env ??= {};
if (remove) delete settings.env.TIMER_API_KEY;
else if (key) settings.env.TIMER_API_KEY = key;
if (Object.keys(settings.env).length === 0) delete settings.env;

writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
try {
  chmodSync(file, 0o600); // у файлі тепер ключ
} catch {}
console.log(remove ? `Хуки трекера прибрано з ${file}` : `Хуки трекера → ${base}/hooks/claude записано в ${file}`);
if (!remove && !key && !settings.env?.TIMER_API_KEY) console.log('Увага: ключа TIMER_API_KEY немає — передайте його другим аргументом.');
if (existed) console.log(`Резервна копія: ${file}.bak-timer`);

// MCP: OAuth через GitHub, тож ключ у конфіг не пишемо. Якщо `timer` уже є (напр. з ключем) — не чіпаємо.
const claude = (...args) => spawnSync('claude', args, { encoding: 'utf8', shell: process.platform === 'win32' });
if (!remove) {
  const has = claude('mcp', 'get', 'timer');
  if (has.error) {
    console.log(`MCP: команду claude не знайдено. Додайте вручну: claude mcp add --transport http timer --scope user ${base}/mcp`);
  } else if (has.status === 0) {
    console.log('MCP: сервер timer уже підключено — лишаю як є.');
  } else {
    const add = claude('mcp', 'add', '--transport', 'http', 'timer', '--scope', 'user', `${base}/mcp`);
    console.log(add.status === 0 ? `MCP: timer → ${base}/mcp додано.` : `MCP не додано: ${(add.stderr || add.stdout || '').trim()}`);
  }
  console.log('Далі: перезапустіть Claude Code, введіть /mcp → timer → Authenticate (вхід через GitHub, один раз).');
} else {
  console.log('MCP лишився; прибрати: claude mcp remove timer -s user');
}
