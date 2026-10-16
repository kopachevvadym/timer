#!/usr/bin/env bash
# Наскрізна перевірка проти `npm run dev` (локальна D1):
#   1) три агенти у двох проєктах + ручний таймер
#   2) звіт у трьох режимах
#   3) задачі: агент додає й починає задачу через MCP, хук прив'язує саме його сесію,
#      сусідній агент у тому ж проєкті лишається без задачі; «готово» розрізає інтервал
#   4) MCP: tools/list і кілька викликів
# Запуск: npm run db:migrate:local && npm run dev   (в іншому терміналі)  →  TIMER_KEY=tk_… npm run smoke
set -euo pipefail
BASE="${BASE:-http://127.0.0.1:8787}"
H=(-H 'content-type: application/json')
# API-ключ користувача (Налаштування → Ключ). Локально: python3 scripts/isolation.py створює своїх користувачів,
# а для smoke візьміть ключ із /api/keys після входу через /auth/dev.
: "${TIMER_KEY:?TIMER_KEY=tk_… — ключ користувача, від імені якого йде перевірка}"
H+=(-H "Authorization: Bearer $TIMER_KEY")

hook() { curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/hooks/claude" "${H[@]}" -d "$1"; echo " ← $2"; }
mcp() {
  curl -sS -X POST "$BASE/mcp" "${H[@]}" -H 'accept: application/json, text/event-stream' \
    -H 'mcp-protocol-version: 2025-06-18' -d "$1" | sed -n -e 's/^data: //p' -e 't' -e '/^{/p'
}
call() { mcp "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"$1\",\"arguments\":$2}}" | python3 -c 'import json,sys; r=json.load(sys.stdin); res=r.get("result") or r; print("\n".join(c.get("text","") for c in res.get("content",[])) if "content" in res else json.dumps(res, ensure_ascii=False))'; }
running() { curl -sS "$BASE/api/running" "${H[@]}" | python3 -c 'import json,sys; d=json.load(sys.stdin); [print("   ", e["session_id"][-1], e["project_name"], "→", e["task_title"] or "без задачі") for e in d["entries"] if e["source"]=="claude_code"]'; }

T=$(date +%s)
S1="smoke-$T-a"; S2="smoke-$T-b"; S3="smoke-$T-c"
P1="/tmp/smoke/alee-crm-erp"; P2="/tmp/smoke/extreme-games"

echo "== хуки"
hook "{\"hook_event_name\":\"UserPromptSubmit\",\"session_id\":\"$S1\",\"cwd\":\"$P1\",\"prompt\":\"Додай експорт рахунків у CSV\"}" "агент a стартує в $P1"
hook "{\"hook_event_name\":\"UserPromptSubmit\",\"session_id\":\"$S2\",\"cwd\":\"$P2/src\",\"prompt\":\"Пофікси колізії\"}" "агент b стартує в $P2/src"
curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/hooks/claude" "${H[@]}" -H "X-Project-Dir: $P1" \
  -d "{\"hook_event_name\":\"UserPromptSubmit\",\"session_id\":\"$S3\",\"cwd\":\"$P1/packages/api\",\"prompt\":\"Тести API\"}"; echo " ← агент c у підпапці $P1, але X-Project-Dir = корінь"
hook "{\"hook_event_name\":\"PostToolUse\",\"session_id\":\"$S1\",\"cwd\":\"$P1\",\"tool_name\":\"Bash\"}" "heartbeat агента a"
hook "{\"hook_event_name\":\"PreCompact\",\"session_id\":\"$S1\",\"cwd\":\"$P1\"}" "невідома подія ігнорується"
hook 'не json' "битий запит не валить хук"

echo "== ручний таймер"
PROJ=$(curl -sS -X POST "$BASE/api/projects" "${H[@]}" -d '{"name":"Дзвінки"}' | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
curl -sS -X POST "$BASE/api/projects/$PROJ/start" "${H[@]}" -d '{"note":"демо"}' >/dev/null && echo "запущено проєкт $PROJ"
echo -n "повторний старт: "; curl -sS -X POST "$BASE/api/projects/$PROJ/start" "${H[@]}" -d '{}'; echo

echo "== задачі через MCP + хук"
echo "-- агент a: timer_task_add start=true"
call timer_task_add "{\"title\":\"Експорт рахунків у CSV\",\"external_ref\":\"LIN-42\",\"cwd\":\"$P1\",\"start\":true}"
hook "{\"hook_event_name\":\"PostToolUse\",\"session_id\":\"$S1\",\"cwd\":\"$P1\",\"tool_name\":\"mcp__timer__timer_task_add\",\"tool_input\":{\"title\":\"Експорт рахунків у CSV\",\"external_ref\":\"LIN-42\",\"cwd\":\"$P1\",\"start\":true}}" "PostToolUse прив'язує сесію a"
echo "   агенти зараз (очікую: a → задача, c → без задачі, b → без задачі):"; running
call timer_task_add "{\"title\":\"Тести API\",\"cwd\":\"$P1\"}" >/dev/null
echo "-- агент c: timer_task_start за назвою"
call timer_task_start "{\"task\":\"тести api\",\"cwd\":\"$P1\"}"
hook "{\"hook_event_name\":\"PostToolUse\",\"session_id\":\"$S3\",\"cwd\":\"$P1\",\"tool_name\":\"mcp__timer__timer_task_start\",\"tool_input\":{\"task\":\"тести api\",\"cwd\":\"$P1\"}}" "PostToolUse прив'язує сесію c"
running
sleep 2
echo "-- timer_task_list"; call timer_task_list "{\"cwd\":\"$P1\"}"
echo "-- агент a: timer_task_done за номером LIN-42"; call timer_task_done "{\"task\":\"LIN-42\",\"cwd\":\"$P1\"}"
echo "   після «готово» (a → без задачі, c → Тести API):"; running
hook "{\"hook_event_name\":\"Stop\",\"session_id\":\"$S3\",\"cwd\":\"$P1\"}" "агент c закінчив хід"
hook "{\"hook_event_name\":\"UserPromptSubmit\",\"session_id\":\"$S3\",\"cwd\":\"$P1\",\"prompt\":\"Ще кейс для API\"}" "агент c новий хід — задача тримається"
running
echo -n "-- старт виконаної: "; call timer_task_start "{\"task\":\"LIN-42\",\"cwd\":\"$P1\"}"

sleep 1
hook "{\"hook_event_name\":\"Stop\",\"session_id\":\"$S2\",\"cwd\":\"$P2\"}" "агент b закінчив"

echo "== чекають на вас"
nowapi() { curl -sS "$BASE/api/now" "${H[@]}" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("    чекають:", [(w["session_id"][-1], w["waiting_reason"] or "закінчив хід", w["task_title"]) for w in d["waiting"] if "smoke" in w["session_id"]]); print("    працюють:", [(e["session_id"][-1], e["task_title"]) for e in d["running"] if e["source"]=="claude_code"]); t=d["today"]; print("    сьогодні: wall=%.1fs sum=%.1fs lanes=%s" % (t["wall_ms"]/1e3, t["sum_full_ms"]/1e3, [(l["name"], len(l["intervals"]), l["intervals"][-1][1] is None) for l in t["lanes"]]))'; }
nowapi   # очікую: b чекає (закінчив хід)
hook "{\"hook_event_name\":\"Notification\",\"session_id\":\"$S3\",\"cwd\":\"$P1\",\"message\":\"Claude needs your permission to use Bash\"}" "агент c просить дозволу → чекає, час стоп"
nowapi   # очікую: c чекає з причиною, c не працює
hook "{\"hook_event_name\":\"Notification\",\"session_id\":\"$S3\",\"cwd\":\"$P1\",\"message\":\"Claude is waiting for your input\"}" "повторне сповіщення не перетирає причину"
hook "{\"hook_event_name\":\"PostToolUse\",\"session_id\":\"$S3\",\"cwd\":\"$P1\",\"tool_name\":\"Bash\"}" "дозвіл дали → c знову працює з тією ж задачею"
nowapi   # очікую: c працює → Тести API, не чекає

echo "== зупинка сесій з вебу"
UID_=$(curl -sS "$BASE/api/me" "${H[@]}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["user"]["id"])')
stop_s() { curl -sS -X POST "$BASE/api/sessions/$UID_:$1/stop" "${H[@]}"; echo " ← $2"; }
stop_s "$S2" "прибрати b з «чекають»"
stop_s "$S3" "зупинити c, що працює"
hook "{\"hook_event_name\":\"PostToolUse\",\"session_id\":\"$S3\",\"cwd\":\"$P1\",\"tool_name\":\"Bash\"}" "heartbeat c після ручного стопу не відновлює облік"
nowapi   # очікую: b не чекає, c не працює
hook "{\"hook_event_name\":\"UserPromptSubmit\",\"session_id\":\"$S3\",\"cwd\":\"$P1\",\"prompt\":\"Новий промпт після стопу\"}" "новий промпт c — облік знову йде"
nowapi   # очікую: c працює → Тести API
echo -n "стоп ручного через сесію: "; curl -sS -X POST "$BASE/api/sessions/manual/stop" "${H[@]}"; echo

echo "== звіт сьогодні"
for m in full split focus; do
  curl -sS "$BASE/api/report?period=today&mode=$m" "${H[@]}" | python3 -c "import json,sys; r=json.load(sys.stdin); print(' $m: wall=%.1fs sum_full=%.1fs par=%.2f'%(r['wall_ms']/1e3,r['sum_full_ms']/1e3,r['parallelism']), {t['name']: round(t['ms']/1e3,1) for t in r['projects']}, 'задачі:', {t['title']: round(t['ms']/1e3,1) for t in r['tasks']})"
done

echo "== MCP"
mcp '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' | python3 -c 'import json,sys; print(" tools:", [t["name"] for t in json.load(sys.stdin)["result"]["tools"]])'
echo "-- timer_status";  call timer_status '{}'
echo "-- timer_report";  call timer_report '{"period":"today","mode":"split"}'
echo "-- timer_projects"; call timer_projects '{"action":"list"}'
echo "-- timer_stop";    call timer_stop '{"project":"Дзвінки"}'
echo "-- помилка";       call timer_projects '{"action":"rename","project":"немає такого","name":"x"}'

hook "{\"hook_event_name\":\"SessionEnd\",\"session_id\":\"$S1\",\"cwd\":\"$P1\"}" "агент a закрив сесію"
hook "{\"hook_event_name\":\"SessionEnd\",\"session_id\":\"$S3\",\"cwd\":\"$P1\"}" "агент c закрив сесію"
echo "== після стопів"
curl -sS "$BASE/api/running" "${H[@]}" | python3 -c 'import json,sys; print(" запущених:", len(json.load(sys.stdin)["entries"]))'
nowapi   # очікую: чекає лише b (a і c закрили сесії)
