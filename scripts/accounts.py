#!/usr/bin/env python3
"""Способи входу: GitHub + Google, прив'язка, відв'язка, захист від чужих акаунтів.
Потрібен `wrangler dev --local-upstream 127.0.0.1:8787` з DEV_LOGIN=1, GOOGLE_CLIENT_ID/SECRET у .dev.vars."""
import json, sys, urllib.request, urllib.error, urllib.parse, uuid

B = 'http://127.0.0.1:8787'
fails = 0

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None
opener = urllib.request.build_opener(NoRedirect)

def req(method, path, body=None, cookie=None):
    h = {'content-type': 'application/json', 'origin': B}
    if cookie: h['cookie'] = cookie
    r = urllib.request.Request(B + path, method=method, data=json.dumps(body).encode() if body is not None else None, headers=h)
    try:
        with opener.open(r) as resp:
            return resp.status, resp.read().decode(), resp.headers
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode(), e.headers

def check(name, cond):
    global fails
    print(('ok   ' if cond else 'FAIL ') + name)
    if not cond: fails += 1

u = uuid.uuid4().hex[:6]
alice = json.loads(req('GET', f'/auth/dev?login=al{u}')[1])
A = alice['cookie']
gsub = f'g-{u}'

st, raw, _ = req('GET', f'/auth/dev-google?link=1&sub={gsub}&email=al{u}@gmail.com', cookie=A)
me = json.loads(req('GET', '/api/me', cookie=A)[1])
check('прив’язка Google до GitHub-акаунта', st == 200 and me['logins']['google']['email'] == f'al{u}@gmail.com' and me['logins']['github'])
check('сервер каже, що Google налаштований', me['logins']['available']['google'] is True)

g = json.loads(req('GET', f'/auth/dev-google?sub={gsub}')[1])
check('вхід через прив’язаний Google → той самий акаунт', g['user'] == alice['user'])

bob = json.loads(req('GET', f'/auth/dev?login=bo{u}')[1])
st, raw, _ = req('GET', f'/auth/dev-google?link=1&sub={gsub}', cookie=bob['cookie'])
check('чужий Google не прив’язується (409)', st == 409)

new = json.loads(req('GET', f'/auth/dev-google?sub=new-{u}&email=new{u}@gmail.com&name=New')[1])
N = new['cookie']
me = json.loads(req('GET', '/api/me', cookie=N)[1])
check('новий Google → новий акаунт без GitHub', new['user'] not in (alice['user'], bob['user']) and me['logins']['github'] is None and me['logins']['google'])
st, raw, _ = req('POST', '/api/me/unlink', {'provider': 'google'}, cookie=N)
check('єдиний спосіб входу не відв’язується', st == 409)

st, _, _ = req('POST', '/api/me/unlink', {'provider': 'github'}, cookie=A)
me = json.loads(req('GET', '/api/me', cookie=A)[1])
check('відв’язати GitHub, коли є Google', st == 204 and me['logins']['github'] is None)
st, _, _ = req('POST', '/api/me/unlink', {'provider': 'google'}, cookie=A)
check('після цього Google — єдиний, не відв’язується', st == 409)

st, _, _ = req('DELETE', '/api/me', {'confirm': f'NEW{u}@gmail.com'}, cookie=N)
check('видалення Google-акаунта підтверджується поштою', st == 204)

st, _, h = req('GET', '/auth/google?tz=Europe/Kyiv')
loc = h.get('location', '')
check('/auth/google веде на accounts.google.com зі state', st == 302 and loc.startswith('https://accounts.google.com/') and 'state=' in loc and 'client_id=dev-google-client' in loc and '__Host-timer_oauth=' in h.get('set-cookie', ''))
st, _, _ = req('GET', '/auth/google?link=1')
check('прив’язка без входу → 401', st == 401)
st, _, h = req('GET', '/auth/google?tz=UTC')
state_cookie = h.get('set-cookie', '').split(';')[0]
state = urllib.parse.parse_qs(urllib.parse.urlparse(h['location']).query)['state'][0]
st, body, _ = req('GET', f'/auth/google/callback?code=x&state=WRONG{state}', cookie=state_cookie)
check('колбек з чужим state → 400', st == 400)
st, body, _ = req('GET', f'/auth/google/callback?code=x&state={state}')
check('колбек без cookie стану → 400', st == 400)
st, _, _ = req('GET', '/auth/providers')
check('/auth/providers відповідає', st == 200)

print('\nПомилок:', fails)
sys.exit(1 if fails else 0)
