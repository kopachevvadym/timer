#!/usr/bin/env python3
"""Таймер задач через MCP (клієнти без хуків) і його взаємодія з хуками.
Потрібен `wrangler dev --local-upstream 127.0.0.1:8787` з DEV_LOGIN=1 і свіжою базою."""
import json, sys, time, urllib.request, urllib.parse, uuid

B = 'http://127.0.0.1:8787'
fails = 0

def req(method, path, body=None, headers=None):
    h = {'content-type': 'application/json', 'origin': B, **(headers or {})}
    r = urllib.request.Request(B + path, method=method, data=json.dumps(body).encode() if body is not None else None, headers=h)
    try:
        with urllib.request.urlopen(r) as resp:
            raw = resp.read().decode()
            return resp.status, raw
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()

def check(name, cond):
    global fails
    print(('ok   ' if cond else 'FAIL ') + name)
    if not cond: fails += 1

login = 'mcpt' + uuid.uuid4().hex[:6]
st, raw = req('GET', f'/auth/dev?login={login}')
cookie = json.loads(raw)['cookie']
C = {'cookie': cookie}
full = json.loads(req('POST', '/api/keys', {'name': 'f', 'scope': 'full'}, C)[1])['key']
hooks = json.loads(req('POST', '/api/keys', {'name': 'h', 'scope': 'hooks'}, C)[1])['key']
F = {'authorization': f'Bearer {full}'}

def mcp(tool, args):
    body = {'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call', 'params': {'name': tool, 'arguments': args}}
    st, raw = req('POST', '/mcp', body, {**F, 'accept': 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18'})
    for line in raw.splitlines():
        if line.startswith('data: '): raw = line[6:]
    r = json.loads(raw)['result']
    return r['content'][0]['text'], r.get('isError')

def hook(ev):
    return req('POST', '/hooks/claude', ev, {'authorization': f'Bearer {hooks}'})[0]

def running():
    return json.loads(req('GET', '/api/now', None, C)[1])['running']

# 1. Без хуків: task_add(start) → таймер задачі; done → зупинено
txt, err = mcp('timer_task_add', {'title': 'Фіча A', 'project': 'Alpha', 'start': True}) if False else (None, None)
req('POST', '/api/projects', {'name': 'Alpha'}, C)
txt, err = mcp('timer_task_add', {'title': 'Фіча A', 'project': 'Alpha', 'start': True})
check('task_add start без помилки', not err)
r = running()
check('пішов таймер задачі через MCP', len(r) == 1 and ':mcp:' in r[0]['session_id'] and r[0]['task_title'] == 'Фіча A')
# 2. Друга задача паралельно
mcp('timer_task_add', {'title': 'Фіча B', 'project': 'Alpha'})
txt, err = mcp('timer_task_start', {'task': 'Фіча B', 'project': 'Alpha'})
r = running()
check('дві задачі одного проєкту йдуть паралельно', len(r) == 2 and {x['task_title'] for x in r} == {'Фіча A', 'Фіча B'})
# 3. Повторний старт не дублює
mcp('timer_task_start', {'task': 'Фіча B', 'project': 'Alpha'})
check('повторний старт не дублює', len(running()) == 2)
time.sleep(1.2)
# 4. done зупиняє лише свою задачу
txt, err = mcp('timer_task_done', {'task': 'Фіча A', 'project': 'Alpha'})
r = running()
check('done зупинив Фічу A, Фіча B іде', len(r) == 1 and r[0]['task_title'] == 'Фіча B')
ents = json.loads(req('GET', '/api/entries?period=today', None, C)[1])
ents = ents.get('entries', ents)
a = [e for e in ents if e.get('task_title') == 'Фіча A']
check('у Фічі A є запис ≥1 с', a and a[0]['stopped_at'] - a[0]['started_at'] >= 1000)

# 5. З хуками: MCP старт + PostToolUse прив'язка → таймер MCP прибрано, час іде в сесію
P = '/Users/x/beta'
sid = 'sess-' + uuid.uuid4().hex[:6]
hook({'hook_event_name': 'UserPromptSubmit', 'session_id': sid, 'cwd': P, 'prompt': 'go'})
mcp('timer_task_add', {'title': 'Фіча C', 'cwd': P})
mcp('timer_task_start', {'task': 'Фіча C', 'cwd': P})
r = [x for x in running() if x['project_name'] == 'beta']
check('до прив’язки: сесія + таймер MCP', len(r) == 2)
hook({'hook_event_name': 'PostToolUse', 'session_id': sid, 'cwd': P, 'tool_name': 'mcp__timer__timer_task_start', 'tool_input': {'task': 'Фіча C', 'cwd': P}})
r = [x for x in running() if x['project_name'] == 'beta']
check('після прив’язки: лише сесія агента з задачею (без подвійного часу)', len(r) == 1 and ':mcp:' not in r[0]['session_id'] and r[0]['task_title'] == 'Фіча C')
mcp('timer_task_done', {'task': 'Фіча C', 'cwd': P})
r = [x for x in running() if x['project_name'] == 'beta']
check('done: сесія з хуками працює далі без задачі', len(r) == 1 and r[0]['task_title'] is None)

# 6. Ручний таймер на задачі зупиняється на done
mcp('timer_task_add', {'title': 'Фіча D', 'project': 'Alpha'})
mcp('timer_start', {'project': 'Alpha', 'task': 'Фіча D'})
mcp('timer_task_done', {'task': 'Фіча D', 'project': 'Alpha'})
check('ручний таймер задачі зупинено на done', not [x for x in running() if x['task_title'] == 'Фіча D'])

# 7. Веб «Стоп» на таймері MCP
b = [x for x in running() if x['task_title'] == 'Фіча B'][0]
st, _ = req('POST', f"/api/sessions/{urllib.parse.quote(b['session_id'])}/stop", {}, C)
check('веб «Стоп» зупиняє таймер MCP', st == 200 and not [x for x in running() if x['task_title'] == 'Фіча B'])

print('\nПомилок:', fails)
sys.exit(1 if fails else 0)
