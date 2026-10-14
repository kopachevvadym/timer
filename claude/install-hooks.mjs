#!/usr/bin/env node
// Додає хуки трекера в ~/.claude/settings.json (для всіх проєктів).
// Повторний запуск не дублює хуки: старі записи з тим самим /hooks/claude замінюються.
//
//   node claude/install-hooks.mjs https://timer.example.com
//   node claude/install-hooks.mjs --remove
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const arg = process.argv[2];
if (!arg) {
  console.error('Використання: node claude/install-hooks.mjs https://timer.<домен> | --remove');
  process.exit(1);
}
const remove = arg === '--remove';
const base = remove ? null : arg.replace(/\/+$/, '');
if (base && !/^https?:\/\//.test(base)) {
  console.error('Очікувався URL на кшталт https://timer.example.com');
  process.exit(1);
}

const EVENTS = ['UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure', 'Notification', 'Stop', 'StopFailure', 'SessionEnd'];
const isOurs = (h) => typeof h?.url === 'string' && h.url.endsWith('/hooks/claude');

const dir = join(homedir(), '.claude');
const file = join(dir, 'settings.json');
mkdirSync(dir, { recursive: true });
const settings = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
if (existsSync(file)) copyFileSync(file, `${file}.bak-timer`);

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
            'CF-Access-Client-Id': '$TIMER_CF_ID',
            'CF-Access-Client-Secret': '$TIMER_CF_SECRET',
            'X-Project-Dir': '$CLAUDE_PROJECT_DIR',
          },
          allowedEnvVars: ['TIMER_CF_ID', 'TIMER_CF_SECRET', 'CLAUDE_PROJECT_DIR'],
        },
      ],
    });
  }
  if (groups.length > 0) settings.hooks[event] = groups;
  else delete settings.hooks[event];
}
if (Object.keys(settings.hooks).length === 0) delete settings.hooks;

writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
console.log(remove ? `Хуки трекера прибрано з ${file}` : `Хуки трекера → ${base}/hooks/claude записано в ${file}`);
console.log(`Резервна копія: ${file}.bak-timer`);
