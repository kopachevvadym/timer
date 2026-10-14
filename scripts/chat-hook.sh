#!/usr/bin/env bash
# Облік часу чату claude.ai як сесії агента: той самий /hooks/claude, що й хуки Claude Code.
#   scripts/chat-hook.sh UserPromptSubmit "текст промпту"   — хід почався
#   scripts/chat-hook.sh Stop                               — хід закінчився (чат «чекає на вас»)
#   scripts/chat-hook.sh SessionEnd                         — закрити сесію
# CHAT_SESSION_ID обовʼязковий і свій для кожного чату — тоді кілька чатів трекаються паралельно.
# Час іде в проєкт за CHAT_PROJECT_DIR (типово — папка timer).
set -euo pipefail
EVENT="${1:?подія: UserPromptSubmit | Stop | SessionEnd}"
PROMPT="${2:-}"
SESSION="${CHAT_SESSION_ID:?CHAT_SESSION_ID: унікальна назва чату (інакше паралельні чати злипнуться в одну сесію)}"
DIR="${CHAT_PROJECT_DIR:-/Users/home/Business/Own/timer}"
BASE="${TIMER_BASE:-https://timer.kopachev.life}"
SETTINGS="$HOME/.claude/settings.json"
ID="$(node -p "require('$SETTINGS').env.TIMER_CF_ID")"
SEC="$(node -p "require('$SETTINGS').env.TIMER_CF_SECRET")"
BODY="$(EVENT="$EVENT" SESSION="$SESSION" DIR="$DIR" PROMPT="$PROMPT" node -e '
  const b = { hook_event_name: process.env.EVENT, session_id: process.env.SESSION, cwd: process.env.DIR };
  if (process.env.PROMPT) b.prompt = process.env.PROMPT;
  process.stdout.write(JSON.stringify(b));')"
curl -sS -o /dev/null -w "%{http_code}\n" -X POST "$BASE/hooks/claude" \
  -H "content-type: application/json" -H "X-Project-Dir: $DIR" \
  -H "CF-Access-Client-Id: $ID" -H "CF-Access-Client-Secret: $SEC" \
  -d "$BODY"
