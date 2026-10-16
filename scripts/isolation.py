#!/usr/bin/env python3
"""Перевірка ізоляції між користувачами й OAuth для MCP проти `wrangler dev` (локально).

    PUBLIC_URL=http://127.0.0.1:8787 у .dev.vars, npm run dev -- --local-upstream 127.0.0.1:8787
    python3 scripts/isolation.py

Вхід — через /auth/dev (працює лише коли PUBLIC_URL з http://).
"""
import base64
import hashlib
import json
import os
import re
import secrets
import sys
import urllib.error
import urllib.parse
import urllib.request

BASE = os.environ.get('BASE', 'http://127.0.0.1:8787')
FAILS = []


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


opener = urllib.request.build_opener(NoRedirect)


def req(method, path, body=None, headers=None, form=None):
    h = dict(headers or {})
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        h['content-type'] = 'application/json'
    if form is not None:
        data = urllib.parse.urlencode(form).encode()
        h['content-type'] = 'application/x-www-form-urlencoded'
    r = urllib.request.Request(BASE + path, method=method, data=data, headers=h)
    try:
        resp = opener.open(r)
    except urllib.error.HTTPError as e:
        resp = e
    raw = resp.read()
    try:
        js = json.loads(raw) if raw else None
    except Exception:
        js = raw.decode(errors='replace')
    return resp.status, js, resp.headers


def check(name, cond, extra=''):
    print(('  ok   ' if cond else '  FAIL ') + name + (f'  [{extra}]' if extra and not cond else ''))
    if not cond:
        FAILS.append(name)


def login(name):
    st, js, _ = req('GET', f'/auth/dev?login={name}')
    assert st == 200, (st, js)
    return {'cookie': js['cookie'], 'id': js['user']}


def api(u, method, path, body=None):
    return req(method, '/api' + path, body, {'cookie': u['cookie']})


def key_for(u, scope='full'):
    st, js, _ = api(u, 'POST', '/keys', {'name': 'test', 'scope': scope})
    assert st == 201, (st, js)
    return js['key']


def hook(key, event, session, cwd, **kw):
    st, js, _ = req('POST', '/hooks/claude', {'hook_event_name': event, 'session_id': session, 'cwd': cwd, **kw}, {'authorization': f'Bearer {key}'})
    return st


def mcp(auth, method, params=None):
    st, js, _ = req(
        'POST',
        '/mcp',
        {'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params or {}},
        {'authorization': f'Bearer {auth}', 'accept': 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18'},
    )
    if isinstance(js, str):
        m = re.search(r'data: (\{.*\})', js)
        js = json.loads(m.group(1)) if m else js
    return st, js


print('== користувачі')
alice, bob, owner = login('alice'), login('bob'), login('owner-dev')
check('власник забрав дані owner', owner['id'] == 'owner', owner['id'])
check('alice і bob — різні акаунти', alice['id'] != bob['id'])
ka, kb = key_for(alice), key_for(bob)
st, me, _ = api(alice, 'GET', '/me')
check('/api/me бачить свій ключ', st == 200 and len(me['keys']) == 1 and me['user']['note_from_prompt'] is False)
st, _, _ = req('GET', '/api/now')
check('/api без входу → 401', st == 401)
st, _, _ = req('POST', '/api/keys', {'name': 'x'}, {'authorization': f'Bearer {ka}'})
check('ключ не може створити ключ', st == 403)

print('== хуки з однаковим session_id і cwd у двох людей')
check('хук alice 204', hook(ka, 'UserPromptSubmit', 'S1', '/work/app', prompt='секретний промпт alice') == 204)
check('хук bob 204', hook(kb, 'UserPromptSubmit', 'S1', '/work/app', prompt='промпт bob') == 204)
check('хук без ключа 204 (мовчки)', req('POST', '/hooks/claude', {'hook_event_name': 'UserPromptSubmit', 'session_id': 'S9', 'cwd': '/x'})[0] == 204)
_, na, _ = api(alice, 'GET', '/now')
_, nb, _ = api(bob, 'GET', '/now')
check('alice бачить лише свій запис', len(na['running']) == 1)
check('bob бачить лише свій запис', len(nb['running']) == 1)
check('проєкти різні', na['running'][0]['project_id'] != nb['running'][0]['project_id'])
check('нотатка з промпту вимкнена за замовчуванням', na['running'][0]['note'] is None)
check('сесії з префіксом користувача', na['running'][0]['session_id'] == f"{alice['id']}:S1")
hook(kb, 'Stop', 'S1', '/work/app')
_, na2, _ = api(alice, 'GET', '/now')
check('Stop від bob не зупинив alice', len(na2['running']) == 1)

print('== чужі id → 404')
a_entry = na['running'][0]['id']
a_proj = na['running'][0]['project_id']
a_sess = na['running'][0]['session_id']
st, a_task, _ = api(alice, 'POST', f'/projects/{a_proj}/tasks', {'title': 'Секретна задача'})
check('alice створила задачу', st == 201)
b_proj = nb['running'][0]['project_id']
for name, (m, p, b) in {
    'GET чужої задачі': ('GET', f"/tasks/{a_task['id']}", None),
    'PATCH чужої задачі': ('PATCH', f"/tasks/{a_task['id']}", {'status': 'done'}),
    'DELETE чужої задачі': ('DELETE', f"/tasks/{a_task['id']}", None),
    'PATCH чужого запису': ('PATCH', f'/entries/{a_entry}', {'note': 'hack'}),
    'DELETE чужого запису': ('DELETE', f'/entries/{a_entry}', None),
    'задача в чужому проєкті': ('POST', f'/projects/{a_proj}/tasks', {'title': 'x'}),
    'старт таймера в чужому проєкті': ('POST', f'/projects/{a_proj}/start', {}),
    'стоп чужої сесії': ('POST', f'/sessions/{urllib.parse.quote(a_sess)}/stop', None),
    'перейменувати чужий проєкт': ('PATCH', f'/projects/{a_proj}', {'name': 'hack'}),
    'злити свій у чужий': ('POST', f'/projects/{b_proj}/merge', {'into': a_proj}),
    'шлях у чужий проєкт': ('POST', f'/projects/{a_proj}/paths', {'path': '/hack'}),
    'запис із чужою задачею': ('POST', f'/projects/{b_proj}/switch', {'task_id': a_task['id']}),
    'звіт по чужому проєкту': ('GET', f'/report?period=today&project_id={a_proj}', None),
}.items():
    st, js, _ = api(bob, m, p, b)
    leaked = isinstance(js, dict) and (js.get('projects') or js.get('title') == 'Секретна задача')
    check(name, (st in (400, 404) or (m == 'GET' and st == 200 and not leaked)), f'{st} {js}')
_, ta, _ = api(alice, 'GET', f"/tasks/{a_task['id']}")
check('задача alice ціла', ta['status'] != 'done' and ta['title'] == 'Секретна задача')
_, pa, _ = api(alice, 'GET', '/projects')
check('проєкт alice не перейменовано', pa[0]['name'] == 'app' and '/hack' not in pa[0]['paths'])
_, ea, _ = api(alice, 'GET', '/entries?period=today')
check('запис alice на місці й без «hack»', any(e['id'] == a_entry and e['note'] != 'hack' for e in ea['entries']))

print('== MCP з API-ключем')
st, tools = mcp(ka, 'tools/list')
check('tools/list з ключем', st == 200 and len(tools.get('result', {}).get('tools', [])) > 10, f'{st} {str(tools)[:200]}')
st, res = mcp(kb, 'tools/call', {'name': 'timer_task_list', 'arguments': {}})
text = json.dumps(res, ensure_ascii=False)
check('bob через MCP не бачить задач alice', 'Секретна задача' not in text, text[:200])
st, res = mcp(kb, 'tools/call', {'name': 'timer_task_done', 'arguments': {'task': a_task['id']}})
check('bob через MCP не закриє задачу alice', 'Помилка' in json.dumps(res, ensure_ascii=False))
st, _ = mcp('tk_wrong', 'tools/list')
check('MCP з невірним ключем → 401', st == 401)

print('== MCP через OAuth (DCR + PKCE + згода)')
st, reg, _ = req('POST', '/oauth/register', {'client_name': 'Test client', 'redirect_uris': ['https://claude.ai/api/mcp/auth_callback'], 'token_endpoint_auth_method': 'none', 'grant_types': ['authorization_code', 'refresh_token'], 'response_types': ['code']})
check('DCR', st == 201, f'{st} {reg}')
verifier = secrets.token_urlsafe(48)
challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b'=').decode()
q = urllib.parse.urlencode({'response_type': 'code', 'client_id': reg['client_id'], 'redirect_uri': 'https://claude.ai/api/mcp/auth_callback', 'code_challenge': challenge, 'code_challenge_method': 'S256', 'state': 'xyz', 'resource': f'{BASE}/mcp', 'scope': 'timer'})
st, _, h = req('GET', f'/authorize?{q}')
check('без входу /authorize → вхід GitHub', st == 302 and h['location'].startswith('/auth/github?next='), f"{st} {h.get('location')}")
st, html, h = req('GET', f'/authorize?{q}', headers={'cookie': alice['cookie']})
handle = re.search(r'name="handle" value="([^"]+)"', html or '')
check('сторінка згоди', st == 200 and handle is not None and 'Test client' in html, f'{st}')
binding = '; '.join(c.split(';')[0] for c in h.get_all('set-cookie') or [])
st, _, h = req('POST', '/authorize', form={'handle': handle.group(1), 'decision': 'approve'}, headers={'cookie': f"{alice['cookie']}; {binding}"})
loc = h.get('location', '')
code = urllib.parse.parse_qs(urllib.parse.urlparse(loc).query).get('code', [None])[0]
check('згода → code', st == 302 and code, f'{st} {loc[:120]}')
st, _, h = req('POST', '/authorize', form={'handle': handle.group(1), 'decision': 'approve'}, headers={'cookie': f"{bob['cookie']}; {binding}"})
check('повторне використання handle → помилка', st >= 400, str(st))
st, tok, _ = req('POST', '/oauth/token', form={'grant_type': 'authorization_code', 'code': code, 'redirect_uri': 'https://claude.ai/api/mcp/auth_callback', 'client_id': reg['client_id'], 'code_verifier': verifier, 'resource': f'{BASE}/mcp'})
check('обмін code на токен', st == 200 and tok.get('access_token'), f'{st} {tok}')
st, res = mcp(tok['access_token'], 'tools/call', {'name': 'timer_task_list', 'arguments': {}})
text = json.dumps(res, ensure_ascii=False)
check('OAuth-токен alice бачить її задачу', 'Секретна задача' in text, text[:200])

print('== права ключів, CSRF, редиректи, вихід')
kh = key_for(alice, 'hooks')
check('hooks-ключ пише хуки', hook(kh, 'UserPromptSubmit', 'S2', '/work/app') == 204 and len(api(alice, 'GET', '/now')[1]['running']) == 2)
st, _, _ = req('GET', '/api/now', headers={'authorization': f'Bearer {kh}'})
check('hooks-ключ не відкриває /api', st == 401, str(st))
st, _ = mcp(kh, 'tools/list')
check('hooks-ключ не відкриває MCP', st == 401, str(st))
r = urllib.request.Request(BASE + f'/api/projects/{a_proj}/tasks', method='POST', data=b'{"title":"csrf"}', headers={'cookie': alice['cookie'], 'content-type': 'text/plain'})
try:
    st = opener.open(r).status
except urllib.error.HTTPError as e:
    st = e.code
check('cookie + text/plain тіло → 403 (CSRF)', st == 403, str(st))
st, _, _ = req('POST', f'/api/projects/{a_proj}/tasks', {'title': 'csrf2'}, {'cookie': alice['cookie'], 'origin': 'https://evil.example'})
check('cookie + чужий Origin → 403', st == 403, str(st))
st, _, _ = req('POST', f'/api/projects/{a_proj}/tasks', {'title': 'csrf3'}, {'cookie': alice['cookie'], 'sec-fetch-site': 'cross-site'})
check('cookie + Sec-Fetch-Site cross-site → 403', st == 403, str(st))
alice2 = login('alice')
st, _, _ = req('POST', '/auth/logout', None, {'cookie': alice2['cookie']})
check('вихід', st == 204)
st, _, _ = api(alice, 'GET', '/now')
check('вихід гасить і інші сесії', st == 401, str(st))
alice = login('alice')

print('== відкликання ключа й видалення акаунта')
_, me, _ = api(bob, 'GET', '/me')
st, _, _ = api(bob, 'DELETE', f"/keys/{me['keys'][0]['id']}")
check('ключ відкликано', st == 204)
st, _ = mcp(kb, 'tools/list')
check('відкликаний ключ не працює в MCP', st == 401)
st, _, _ = api(alice, 'DELETE', f"/keys/{me['keys'][0]['id']}")
check('чужий ключ не відкликати', st == 404)
st, _, _ = api(bob, 'DELETE', '/me', {'confirm': 'bob'})
check('bob видалив акаунт', st == 204)
st, _, _ = api(bob, 'GET', '/now')
check('після видалення сесія недійсна', st == 401)
_, na3, _ = api(alice, 'GET', '/now')
check('дані alice не зачеплено', len(na3['running']) == 2)

print(f"\n{'УСЕ ГАРАЗД' if not FAILS else 'ПРОВАЛЕНО: ' + ', '.join(FAILS)}")
sys.exit(1 if FAILS else 0)
