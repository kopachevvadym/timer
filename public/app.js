// Веб-інтерфейс трекера. Без збірки: звичайний ES-модуль, маршрути через #hash.
// Дані з API вставляються лише як текст (textContent) — без innerHTML.

// ───────── мова інтерфейсу: uk або en
// Явний вибір зберігається в localStorage; без нього — українська, якщо вона є серед мов браузера.
const LANG = (() => {
  try {
    const v = localStorage.getItem('timer.lang');
    if (v === 'uk' || v === 'en') return v;
  } catch {}
  return (navigator.languages || [navigator.language]).some((l) => /^uk\b/i.test(l || '')) ? 'uk' : 'en';
})();
document.documentElement.lang = LANG;
// Ту саму мову бачить сервер: сторінки входу й помилки API.
document.cookie = `lang=${LANG}; Path=/; Max-Age=31536000; SameSite=Lax; Secure`;
/** Текст поточною мовою: L('Українською', 'In English'). */
const L = (uk, en) => (LANG === 'en' ? en : uk);
const LOCALE = L('uk-UA', 'en-GB');
// Статичний текст з index.html: data-en — текст, data-en-placeholder / -aria-label / -title — атрибути.
if (LANG === 'en') {
  for (const n of document.querySelectorAll('[data-en]')) n.textContent = n.dataset.en;
  for (const a of ['placeholder', 'aria-label', 'title'])
    for (const n of document.querySelectorAll(`[data-en-${a}]`)) n.setAttribute(a, n.getAttribute(`data-en-${a}`));
}
function setLang(v) {
  try {
    localStorage.setItem('timer.lang', v);
  } catch {}
  location.reload();
}

const state = {
  tz: 'Europe/Kyiv',
  offset: 0, // Date.now() сервера − Date.now() браузера
  projects: [], // усі, разом з архівними
  now: null, // останній /api/now
  reports: { period: 'this_week', mode: 'full' },
  entries: { period: 'this_week', q: '', selected: null, creating: false, data: null },
  projectsView: { showArchived: false },
  expandedLanes: loadExpanded(), // проєкти, розгорнуті на шкалі дня
};

function loadExpanded() {
  try {
    return new Set(JSON.parse(localStorage.getItem('timer.expandedLanes') || '[]'));
  } catch {
    return new Set();
  }
}
function saveExpanded() {
  try {
    localStorage.setItem('timer.expandedLanes', JSON.stringify([...state.expandedLanes]));
  } catch {}
}

const PALETTE = ['#2B59FF', '#F26B1D', '#0E9F8E', '#7C5CFF', '#D23C8C', '#B98A00', '#8A8A83'];
const PERIODS = [
  ['today', L('Сьогодні', 'Today')],
  ['yesterday', L('Вчора', 'Yesterday')],
  ['this_week', L('Тиждень', 'Week')],
  ['last_week', L('Мин. тиждень', 'Last week')],
  ['this_month', L('Місяць', 'Month')],
  ['last_month', L('Мин. місяць', 'Last month')],
];
const MODES = [
  ['full', L('Повний', 'Full'), L('Кожен проєкт отримує весь свій час — сума більша за реальний, якщо агенти працювали паралельно.', 'Each project gets all of its time — the total exceeds real time when agents worked in parallel.')],
  ['split', L('Поділ', 'Split'), L('Паралельний час ділиться порівну між проєктами — сума дорівнює реальному часу.', 'Parallel time is split evenly between projects — the total equals real time.')],
  ['focus', L('Фокус', 'Focus'), L('Час іде проєкту, на який ви переключились останнім (ручний таймер або промпт агенту).', 'Time goes to the project you switched to last (manual timer or a prompt to an agent).')],
];

// ───────── утиліти

const serverNow = () => Date.now() + state.offset;

class AuthError extends Error {}

async function api(path, opts = {}) {
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method: opts.method || (opts.body ? 'POST' : 'GET'),
      headers: opts.body ? { 'content-type': 'application/json', 'x-lang': LANG } : { 'x-lang': LANG },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      credentials: 'same-origin',
      redirect: 'manual',
    });
  } catch {
    throw new Error(L('Немає зв’язку із сервером — перевірте інтернет і оновіть сторінку', 'No connection to the server — check your internet and reload the page'));
  }
  if (res.type === 'opaqueredirect' || res.status === 401) {
    showLanding();
    throw new AuthError(L('Сесія закінчилась — увійдіть знову', 'Your session has expired — please sign in again'));
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'style' && typeof v === 'object') for (const [sk, sv] of Object.entries(v)) n.style.setProperty(sk, sv);
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'value') n.value = v;
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) if (c !== null && c !== undefined && c !== false) n.append(c);
  return n;
}

// Іконки — лише константні рядки.
const ICONS = {
  play: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 1.8v8.4L10 6z"/></svg>',
  x: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="m2.5 2.5 7 7M9.5 2.5l-7 7"/></svg>',
  stop: '<svg viewBox="0 0 12 12" aria-hidden="true"><rect x="2.5" y="2.5" width="7" height="7" rx="1.2" fill="currentColor" stroke="none"/></svg>',
};
function icon(name) {
  const t = document.createElement('template');
  t.innerHTML = ICONS[name];
  return t.content.firstChild;
}

function hm(ms) {
  const min = Math.max(0, Math.round(ms / 60000));
  return `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}`;
}
function hms(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
function waitText(ms) {
  const min = Math.max(0, Math.floor(ms / 60000));
  if (min < 1) return L('<1 хв', '<1 min');
  if (min < 60) return L(`${min} хв`, `${min} min`);
  return hm(ms);
}
function pct(x) {
  return `${Math.round(x * 100)}%`;
}

const fmtCache = new Map();
function fmt(key, opts) {
  const k = `${key}|${state.tz}`;
  if (!fmtCache.has(k)) fmtCache.set(k, new Intl.DateTimeFormat(opts.locale || LOCALE, { timeZone: state.tz, ...opts }));
  return fmtCache.get(k);
}
const timeOf = (ms) => fmt('time', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms);
const hourOf = (ms) => fmt('hour', { hour: '2-digit', hourCycle: 'h23' }).format(ms).padStart(2, '0');
const dayKey = (ms) => fmt('key', { locale: 'en-CA', year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);
const dayTitle = (ms) => fmt('daytitle', { weekday: 'short', day: 'numeric', month: 'long' }).format(ms);
function localInput(ms) {
  // значення для <input type="datetime-local"> у часовому поясі сервера
  const p = Object.fromEntries(
    fmt('parts', { locale: 'en-CA', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(ms)
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
const fromInput = (v) => (v ? v.replace('T', ' ') : undefined);

function hash(s) {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return h;
}
function projectById(id) {
  return state.projects.find((p) => p.id === id);
}
// Колір без явного: за порядком створення проєкту — перші шість не повторюються.
function colorOf(projectId, explicit) {
  const c = explicit ?? projectById(projectId)?.color;
  if (c) return c;
  const order = [...state.projects].sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
  const i = order.findIndex((p) => p.id === projectId);
  return PALETTE[(i >= 0 ? i : hash(projectId || '')) % (PALETTE.length - 1)];
}

// Сповіщення Claude Code приходять англійською — перекладаємо типові.
function reasonText(r) {
  if (!r) return null;
  if (LANG === 'en') return r;
  const perm = r.match(/permission to use (.+)$/i);
  if (perm) return `просить дозволу: ${perm[1]}`;
  if (/waiting for your input/i.test(r)) return 'чекає на вашу відповідь';
  return r;
}
function dot(projectId, explicit, cls = '') {
  return el('span', { class: `dot ${cls}`, 'aria-hidden': 'true', style: { '--c': colorOf(projectId, explicit) } });
}
function refTitle(ref, title) {
  return [ref ? el('span', { class: 'mono' }, ref) : null, ref ? ' ' : null, title];
}

let toastTimer;
function toast(msg, isErr = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = `toast on${isErr ? ' err' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = 'toast'), isErr ? 5000 : 2200);
}

async function act(fn, ok) {
  try {
    const r = await fn();
    if (ok) toast(ok);
    return r;
  } catch (e) {
    toast(e.message, true);
    throw e;
  }
}

// Кнопка, що просить другого натискання (без confirm()).
function confirmButton(label, confirmLabel, onConfirm, cls = 'btn sm ghost danger') {
  let armed = false;
  let timer;
  const b = el('button', { type: 'button', class: cls }, label);
  b.addEventListener('click', async () => {
    if (!armed) {
      armed = true;
      b.textContent = confirmLabel;
      timer = setTimeout(() => {
        armed = false;
        b.textContent = label;
      }, 3500);
      return;
    }
    clearTimeout(timer);
    b.disabled = true;
    try {
      await onConfirm();
    } finally {
      b.disabled = false;
    }
  });
  return b;
}
function iconConfirm(name, ariaLabel, onConfirm) {
  let armed = false;
  let timer;
  const b = el('button', { type: 'button', class: 'btn icon ghost', 'aria-label': ariaLabel, title: ariaLabel }, icon(name));
  b.addEventListener('click', async () => {
    if (!armed) {
      armed = true;
      b.classList.add('danger');
      b.title = L('Натисніть ще раз', 'Click again');
      timer = setTimeout(() => {
        armed = false;
        b.classList.remove('danger');
        b.title = ariaLabel;
      }, 3500);
      return;
    }
    clearTimeout(timer);
    await onConfirm();
  });
  return b;
}

function seg(options, current, onPick, label) {
  return el(
    'div',
    { class: 'seg', role: 'group', 'aria-label': label },
    options.map(([v, text, title]) =>
      el('button', { type: 'button', 'aria-pressed': String(v === current), title, onclick: () => onPick(v) }, text),
    ),
  );
}

async function loadProjects() {
  state.projects = await api('/projects?archived=1');
}

// ───────── маршрутизація

const view = document.getElementById('view');
let renderSeq = 0;
let pollTimer = null;

function route() {
  const [name = 'now', arg] = location.hash.replace(/^#/, '').split('/');
  return { name: ['now', 'reports', 'entries', 'projects', 'settings'].includes(name) ? name : 'now', arg: arg ? decodeURIComponent(arg) : null };
}

async function render() {
  if (!state.me) return;
  const seq = ++renderSeq;
  const r = route();
  for (const a of document.querySelectorAll('[data-route]')) {
    if (a.dataset.route === r.name) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  document.querySelector('.shell').classList.toggle('wide', r.name === 'entries' || r.name === 'projects');
  clearInterval(pollTimer);
  try {
    const node = await VIEWS[r.name](r.arg);
    if (seq !== renderSeq) return;
    view.replaceChildren(node);
    document.title = `${(LANG === 'en' ? { now: 'Now', reports: 'Reports', entries: 'Entries', projects: 'Projects', settings: 'Settings' } : { now: 'Зараз', reports: 'Звіти', entries: 'Записи', projects: 'Проєкти', settings: 'Налаштування' })[r.name]} · Timer`;
    tick();
  } catch (e) {
    if (seq !== renderSeq || e instanceof AuthError) return;
    view.replaceChildren(el('div', { class: 'card empty' }, e.message));
  }
  if (r.name === 'now') pollTimer = setInterval(() => !document.hidden && refresh(), 15000);
}

async function refresh() {
  // перерендер поточного екрана без скидання вибору
  await render();
}

// Живі лічильники: [data-since] — скільки минуло, [data-wait] — скільки чекає.
function tick() {
  const now = serverNow();
  for (const n of document.querySelectorAll('[data-since]')) n.textContent = hms(now - Number(n.dataset.since));
  for (const n of document.querySelectorAll('[data-wait]')) {
    const ms = now - Number(n.dataset.wait);
    n.textContent = waitText(ms);
    n.classList.toggle('danger', ms > 10 * 60000);
  }
  for (const n of document.querySelectorAll('[data-run]')) n.textContent = hm(Number(n.dataset.base) + (now - Number(n.dataset.run)));
}
setInterval(tick, 1000);

// ───────── Іконка, поки трекер працює: великий червоний круг
const favicon = document.querySelector('link[rel="icon"]');
const FAVICON_IDLE = favicon.href;
const FAVICON_RUNNING = `data:image/svg+xml,${encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 22 22'><circle cx='11' cy='11' r='10' fill='#E5322D'/></svg>")}`;
let isRunning = false;

function setRunning(on) {
  on = Boolean(on);
  document.querySelector('.logo')?.classList.toggle('running', on);
  if (on === isRunning) return;
  isRunning = on;
  favicon.href = on ? FAVICON_RUNNING : FAVICON_IDLE;
}

// «Зараз» і «Проєкти» самі тягнуть /now; для решти екранів і фонової вкладки перевіряємо окремо.
setInterval(() => {
  if (!state.me) return;
  const n = route().name;
  if (!document.hidden && (n === 'now' || n === 'projects')) return;
  api('/now').then((x) => setRunning(x.running.length), () => {});
}, 30000);

// ───────── Зараз

async function viewNow() {
  const [now] = await Promise.all([api('/now'), loadProjects()]);
  state.now = now;
  setRunning(now.running.length);
  state.offset = now.now - Date.now();
  state.tz = now.timezone || state.tz;
  const frag = el('div', { class: 'stack', style: { gap: '32px' } });

  // Чекають на вас
  if (now.waiting.length) {
    frag.append(
      el(
        'section',
        { class: 'section', 'aria-labelledby': 'wait-h' },
        el('h1', { id: 'wait-h', class: 'label' }, L(`Чекають на вас · ${now.waiting.length}`, `Waiting for you · ${now.waiting.length}`)),
        el('ul', { class: 'list card strong' }, groupByProject(now.waiting).map((g) => projectGroup(g, waitRow, 'hollow', (w) => w.waiting_since, waitText))),
      ),
    );
  }

  // Працюють — кілька сесій/задач одного проєкту показуються під одним проєктом.
  const running = now.running;
  frag.append(
    el(
      'section',
      { class: 'section', 'aria-labelledby': 'run-h' },
      el(now.waiting.length ? 'h2' : 'h1', { id: 'run-h', class: 'label' }, running.length ? L(`Працюють · ${running.length}`, `Working · ${running.length}`) : L('Працюють', 'Working')),
      running.length
        ? el('ul', { class: 'list card' }, groupByProject(running).map((g) => projectGroup(g, runRow, 'live', (e) => e.started_at, hms)))
        : el(
            'div',
            { class: 'card empty' },
            L('Зараз ніхто не працює. Агент з’явиться тут, щойно отримає промпт; свою роботу запускайте кнопкою «+ Таймер».', 'Nothing is running. An agent shows up here as soon as it gets a prompt; start your own work with “+ Timer”.'),
          ),
    ),
  );

  frag.append(todaySection(now.today));
  return frag;
}

// [{project_id, project_name, project_color, items: [...]}] у порядку першої появи.
function groupByProject(list) {
  const groups = new Map();
  for (const x of list) {
    if (!groups.has(x.project_id)) groups.set(x.project_id, { project_id: x.project_id, project_name: x.project_name, project_color: x.project_color, items: [] });
    groups.get(x.project_id).items.push(x);
  }
  return [...groups.values()];
}

// Один елемент — звичайний рядок; кілька — заголовок проєкту і вкладені рядки задач/сесій.
// since(x) — від якого моменту рахувати; fmt — як показати тривалість.
function projectGroup(g, row, dotKind, since, fmt) {
  if (g.items.length === 1) return row(g.items[0], false);
  const from = Math.min(...g.items.map(since));
  const attr = dotKind === 'live' ? 'data-since' : 'data-wait';
  const counts = g.items.length;
  return el(
    'li',
    { class: 'pgroup' },
    el(
      'div',
      { class: 'sess pgroup-head' },
      dot(g.project_id, g.project_color, dotKind),
      el('span', { class: 'body' }, el('span', { class: 'name' }, g.project_name), el('span', { class: 'sub' }, L(`${counts} ${plural(counts, 'паралельна сесія', 'паралельні сесії', 'паралельних сесій')}`, `${counts} parallel ${pluralEn(counts, 'session', 'sessions')}`))),
      el('span', { class: 'big', [attr]: from, title: L('Від найранішого початку', 'Since the earliest start') }, fmt(serverNow() - from)),
    ),
    el('ul', { class: 'list nested' }, g.items.map((x) => row(x, true))),
  );
}

function plural(n, one, few, many) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}
const pluralEn = (n, one, many) => (n === 1 ? one : many);

function runRow(e, nested) {
  const manual = e.source === 'manual';
  const sub = e.task_title ? refTitle(e.task_ref, e.task_title) : [manual ? L('вручну', 'manual') : L('без задачі', 'no task'), e.note ? ` · ${e.note}` : ''];
  // У групі назва проєкту вже в заголовку: рядок називаємо задачею, а нотатку — підписом.
  const title = nested ? (e.task_title ? refTitle(e.task_ref, e.task_title) : manual ? L('Вручну', 'Manual') : L('Без задачі', 'No task')) : e.project_name;
  const viaMcp = /^[^:]+:mcp:/.test(e.session_id);
  const subLine = nested ? [manual ? L('вручну', 'manual') : viaMcp ? L('задача через MCP', 'task via MCP') : L('агент', 'agent'), e.note ? ` · ${e.note}` : ''] : sub;
  return el(
    'li',
    { class: 'sess' },
    nested ? null : dot(e.project_id, e.project_color, 'live'),
    el(
      'button',
      {
        type: 'button',
        class: 'sess-open',
        title: L('Зупинити або підправити час', 'Stop or adjust the time'),
        onclick: () =>
          openEntryDialog({
            entryId: e.id,
            startedAt: e.started_at,
            stoppedAt: null,
            projectId: e.project_id,
            projectName: e.project_name,
            color: e.project_color,
            sub,
            sessionId: e.session_id,
            manual,
            waiting: false,
          }),
      },
      el('span', { class: 'name' }, title),
      el('span', { class: 'sub' }, subLine),
    ),
    el(
      'button',
      {
        type: 'button',
        class: 'btn sm',
        title: manual ? L('Зупинити ручний таймер', 'Stop the manual timer') : L('Зупинити облік цієї сесії агента до його наступного промпту', 'Stop tracking this agent session until its next prompt'),
        'aria-label': `${L('Зупинити', 'Stop')}: ${e.project_name}${e.task_title ? ` · ${e.task_title}` : ''}`,
        onclick: () =>
          manual ? act(() => api(`/projects/${e.project_id}/stop`, { method: 'POST' }), L('Зупинено', 'Stopped')).then(refresh) : stopSessionUi(e.session_id, L('Сесію зупинено', 'Session stopped')),
      },
      icon('stop'),
      el('span', { class: 'hide-sm' }, L('Стоп', 'Stop')),
    ),
    el('span', { class: 'big', 'data-since': e.started_at }, hms(serverNow() - e.started_at)),
  );
}

function waitRow(w, nested) {
  const head = w.task_title ? refTitle(w.task_ref, w.task_title) : w.last_prompt;
  const what = reasonText(w.waiting_reason) || L('відповів, чекає на вас', 'replied, waiting for you');
  const title = nested ? (w.task_title ? refTitle(w.task_ref, w.task_title) : w.last_prompt || L('Без задачі', 'No task')) : w.project_name;
  const subLine = nested ? what : [head ? [head, ' — '] : null, what];
  return el(
    'li',
    { class: 'sess' },
    nested ? null : dot(w.project_id, w.project_color, 'hollow'),
    el(
      'button',
      {
        type: 'button',
        class: 'sess-open',
        title: L('Підправити час або прибрати', 'Adjust the time or dismiss'),
        disabled: !w.entry_id,
        onclick: () =>
          openEntryDialog({
            entryId: w.entry_id,
            startedAt: w.entry_started_at,
            stoppedAt: w.entry_stopped_at,
            projectId: w.project_id,
            projectName: w.project_name,
            color: w.project_color,
            sub: [head ? [head, ' — '] : null, what],
            sessionId: w.session_id,
            manual: false,
            waiting: true,
          }),
      },
      el('span', { class: 'name' }, title),
      el('span', { class: 'sub' }, subLine),
    ),
    el('span', { class: 'tag' }, L('чекає', 'waiting')),
    el('span', { class: 'big', 'data-wait': w.waiting_since }, waitText(serverNow() - w.waiting_since)),
    el(
      'button',
      {
        type: 'button',
        class: 'btn icon ghost',
        'aria-label': L(`Прибрати сесію ${w.project_name} з очікування`, `Dismiss the ${w.project_name} session from waiting`),
        title: L('Сесію закінчено — прибрати. Новий промпт агенту поверне її.', 'The session is done — dismiss it. A new prompt to the agent brings it back.'),
        onclick: () => stopSessionUi(w.session_id, L('Прибрано', 'Dismissed')),
      },
      icon('x'),
    ),
  );
}

// Зупинити сесію агента (або прибрати з «Чекають на вас»). Агент не вимикається — лише облік;
// новий промпт агенту знову почне рахувати час.
function stopSessionUi(sessionId, ok) {
  return act(() => api(`/sessions/${encodeURIComponent(sessionId)}/stop`, { method: 'POST' }), ok).then(refresh, () => {});
}

// ───────── діалог сесії: зупинити або підправити початок / кінець / тривалість

const entryDialog = document.getElementById('entry-dialog');
const entryForm = document.getElementById('entry-form');

// Поля datetime-local порівнюємо як «умовний UTC»: важлива лише різниця, не пояс браузера.
const fakeMs = (v) => (v ? Date.parse(`${v}:00Z`) : NaN);
const fromFake = (ms) => new Date(ms).toISOString().slice(0, 16);
function parseDur(v) {
  const m = String(v).trim().match(/^(\d+)(?::(\d{1,2}))?(?::(\d{1,2}))?$/);
  if (!m) return NaN;
  if (m[2] === undefined) return Number(m[1]) * 60000; // «45» — хвилини
  return (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] ?? 0)) * 1000;
}

function openEntryDialog(x) {
  const running = x.stoppedAt === null;
  const start0 = localInput(x.startedAt);
  const stop0 = running ? '' : localInput(x.stoppedAt);
  const start = el('input', { type: 'datetime-local', name: 'start', required: true, value: start0 });
  const stop = el('input', { type: 'datetime-local', name: 'stop', value: stop0 });
  const dur = el('input', { name: 'duration', class: 'dur-input', inputmode: 'numeric', autocomplete: 'off', placeholder: L('Г:ХХ', 'H:MM') });

  let lastEdited = 'times';
  const sync = (from) => {
    lastEdited = from;
    const a = fakeMs(start.value);
    if (from === 'dur') {
      const d = parseDur(dur.value);
      if (Number.isFinite(a) && d > 0) stop.value = fromFake(a + d);
      return;
    }
    const b = fakeMs(stop.value);
    dur.value = Number.isFinite(a) && Number.isFinite(b) && b > a ? hm(b - a) : '';
  };
  start.addEventListener('input', () => sync('times'));
  stop.addEventListener('input', () => sync('times'));
  dur.addEventListener('input', () => sync('dur'));
  sync('times');
  if (running) dur.placeholder = L(`іде ${hm(serverNow() - x.startedAt)} — введіть, щоб зупинити`, `running ${hm(serverNow() - x.startedAt)} — type to stop`);

  const stopNow = () =>
    x.manual
      ? act(() => api(`/projects/${x.projectId}/stop`, { method: 'POST' }), L('Зупинено', 'Stopped'))
      : act(() => api(`/sessions/${encodeURIComponent(x.sessionId)}/stop`, { method: 'POST' }), x.waiting ? L('Прибрано', 'Dismissed') : L('Сесію зупинено', 'Session stopped'));

  entryForm.replaceChildren(
    el(
      'div',
      { class: 'row between' },
      el('div', { class: 'row', style: { gap: '10px', 'min-width': '0' } }, dot(x.projectId, x.color, running ? 'live' : ''), el('h2', { id: 'entry-dialog-h', class: 'ellipsis' }, x.projectName)),
      el('button', { type: 'button', class: 'btn icon ghost', 'aria-label': L('Закрити', 'Close'), onclick: () => entryDialog.close() }, icon('x')),
    ),
    el('p', { class: 'live-note' }, x.sub),
    running
      ? el('div', { class: 'row between' }, el('span', { class: 'dur-big', 'data-since': x.startedAt }, hms(serverNow() - x.startedAt)), el('span', { class: 'badge' }, x.manual ? L('вручну · іде', 'manual · running') : L('агент · іде', 'agent · running')))
      : null,
    el('label', { class: 'field' }, L('Початок', 'Start'), start),
    el('label', { class: 'field' }, running ? L('Кінець — порожньо, поки йде', 'End — empty while running') : L('Кінець', 'End'), stop),
    el('label', { class: 'field' }, L('Тривалість', 'Duration'), dur),
    el(
      'div',
      { class: 'row wrap' },
      el('button', { type: 'submit', class: 'btn primary sm' }, L('Зберегти', 'Save')),
      running || x.waiting
        ? el('button', { type: 'button', class: 'btn sm', onclick: () => stopNow().then(() => { entryDialog.close(); refresh(); }, () => {}) }, icon(running ? 'stop' : 'x'), running ? L('Зупинити зараз', 'Stop now') : L('Прибрати з очікування', 'Dismiss from waiting'))
        : null,
      el('span', { style: { flex: '1' } }),
      el('a', { href: '#entries', class: 'btn sm ghost', onclick: () => { state.entries.selected = x.entryId; entryDialog.close(); } }, L('У записах', 'In entries')),
    ),
    !x.manual && running ? el('p', { class: 'hint', style: { margin: '0' } }, L('Зупинка вимикає лише облік: агент працює далі, новий промпт знову запустить лічильник.', 'Stopping only pauses tracking: the agent keeps working, and its next prompt starts the counter again.')) : null,
  );

  entryForm.onsubmit = async (ev) => {
    ev.preventDefault();
    const body = {};
    if (start.value !== start0) body.start = fromInput(start.value);
    if (stop.value && stop.value !== stop0) body.stop = fromInput(stop.value);
    // Задали лише тривалість — рахуємо кінець від точного початку (з секундами), а не від округленого до хвилини.
    if (body.stop && !body.start && lastEdited === 'dur' && parseDur(dur.value) > 0) body.stop = x.startedAt + parseDur(dur.value);
    if (!Object.keys(body).length) return entryDialog.close();
    try {
      await api(`/entries/${x.entryId}`, { method: 'PATCH', body });
      // Агенту, якому задали кінець, не даємо самому відновити облік до нового промпту.
      if (running && body.stop && !x.manual) await api(`/sessions/${encodeURIComponent(x.sessionId)}/stop`, { method: 'POST' }).catch(() => {});
      toast(body.stop && running ? L('Зупинено', 'Stopped') : L('Збережено', 'Saved'));
      entryDialog.close();
      refresh();
    } catch (e) {
      toast(e.message, true);
    }
  };
  entryDialog.showModal();
  tick();
}
entryDialog.addEventListener('click', (ev) => {
  if (ev.target === entryDialog) entryDialog.close();
});

function todaySection(t) {
  const head = el(
    'div',
    { class: 'head' },
    el('h2', { class: 'label' }, L('Сьогодні', 'Today')),
    el('span', { class: 'big-num' }, hm(t.wall_ms)),
    t.sum_streams_ms > t.wall_ms + 60000
      ? el(
          'span',
          { class: 'label', style: { 'font-weight': '400' }, title: L('Кожна сесія агента, задача й ручний таймер — окремий потік, навіть в одному проєкті', 'Each agent session, task and manual timer is a separate stream, even within one project') },
          L('усі сесії разом ', 'all sessions combined '),
          el('span', { class: 'mono' }, hm(t.sum_streams_ms)),
          L(' · паралельно ', ' · parallel '),
          el('span', { class: 'mono', style: { color: 'var(--accent)' } }, `×${t.parallelism.toFixed(2)}`),
          t.peak_streams > 1 ? [L(' · пік ', ' · peak '), el('span', { class: 'mono' }, `${t.peak_streams}`)] : null,
        )
      : null,
  );
  if (!t.lanes.length) return el('section', { class: 'section' }, head, el('div', { class: 'card empty' }, L('Сьогодні ще нічого не записано.', 'Nothing recorded yet today.')));

  const H = 3600_000;
  const first = Math.min(...t.lanes.flatMap((l) => l.intervals.map((i) => i[0])));
  let start = Math.floor(first / H) * H;
  let end = Math.ceil(t.now / H) * H;
  if (end - start < 4 * H) start = Math.max(t.from, end - 4 * H);
  if (end <= start) end = start + 4 * H;
  const span = end - start;
  const pos = (ms) => `${(((ms - start) / span) * 100).toFixed(3)}%`;
  const hours = span / H;
  const step = hours > 12 ? 3 : hours > 7 ? 2 : 1;
  const ticks = [];
  for (let x = start; x <= end; x += step * H) ticks.push(x);

  const segTitle = (st, g) => {
    const stop = g.stop ?? t.now;
    const what = g.task_title ? `${g.task_ref ? `${g.task_ref} ` : ''}${g.task_title}` : st.label;
    const kind = st.kind === 'manual' ? L('вручну', 'manual') : st.kind === 'mcp' ? L('задача через MCP', 'task via MCP') : L('сесія агента', 'agent session');
    return [what, `${timeOf(g.start)}–${g.stop === null ? L('зараз', 'now') : timeOf(stop)} · ${hm(stop - g.start)} · ${kind}`, g.note && g.note !== what ? g.note : null]
      .filter(Boolean)
      .join('\n');
  };
  const openSeg = (l, st, g) =>
    openEntryDialog({
      entryId: g.entry_id,
      startedAt: g.entry_started_at,
      stoppedAt: g.entry_stopped_at,
      projectId: l.project_id,
      projectName: l.name,
      color: l.color,
      sub: segTitle(st, g).split('\n')[0],
      sessionId: st.kind === 'manual' ? 'manual' : st.key,
      manual: st.kind === 'manual',
      waiting: false,
    });

  const laneRow = (l) => {
    const open = state.expandedLanes.has(l.project_id);
    const toggle = el(
      'button',
      {
        type: 'button',
        class: 'n lane-toggle',
        'aria-expanded': String(open),
        title: open ? L('Згорнути', 'Collapse') : L(`Розгорнути: ${l.streams.length} ${plural(l.streams.length, 'потік', 'потоки', 'потоків')}`, `Expand: ${l.streams.length} ${pluralEn(l.streams.length, 'stream', 'streams')}`),
        onclick: () => {
          if (open) state.expandedLanes.delete(l.project_id);
          else state.expandedLanes.add(l.project_id);
          saveExpanded();
          card.replaceWith((card = buildCard()));
        },
      },
      el('span', { class: 'chev', 'aria-hidden': 'true' }, open ? '▾' : '▸'),
      el('span', { class: 'lane-name' }, l.name),
      l.streams.length > 1 ? el('span', { class: 'lane-count' }, `×${l.streams.length}`) : null,
    );
    const main = el(
      'div',
      { class: 'lane' },
      toggle,
      el(
        'span',
        { class: 'track', style: { '--c': colorOf(l.project_id, l.color) } },
        l.intervals.map(([s, e]) =>
          el('span', {
            class: e === null ? 'live' : '',
            title: `${l.name}: ${timeOf(s)}–${e === null ? L('зараз', 'now') : timeOf(e)} · ${hm((e ?? t.now) - s)}`,
            style: { left: pos(s), width: pos(start + ((e ?? t.now) - s)) },
          }),
        ),
        el('span', { class: 'nowline', style: { left: pos(t.now) } }),
      ),
      el('span', { class: 't' }, hm(l.total_ms)),
    );
    if (!open) return main;
    const subs = l.streams.map((st) =>
      el(
        'div',
        { class: 'lane sub' },
        el('span', { class: 'n', title: st.label }, st.label),
        el(
          'span',
          { class: 'track', style: { '--c': colorOf(l.project_id, l.color) } },
          st.segments.map((g) =>
            el('button', {
              type: 'button',
              class: `seg${g.stop === null ? ' live' : ''}${st.kind === 'manual' ? ' manual' : ''}`,
              title: segTitle(st, g),
              'aria-label': segTitle(st, g).replace(/\n/g, ', '),
              style: { left: pos(g.start), width: pos(start + ((g.stop ?? t.now) - g.start)) },
              onclick: () => openSeg(l, st, g),
            }),
          ),
          el('span', { class: 'nowline', style: { left: pos(t.now) } }),
        ),
        el('span', { class: 't' }, hm(st.total_ms)),
      ),
    );
    return el('div', { class: 'lane-group' }, main, ...subs);
  };

  const buildCard = () =>
    el(
      'div',
      {
        class: 'card pad lanes',
        'aria-label': `${L('Шкала дня', 'Day timeline')} ${timeOf(start)}–${timeOf(end)}: ${t.lanes.map((l) => `${l.name} ${hm(l.total_ms)}`).join(', ')}`,
      },
      t.lanes.map(laneRow),
      el(
        'div',
        { class: 'lane ticks', 'aria-hidden': 'true' },
        el('span'),
        el(
          'span',
          { class: 'scale' },
          ticks.map((x) => el('span', { style: { left: pos(x) } }, hourOf(x))),
        ),
        el('span'),
      ),
    );
  let card = buildCard();
  return el('section', { class: 'section', style: { gap: '12px' } }, head, card);
}

// ───────── Звіти

async function viewReports() {
  const { period, mode } = state.reports;
  const [r] = await Promise.all([api(`/report?period=${period}&mode=${mode}`), state.projects.length ? null : loadProjects()]);
  state.tz = r.timezone || state.tz;
  const set = (patch) => {
    Object.assign(state.reports, patch);
    render();
  };
  const toolbar = el(
    'div',
    { class: 'toolbar' },
    seg(PERIODS, period, (v) => set({ period: v }), L('Період', 'Period')),
    seg(MODES, mode, (v) => set({ mode: v }), L('Режим розподілу', 'Allocation mode')),
    el('span', { class: 'grow' }),
    el('button', { type: 'button', class: 'btn sm', onclick: () => exportCsv(period) }, 'CSV'),
  );

  const tiles = el(
    'div',
    { class: 'tiles' },
    tile(hm(r.wall_ms), L('Реальний час', 'Real time')),
    tile(hm(r.sum_streams_ms), L('Усі сесії разом', 'All sessions combined')),
    tile(`×${(r.parallelism || 0).toFixed(2)}`, r.peak_streams > 1 ? L(`Паралельність · пік ${r.peak_streams}`, `Parallelism · peak ${r.peak_streams}`) : L('Паралельність', 'Parallelism'), true),
    tile(hm(r.avg_daily_ms), L(`Середнє за день · ${r.days_with_entries} дн.`, `Daily average · ${r.days_with_entries} ${pluralEn(r.days_with_entries, 'day', 'days')}`)),
  );

  const parts = [toolbar, tiles];
  if (r.days.length > 1) parts.push(daysChart(r.days));

  const total = r.projects.reduce((a, p) => a + p.ms, 0);
  const max = Math.max(1, ...r.projects.map((p) => p.ms));
  parts.push(
    el(
      'section',
      { class: 'section' },
      el('div', { class: 'head' }, el('h2', { class: 'label' }, L('Проєкти', 'Projects')), el('span', { class: 'label', style: { 'font-weight': '400' } }, MODES.find((m) => m[0] === mode)[2])),
      r.projects.length
        ? el(
            'div',
            { class: 'card pad hbars' },
            r.projects.map((p) =>
              el(
                'div',
                { class: 'hbar' },
                el('a', { class: 'n', href: `#projects/${encodeURIComponent(p.project_id)}`, style: { color: 'var(--ink)' } }, dot(p.project_id, p.color), el('span', { class: 'ellipsis' }, p.name)),
                el('span', { class: 'track', style: { '--c': colorOf(p.project_id, p.color) } }, el('span', { style: { left: '0', width: `${(p.ms / max) * 100}%` } })),
                el('span', { class: 'v' }, hm(p.ms)),
                el('span', { class: 'p' }, total ? pct(p.ms / total) : '—'),
              ),
            ),
          )
        : el('div', { class: 'card empty' }, L('За цей період записів немає.', 'No entries for this period.')),
    ),
  );

  if (r.tasks.length) {
    parts.push(
      el(
        'section',
        { class: 'section' },
        el('h2', { class: 'label' }, L('Задачі', 'Tasks')),
        el(
          'ul',
          { class: 'list card' },
          r.tasks.map((t) =>
            el(
              'li',
              { class: 'sess', style: { padding: '12px 20px' } },
              dot(t.project_id),
              el(
                'span',
                { class: 'body' },
                el('span', { class: 'ellipsis', style: { 'font-size': '14px' } }, t.status === 'done' ? '✓ ' : '', t.title),
                el('span', { class: 'sub' }, t.project_name),
              ),
              el('span', { class: 'mono', style: { 'font-size': '14px', 'font-weight': '500' } }, hm(t.ms)),
            ),
          ),
        ),
      ),
    );
  }
  if (r.running_included) parts.push(el('p', { class: 'hint', style: { margin: '0' } }, L('Запущені зараз записи пораховано до поточної хвилини.', 'Entries still running are counted up to the current minute.')));
  return el('div', { class: 'stack', style: { gap: '24px' } }, parts);
}

function tile(v, k, accent = false) {
  return el('div', { class: 'card tile' }, el('span', { class: `v${accent ? ' accent' : ''}` }, v), el('span', { class: 'k' }, k));
}

function daysChart(days) {
  const max = Math.max(1, ...days.map((d) => Math.max(d.sum_streams_ms, d.wall_ms)));
  const many = days.length > 10;
  const today = dayKey(serverNow());
  return el(
    'section',
    { class: 'section' },
    el(
      'div',
      { class: 'head' },
      el('h2', { class: 'label' }, L('По днях', 'By day')),
      el('span', { class: 'legend' }, el('span', {}, el('i'), L('реальний час', 'real time')), el('span', {}, el('i', { class: 'sum' }), L('усі сесії разом', 'all sessions combined'))),
    ),
    el(
      'div',
      { class: 'card pad chart' },
      el(
        'div',
        { class: 'cols', role: 'img', 'aria-label': days.map((d) => L(`${d.date}: ${hm(d.wall_ms)} реального, ${hm(d.sum_streams_ms)} разом`, `${d.date}: ${hm(d.wall_ms)} real, ${hm(d.sum_streams_ms)} combined`)).join('; ') },
        days.map((d) => {
          const [y, m, dd] = d.date.split('-').map(Number);
          const label = many
            ? String(dd)
            : new Intl.DateTimeFormat(LOCALE, { timeZone: 'UTC', weekday: 'short' }).format(Date.UTC(y, m - 1, dd));
          return el(
            'div',
            { class: 'col', title: `${d.date} · ${L('реально', 'real')} ${hm(d.wall_ms)} · ${L('разом', 'combined')} ${hm(d.sum_streams_ms)} · ×${d.wall_ms ? (d.sum_streams_ms / d.wall_ms).toFixed(1) : '0'}` },
            el('span', { class: 'h' }, many || !d.wall_ms ? '' : hm(d.wall_ms)),
            el(
              'span',
              { class: 'bars' },
              el('span', { class: 'sum', style: { height: `${(d.sum_streams_ms / max) * 100}%` } }),
              el('span', { class: 'real', style: { height: `${(d.wall_ms / max) * 100}%` } }),
            ),
            el('span', { class: 'd', style: d.date === today ? { color: 'var(--ink)', 'font-weight': '500' } : {} }, label),
          );
        }),
      ),
    ),
  );
}

async function exportCsv(period) {
  const data = await act(() => api(`/entries?period=${period}`));
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n;]/.test(s) || /^[=+\-@]/.test(s) ? `"${s.replace(/"/g, '""').replace(/^([=+\-@])/, "'$1")}"` : s;
  };
  const now = serverNow();
  const rows = [['date', 'start', 'stop', 'duration_min', 'project', 'task', 'note', 'source']];
  for (const e of [...data.entries].reverse()) {
    const stop = e.stopped_at ?? now;
    rows.push([
      dayKey(e.started_at),
      timeOf(e.started_at),
      e.stopped_at ? timeOf(e.stopped_at) : '',
      Math.round((stop - e.started_at) / 60000),
      e.project_name,
      e.task_title ?? '',
      e.note ?? '',
      e.source,
    ]);
  }
  const blob = new Blob(['﻿' + rows.map((r) => r.map(esc).join(',')).join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = el('a', { href: URL.createObjectURL(blob), download: `timer-${period}-${dayKey(now)}.csv` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  if (data.truncated) toast(L('У CSV лише перші 1000 записів періоду', 'The CSV contains only the first 1000 entries of the period'), true);
}

// ───────── Записи

async function viewEntries() {
  const s = state.entries;
  const [data] = await Promise.all([api(`/entries?period=${s.period}`), loadProjects()]);
  s.data = data;
  state.offset = data.now - Date.now();

  const search = el('input', { type: 'search', placeholder: L('Пошук: проєкт, задача, нотатка', 'Search: project, task, note'), value: s.q, 'aria-label': L('Пошук записів', 'Search entries'), style: { 'max-width': '320px' } });
  const listHost = el('div');
  const panelHost = el('div');

  const drawList = () => listHost.replaceChildren(entriesList(filtered()));
  const drawPanel = () => panelHost.replaceChildren(entryPanel());
  const filtered = () => {
    const q = s.q.trim().toLocaleLowerCase('uk');
    if (!q) return data.entries;
    return data.entries.filter((e) => [e.project_name, e.task_title, e.note].some((x) => x && x.toLocaleLowerCase('uk').includes(q)));
  };
  search.addEventListener('input', () => {
    s.q = search.value;
    drawList();
  });

  const toolbar = el(
    'div',
    { class: 'toolbar' },
    search,
    seg(PERIODS.slice(0, 5), s.period, (v) => {
      s.period = v;
      s.selected = null;
      render();
    }, L('Період', 'Period')),
    el('span', { class: 'grow' }),
    el('button', {
      type: 'button',
      class: 'btn sm',
      onclick: () => {
        s.selected = null;
        s.creating = true;
        drawList();
        drawPanel();
        panelHost.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      },
    }, L('+ Запис', '+ Entry')),
  );

  const onSelect = (id) => {
    s.selected = id;
    s.creating = false;
    drawList();
    drawPanel();
    if (matchMedia('(max-width: 860px)').matches) panelHost.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };
  state.entries.onSelect = onSelect;

  drawList();
  drawPanel();
  return el('div', { class: 'stack', style: { gap: '20px' } }, toolbar, el('div', { class: 'split' }, listHost, panelHost));
}

function entriesList(entries) {
  const s = state.entries;
  if (!entries.length) return el('div', { class: 'card empty' }, s.q ? L('Нічого не знайдено.', 'Nothing found.') : L('За цей період записів немає.', 'No entries for this period.'));
  const now = serverNow();
  const groups = new Map();
  for (const e of entries) {
    const k = dayKey(e.started_at);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }
  const items = [];
  for (const [, list] of groups) {
    const sum = list.reduce((a, e) => a + ((e.stopped_at ?? now) - e.started_at), 0);
    items.push(el('li', { class: 'day-h' }, el('span', {}, dayTitle(list[0].started_at)), el('span', { class: 'mono' }, hm(sum))));
    for (const e of list) {
      const running = e.stopped_at === null;
      const title = e.task_title || e.note || (e.source === 'manual' ? L('Ручний таймер', 'Manual timer') : L('Агент без задачі', 'Agent, no task'));
      const sub = [e.project_name, e.task_title && e.note ? ` · ${e.note}` : '', e.source === 'claude_code' ? L(' · агент', ' · agent') : ''];
      items.push(
        el(
          'li',
          {},
          el(
            'button',
            { type: 'button', class: 'entry', 'aria-current': String(s.selected === e.id), onclick: () => s.onSelect(e.id) },
            dot(e.project_id, e.project_color, running ? 'live' : ''),
            el('span', { class: 'body' }, el('span', { class: 'name' }, e.task_ref ? `${e.task_ref} ` : '', title), el('span', { class: 'sub' }, sub)),
            el('span', { class: 'when' }, `${timeOf(e.started_at)}–${running ? L('зараз', 'now') : timeOf(e.stopped_at)}`),
            running
              ? el('span', { class: 'dur', 'data-run': e.started_at, 'data-base': 0 }, hm(now - e.started_at))
              : el('span', { class: 'dur' }, hm(e.stopped_at - e.started_at)),
          ),
        ),
      );
    }
  }
  if (s.data?.truncated) items.push(el('li', { class: 'more' }, L('Показано перші 1000 записів — звузьте період.', 'Showing the first 1000 entries — narrow the period.')));
  return el('ul', { class: 'list card', style: { overflow: 'hidden' } }, items);
}

function entryPanel() {
  const s = state.entries;
  const e = s.selected ? s.data.entries.find((x) => x.id === s.selected) : null;
  if (!e && !s.creating) {
    return el('div', { class: 'card panel' }, el('p', { class: 'hint', style: { margin: '0' } }, L('Оберіть запис, щоб змінити проєкт, задачу, нотатку чи час. Пропущений шматок роботи додайте через «+ Запис».', 'Select an entry to change its project, task, note or time. Add missed work with “+ Entry”.')));
  }
  const now = serverNow();
  const projects = state.projects.filter((p) => !p.archived_at || p.id === e?.project_id);
  if (!projects.length) return el('div', { class: 'card panel' }, el('p', { class: 'hint' }, L('Спершу створіть проєкт на сторінці «Проєкти».', 'Create a project on the Projects page first.')));

  const project = el('select', { name: 'project' }, projects.map((p) => el('option', { value: p.id }, p.name)));
  project.value = e?.project_id ?? projects[0].id;
  const task = el('select', { name: 'task' });
  const note = el('input', { name: 'note', value: e?.note ?? '', autocomplete: 'off', placeholder: L('Що робили', 'What you worked on') });
  const start = el('input', { type: 'datetime-local', name: 'start', required: true, value: localInput(e?.started_at ?? now - 3600_000) });
  const stop = el('input', { type: 'datetime-local', name: 'stop', value: e ? (e.stopped_at ? localInput(e.stopped_at) : '') : localInput(now) });
  const dur = el('span', { class: 'dur-big' });

  const fillTasks = async () => {
    const list = await api(`/tasks?project_id=${encodeURIComponent(project.value)}&status=all`).catch(() => []);
    const keep = e?.task_id && e.project_id === project.value ? e.task_id : '';
    task.replaceChildren(
      el('option', { value: '' }, L('— без задачі —', '— no task —')),
      ...list.filter((t) => t.status !== 'done' || t.id === keep).map((t) => el('option', { value: t.id }, `${t.external_ref ? `${t.external_ref} ` : ''}${t.title}`)),
    );
    task.value = keep;
  };
  project.addEventListener('change', fillTasks);
  fillTasks();

  // Тривалість рахуємо з рядків полів (час браузера не важливий — лише різниця).
  const updDur = () => {
    const a = Date.parse(`${start.value}:00Z`);
    const b = stop.value ? Date.parse(`${stop.value}:00Z`) : NaN;
    if (e && !e.stopped_at && !stop.value) {
      dur.textContent = hms(serverNow() - e.started_at);
      dur.dataset.since = e.started_at;
    } else {
      delete dur.dataset.since;
      dur.textContent = Number.isFinite(a) && Number.isFinite(b) ? (b >= a ? hm(b - a) : '—') : '—';
    }
  };
  start.addEventListener('input', updDur);
  stop.addEventListener('input', updDur);
  updDur();

  const form = el(
    'form',
    { class: 'card panel', 'aria-label': e ? L('Редагування запису', 'Edit entry') : L('Новий запис', 'New entry') },
    el('div', { class: 'row between' }, el('h3', {}, e ? L('Запис', 'Entry') : L('Новий запис', 'New entry')), e ? el('span', { class: 'badge' }, e.source === 'manual' ? L('вручну', 'manual') : L('агент', 'agent')) : null),
    dur,
    el('label', { class: 'field' }, L('Проєкт', 'Project'), project),
    el('label', { class: 'field' }, L('Задача', 'Task'), task),
    el('label', { class: 'field' }, L('Нотатка', 'Note'), note),
    el('label', { class: 'field' }, L('Початок', 'Start'), start),
    el('label', { class: 'field' }, e && !e.stopped_at ? L('Кінець — іде зараз; вкажіть, щоб зупинити', 'End — running now; set it to stop') : L('Кінець', 'End'), stop),
    el(
      'div',
      { class: 'row wrap' },
      el('button', { type: 'submit', class: 'btn primary sm' }, e ? L('Зберегти', 'Save') : L('Додати', 'Add')),
      e
        ? el('button', {
            type: 'button',
            class: 'btn sm',
            title: L('Запустити ручний таймер з тим самим проєктом, задачею й нотаткою', 'Start a manual timer with the same project, task and note'),
            onclick: () =>
              act(() => api(`/projects/${e.project_id}/start`, { body: { note: e.note ?? undefined, task_id: e.task_id ?? undefined } }), L('Таймер запущено', 'Timer started')).then(() => (location.hash = '#now')),
          }, L('Продовжити', 'Continue'))
        : el('button', { type: 'button', class: 'btn sm ghost', onclick: () => { s.creating = false; render(); } }, L('Скасувати', 'Cancel')),
      el('span', { class: 'grow', style: { flex: '1' } }),
      e
        ? confirmButton(L('Видалити', 'Delete'), L('Точно видалити?', 'Really delete?'), () =>
            act(() => api(`/entries/${e.id}`, { method: 'DELETE' }), L('Запис видалено', 'Entry deleted')).then(() => {
              s.selected = null;
              render();
            }),
          )
        : null,
    ),
  );
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const body = { project_id: project.value, task_id: task.value || null, note: note.value.trim() || null, start: fromInput(start.value) };
    if (stop.value) body.stop = fromInput(stop.value);
    if (e) {
      await act(() => api(`/entries/${e.id}`, { method: 'PATCH', body }), L('Збережено', 'Saved'));
    } else {
      if (!stop.value) return toast(L('Вкажіть кінець', 'Set the end time'), true);
      const created = await act(() => api('/entries', { body }), L('Запис додано', 'Entry added'));
      s.selected = created.id;
      s.creating = false;
    }
    render();
  });
  return form;
}

// ───────── Проєкти

async function viewProjects(arg) {
  const [, now, open] = await Promise.all([loadProjects(), api('/now'), api('/tasks?status=open')]);
  state.now = now;
  setRunning(now.running.length);
  state.offset = now.now - Date.now();
  const pv = state.projectsView;
  const active = state.projects.filter((p) => !p.archived_at);
  const archived = state.projects.filter((p) => p.archived_at);
  const todayMs = Object.fromEntries(now.today.lanes.map((l) => [l.project_id, l.total_ms]));
  const openCount = {};
  for (const t of open) openCount[t.project_id] = (openCount[t.project_id] || 0) + 1;
  const runningBy = {};
  for (const e of now.running) runningBy[e.project_id] = [...(runningBy[e.project_id] || []), e];

  const selected = projectById(arg) ?? active[0] ?? archived[0];

  const link = (p) =>
    el(
      'a',
      { href: `#projects/${encodeURIComponent(p.id)}`, 'aria-current': String(p.id === selected?.id), class: p.archived_at ? 'archived' : '' },
      dot(p.id, p.color, runningBy[p.id] ? 'live' : ''),
      el('span', { class: 'ellipsis' }, p.name),
      el('span', { class: 'meta' }, todayMs[p.id] ? hm(todayMs[p.id]) : openCount[p.id] ? L(`${openCount[p.id]} ${plural(openCount[p.id], 'задача', 'задачі', 'задач')}`, `${openCount[p.id]} ${pluralEn(openCount[p.id], 'task', 'tasks')}`) : ''),
    );

  const newName = el('input', { placeholder: L('Новий проєкт', 'New project'), 'aria-label': L('Назва нового проєкту', 'New project name'), autocomplete: 'off', style: { height: '36px' } });
  const newForm = el(
    'form',
    { class: 'row', style: { gap: '6px', padding: '6px' } },
    newName,
    el('button', { type: 'submit', class: 'btn sm' }, L('Додати', 'Add')),
  );
  newForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (!newName.value.trim()) return;
    const p = await act(() => api('/projects', { body: { name: newName.value.trim() } }), L('Проєкт створено', 'Project created'));
    location.hash = `#projects/${encodeURIComponent(p.id)}`;
  });

  const side = el(
    'nav',
    { class: 'card plist', 'aria-label': L('Проєкти', 'Projects') },
    active.map(link),
    archived.length
      ? el(
          'button',
          {
            type: 'button',
            class: 'btn sm ghost',
            style: { 'justify-content': 'flex-start' },
            onclick: () => {
              pv.showArchived = !pv.showArchived;
              render();
            },
          },
          pv.showArchived ? L('Сховати архів', 'Hide archive') : L(`Архів · ${archived.length}`, `Archive · ${archived.length}`),
        )
      : null,
    pv.showArchived ? archived.map(link) : null,
    newForm,
  );

  if (!selected) {
    return el(
      'div',
      { class: 'pgrid' },
      side,
      el('div', { class: 'card empty' }, L('Проєктів ще немає. Вони з’являються самі, коли агент отримує перший промпт у новій папці; для ручного обліку створіть проєкт ліворуч.', 'No projects yet. They appear on their own when an agent gets its first prompt in a new folder; for manual tracking, create a project on the left.')),
    );
  }
  return el('div', { class: 'pgrid' }, side, await projectDetail(selected, todayMs[selected.id] || 0, runningBy[selected.id] || []));
}

async function projectDetail(p, today, running) {
  const [tasks, week] = await Promise.all([
    api(`/tasks?project_id=${encodeURIComponent(p.id)}&status=all`),
    api(`/report?period=this_week&mode=full&project_id=${encodeURIComponent(p.id)}`),
  ]);
  const weekMs = week.projects.find((x) => x.project_id === p.id)?.ms ?? 0;
  const now = serverNow();
  const recentDone = (t) => t.status === 'done' && t.done_at && now - t.done_at < 7 * 86400_000;
  const doing = tasks.filter((t) => t.status !== 'done' && (t.status === 'doing' || t.active_sessions > 0));
  const todo = tasks.filter((t) => t.status === 'todo' && !t.active_sessions);
  const done = tasks.filter(recentDone).sort((a, b) => b.done_at - a.done_at);
  const agents = running.filter((e) => e.source === 'claude_code').length;
  const manual = running.find((e) => e.source === 'manual');

  // Заголовок
  const title = el(
    'div',
    { class: 'title' },
    dot(p.id, p.color, running.length ? 'live' : ''),
    el('h1', {}, p.name),
    agents ? el('span', { class: 'chip' }, L(`${agents} ${plural(agents, 'агент працює', 'агенти працюють', 'агентів працюють')}`, `${agents} ${pluralEn(agents, 'agent', 'agents')} working`)) : null,
    p.repo ? el('span', { class: 'chip mono', title: L('Репозиторій: за ним MCP знаходить проєкт з будь-якої папки чи клону', 'Repository: MCP uses it to find the project from any folder or clone') }, p.repo.replace(/^github\.com\//, '')) : null,
    p.archived_at ? el('span', { class: 'chip' }, L('в архіві', 'archived')) : null,
    el('span', { style: { flex: '1' } }),
    manual
      ? el('button', { type: 'button', class: 'btn sm', onclick: () => act(() => api(`/projects/${p.id}/stop`, { method: 'POST' }), L('Зупинено', 'Stopped')).then(refresh) }, icon('stop'), L('Стоп', 'Stop'))
      : el('button', { type: 'button', class: 'btn sm play', onclick: () => openTimer(p.id) }, icon('play'), L('Таймер', 'Timer')),
  );

  // Шляхи
  const pathInput = el('input', { placeholder: L('/Users/…/папка-проєкту', '/Users/…/project-folder'), 'aria-label': L('Новий шлях', 'New path'), autocomplete: 'off', style: { height: '32px', 'font-family': 'var(--mono)', 'font-size': '12px' } });
  const pathForm = el('form', { class: 'row', style: { gap: '6px' }, hidden: true }, pathInput, el('button', { type: 'submit', class: 'btn sm' }, L('Додати', 'Add')));
  pathForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (!pathInput.value.trim()) return;
    await act(() => api(`/projects/${p.id}/paths`, { body: { path: pathInput.value.trim() } }), L('Шлях додано', 'Path added'));
    refresh();
  });
  const paths = el(
    'div',
    { class: 'stack', style: { gap: '8px' } },
    el(
      'div',
      { class: 'paths' },
      p.paths.map((path) =>
        el(
          'span',
          { class: 'path', title: path },
          el('span', {}, path),
          el('button', {
            type: 'button',
            'aria-label': L(`Відв’язати ${path}`, `Unlink ${path}`),
            onclick: () => act(() => api(`/projects/${p.id}/paths?path=${encodeURIComponent(path)}`, { method: 'DELETE' }), L('Шлях відв’язано', 'Path unlinked')).then(refresh),
          }, '×'),
        ),
      ),
      el('button', { type: 'button', class: 'btn sm ghost', style: { height: '26px' }, onclick: () => { pathForm.hidden = !pathForm.hidden; if (!pathForm.hidden) pathInput.focus(); } }, L('+ шлях', '+ path')),
    ),
    pathForm,
    !p.paths.length ? el('p', { class: 'hint', style: { margin: '0' } }, L('Шляхів немає — агенти сюди час не пишуть, лише ручний таймер.', 'No paths — agents don’t log time here, only the manual timer does.')) : null,
  );

  const stats = el(
    'div',
    { class: 'stats3' },
    tile(hm(today), L('Сьогодні', 'Today')),
    tile(hm(weekMs), L('Тиждень', 'Week')),
    tile(String(doing.length + todo.length), L('Відкритих задач', 'Open tasks')),
  );

  // Нова задача
  const taskInput = el('input', { placeholder: L('LIN-42: Що зробити', 'LIN-42: What to do'), 'aria-label': L('Нова задача', 'New task'), autocomplete: 'off', name: 'task_title' });
  const addForm = el('form', { class: 'addtask' }, taskInput, el('button', { type: 'submit', class: 'btn' }, L('Додати', 'Add')));
  addForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const raw = taskInput.value.trim();
    if (!raw) return;
    const m = raw.match(/^([A-Za-z][A-Za-z0-9]*-\d+)\s*[:\-—]?\s+(.+)$/);
    const body = m ? { external_ref: m[1].toUpperCase(), title: m[2] } : { title: raw };
    await act(() => api(`/projects/${p.id}/tasks`, { body }), L('Задачу додано', 'Task added'));
    refresh();
  });

  const group = (label, list, empty) =>
    el(
      'section',
      { class: 'section' },
      el('h2', { class: 'label' }, list.length ? `${label} · ${list.length}` : label),
      list.length ? el('ul', { class: 'list card' }, list.map((t) => taskRow(p, t))) : empty ? el('div', { class: 'card empty' }, empty) : null,
    );

  // Ще дії: перейменувати, злити, архів
  const rename = el('input', { value: p.name, 'aria-label': L('Нова назва', 'New name'), autocomplete: 'off', style: { height: '36px' } });
  const renameForm = el('form', { class: 'row', style: { gap: '6px' } }, rename, el('button', { type: 'submit', class: 'btn sm' }, L('Перейменувати', 'Rename')));
  renameForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (rename.value.trim() && rename.value.trim() !== p.name) {
      await act(() => api(`/projects/${p.id}`, { method: 'PATCH', body: { name: rename.value.trim() } }), L('Перейменовано', 'Renamed'));
      refresh();
    }
  });
  const others = state.projects.filter((x) => x.id !== p.id && !x.archived_at);
  const mergeSel = el('select', { 'aria-label': L('Злити в проєкт', 'Merge into project'), style: { height: '36px' } }, el('option', { value: '' }, L('Злити в…', 'Merge into…')), others.map((x) => el('option', { value: x.id }, x.name)));
  const more = el(
    'details',
    { class: 'card pad' },
    el('summary', { class: 'label', style: { cursor: 'pointer' } }, L('Налаштування проєкту', 'Project settings')),
    el(
      'div',
      { class: 'stack', style: { 'margin-top': '14px', gap: '12px' } },
      renameForm,
      others.length
        ? el(
            'div',
            { class: 'row', style: { gap: '6px' } },
            mergeSel,
            confirmButton(L('Злити', 'Merge'), L('Точно злити?', 'Really merge?'), async () => {
              if (!mergeSel.value) return toast(L('Оберіть проєкт', 'Choose a project'), true);
              const into = mergeSel.value;
              await act(() => api(`/projects/${p.id}/merge`, { body: { into } }), L('Проєкти злито', 'Projects merged'));
              location.hash = `#projects/${encodeURIComponent(into)}`;
            }, 'btn sm'),
          )
        : null,
      el('p', { class: 'hint', style: { margin: '0' } }, L('Злиття переносить записи, задачі й шляхи в інший проєкт, а цей видаляє.', 'Merging moves entries, tasks and paths into the other project and deletes this one.')),
      el('div', {}, el('button', {
        type: 'button',
        class: 'btn sm',
        onclick: () => act(() => api(`/projects/${p.id}`, { method: 'PATCH', body: { archived: !p.archived_at } }), p.archived_at ? L('Повернуто з архіву', 'Restored from archive') : L('В архіві', 'Archived')).then(refresh),
      }, p.archived_at ? L('Повернути з архіву', 'Restore from archive') : L('В архів', 'Archive'))),
    ),
  );

  const mcp = el(
    'div',
    { class: 'card pad hint' },
    el('b', {}, L('Задачі через MCP. ', 'Tasks via MCP. ')),
    L('Скажіть агенту в Claude Code «візьми задачу LIN-42» — він викличе ', 'Tell an agent in Claude Code “take task LIN-42” — it calls '),
    el('code', {}, 'timer_task_start'),
    L(', і час його сесії піде в задачу. Закінчив — ', ', and its session time goes to the task. When done — '),
    el('code', {}, 'timer_task_done'),
    L('. Нові задачі агент додає через ', '. The agent adds new tasks with '),
    el('code', {}, 'timer_task_add'),
    '.',
  );

  return el(
    'div',
    { class: 'detail' },
    title,
    paths,
    stats,
    addForm,
    group(L('В роботі', 'In progress'), doing, null),
    group(L('До роботи', 'To do'), todo, doing.length ? null : L('Відкритих задач немає.', 'No open tasks.')),
    done.length ? group(L('Готово за 7 днів', 'Done in the last 7 days'), done, null) : null,
    mcp,
    more,
  );
}

function taskRow(p, t) {
  const isDone = t.status === 'done';
  const box = el('input', { type: 'checkbox', 'aria-label': isDone ? L(`Повернути «${t.title}» в роботу`, `Reopen “${t.title}”`) : L(`Позначити «${t.title}» виконаною`, `Mark “${t.title}” as done`), checked: isDone });
  box.addEventListener('change', () =>
    act(() => api(`/tasks/${t.id}`, { method: 'PATCH', body: { status: isDone ? 'todo' : 'done' } }), isDone ? L('Повернуто', 'Reopened') : L('Готово', 'Done')).then(refresh, refresh),
  );
  return el(
    'li',
    { class: `task${isDone ? ' done' : ''}` },
    box,
    el(
      'span',
      { class: 't' },
      el('span', { class: 'ttl', title: t.title }, t.external_ref ? el('span', { class: 'mono' }, t.external_ref) : null, t.title),
      t.active_sessions
        ? el('span', { class: 'sub' }, el('span', { class: 'chip', style: { height: '18px', 'margin-top': '3px' } }, dot(p.id, p.color, 'live'), t.active_sessions === 1 ? L('зараз працює', 'working now') : L(`${t.active_sessions} ${plural(t.active_sessions, 'сесія працює', 'сесії працюють', 'сесій працюють')}`, `${t.active_sessions} sessions working`)))
        : t.notes
          ? el('span', { class: 'sub ellipsis' }, t.notes)
          : null,
    ),
    el('span', { class: 'spent', title: L('Усього часу на задачу', 'Total time on the task') }, t.spent_ms ? hm(t.spent_ms) : ''),
    el(
      'span',
      { class: 'acts' },
      !isDone && !p.archived_at
        ? el('button', {
            type: 'button',
            class: 'btn icon ghost play',
            'aria-label': L(`Таймер на «${t.title}»`, `Timer on “${t.title}”`),
            title: L('Ручний таймер на цю задачу', 'Manual timer on this task'),
            onclick: () => act(() => api(`/projects/${p.id}/switch`, { body: { task_id: t.id } }), L('Таймер запущено', 'Timer started')).then(refresh),
          }, icon('play'))
        : null,
      iconConfirm('x', L(`Видалити «${t.title}»`, `Delete “${t.title}”`), () => act(() => api(`/tasks/${t.id}`, { method: 'DELETE' }), L('Задачу видалено', 'Task deleted')).then(refresh)),
    ),
  );
}

// ───────── діалог «+ Таймер»

const dialog = document.getElementById('timer-dialog');
const tform = document.getElementById('timer-form');
const NEW = '__new__';

async function openTimer(projectId) {
  try {
    await loadProjects();
  } catch (e) {
    return toast(e.message, true);
  }
  const sel = tform.elements.project;
  const active = state.projects.filter((p) => !p.archived_at);
  sel.replaceChildren(...active.map((p) => el('option', { value: p.id }, p.name)), el('option', { value: NEW }, L('+ Новий проєкт…', '+ New project…')));
  sel.value = projectId && active.some((p) => p.id === projectId) ? projectId : active[0]?.id ?? NEW;
  tform.elements.note.value = '';
  tform.elements.new_project.value = '';
  await onProjectChange();
  dialog.showModal();
}

async function onProjectChange() {
  const v = tform.elements.project.value;
  tform.querySelector('[data-new-project]').hidden = v !== NEW;
  tform.elements.new_project.required = v === NEW;
  const task = tform.elements.task;
  task.replaceChildren(el('option', { value: '' }, L('— без задачі —', '— no task —')));
  if (v && v !== NEW) {
    const list = await api(`/tasks?project_id=${encodeURIComponent(v)}&status=open`).catch(() => []);
    task.append(...list.map((t) => el('option', { value: t.id }, `${t.external_ref ? `${t.external_ref} ` : ''}${t.title}`)));
  }
}
tform.elements.project.addEventListener('change', onProjectChange);

tform.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = tform.elements;
  try {
    let pid = f.project.value;
    if (pid === NEW) {
      const name = f.new_project.value.trim();
      if (!name) return;
      pid = (await api('/projects', { body: { name } })).id;
    }
    const body = { note: f.note.value.trim() || undefined, task_id: f.task.value || undefined };
    await api(`/projects/${pid}/${f.switch.checked ? 'switch' : 'start'}`, { body });
    dialog.close();
    toast(L('Таймер запущено', 'Timer started'));
    if (route().name === 'now') refresh();
    else location.hash = '#now';
  } catch (e) {
    toast(e.message, true);
  }
});

document.addEventListener('click', (ev) => {
  const a = ev.target.closest('[data-action]');
  if (!a) return;
  if (a.dataset.action === 'new-timer') {
    const r = route();
    openTimer(r.name === 'projects' ? r.arg : undefined);
  }
  if (a.dataset.action === 'close-dialog') dialog.close();
});
dialog.addEventListener('click', (ev) => {
  if (ev.target === dialog) dialog.close();
});

// ───────── акаунт: лендінг, налаштування, підключення

const browserTz = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};
const loginUrl = (provider = 'github') => `/auth/${provider}?tz=${encodeURIComponent(browserTz())}&next=${encodeURIComponent('/' + location.hash)}`;

function setMe(me) {
  state.me = me;
  state.tz = me.user.timezone || state.tz;
  document.body.classList.remove('anon');
  const a = document.querySelector('.me');
  a.hidden = false;
  const img = a.querySelector('img');
  if (img && me.user.avatar_url) img.src = me.user.avatar_url;
  else img?.remove();
  a.querySelector('span').textContent = me.user.login || me.user.name || L('Акаунт', 'Account');
}

function showLanding() {
  if (document.body.classList.contains('anon')) return;
  state.me = null;
  clearInterval(pollTimer);
  document.body.classList.add('anon');
  document.title = L('Timer — трекер часу AI-агентів', 'Timer — time tracking for AI agents');
  const loginButtons = el('div', { class: 'row wrap' }, el('a', { class: 'btn primary lg', href: loginUrl('github') }, githubIcon(), L('Увійти через GitHub', 'Sign in with GitHub')));
  // Google — лише якщо налаштований на сервері.
  fetch('/auth/providers')
    .then((r) => (r.ok ? r.json() : null))
    .then((p) => {
      if (p?.google) loginButtons.append(el('a', { class: 'btn lg', href: loginUrl('google') }, googleIcon(), L('Увійти через Google', 'Sign in with Google')));
    })
    .catch(() => {});
  view.replaceChildren(
    el(
      'div',
      { class: 'landing' },
      el('h1', {}, L('Скільки насправді працюють ваші AI-агенти?', 'How much do your AI agents really work?')),
      el(
        'p',
        { class: 'lead' },
        L(
          'Кілька Claude Code у різних репозиторіях одночасно. Timer сам рахує час кожного агента, показує, хто чекає на вашу відповідь, і чесно ділить паралельні години між проєктами.',
          'Several Claude Code sessions in different repositories at once. Timer tracks each agent’s time on its own, shows who is waiting for your reply, and fairly splits parallel hours between projects.',
        ),
      ),
      loginButtons,
      el('img', { class: 'shot', src: '/screenshot.png', alt: L('Екран «Зараз»: агенти, що чекають і працюють, шкала дня', 'The Now screen: agents waiting and working, the day timeline'), loading: 'lazy' }),
      el(
        'ul',
        { class: 'features' },
        el('li', {}, el('b', {}, L('Без кнопок. ', 'No buttons. ')), L('Хуки Claude Code вмикають облік на промпті й вимикають, коли агент закінчив.', 'Claude Code hooks start tracking on a prompt and stop it when the agent finishes.')),
        el('li', {}, el('b', {}, L('Задачі через MCP. ', 'Tasks via MCP. ')), L('«Візьми LIN-42» — і час сесії йде в задачу. Працює в Claude Code, claude.ai і Claude Desktop.', '“Take LIN-42” — and the session time goes to the task. Works in Claude Code, claude.ai and Claude Desktop.')),
        el('li', {}, el('b', {}, L('Чекають на вас. ', 'Waiting for you. ')), L('Видно, який агент простоює через вас і скільки хвилин.', 'See which agent is idle waiting on you, and for how many minutes.')),
        el('li', {}, el('b', {}, L('Ваші дані — лише ваші. ', 'Your data is yours. ')), L('Інші користувачі їх не бачать; промпти не зберігаються, доки ви самі не ввімкнете.', 'Other users can’t see it; prompts aren’t stored unless you turn that on.')),
      ),
      el(
        'p',
        { class: 'hint' },
        L('Відкритий код: ', 'Open source: '),
        el('a', { href: 'https://github.com/kopachevvadym/timer', rel: 'noopener' }, 'github.com/kopachevvadym/timer'),
        ' · ',
        el('a', { href: L('/privacy', '/privacy-en') }, L('Політика конфіденційності', 'Privacy policy')),
        ' · ',
        el('a', { href: L('/terms', '/terms-en') }, L('Умови використання', 'Terms of use')),
        ' · ',
        langSwitch(),
      ),
    ),
  );
}

// Перемикач мови для лендінгу: показує іншу мову, натискання перезавантажує сторінку.
function langSwitch() {
  return el('button', { type: 'button', class: 'linklike', lang: L('en', 'uk'), onclick: () => setLang(L('en', 'uk')) }, L('English', 'Українська'));
}

function googleIcon() {
  const t = document.createElement('template');
  t.innerHTML =
    '<svg viewBox="0 0 18 18" width="16" height="16" aria-hidden="true"><path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z"/><path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.83.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z"/><path fill="#FBBC05" d="M3.97 10.72A5.4 5.4 0 0 1 3.68 9c0-.6.1-1.18.29-1.72V4.95H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.05l3.01-2.33z"/><path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"/></svg>';
  return t.content.firstChild;
}

function githubIcon() {
  const t = document.createElement('template');
  t.innerHTML =
    '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>';
  return t.content.firstChild;
}

// resolve(): справжній текст для буфера (напр. команда зі щойно створеним ключем); без нього копіюється text.
function codeBlock(text, label, resolve) {
  const pre = el('code', {}, text);
  return el(
    'div',
    { class: 'code' },
    pre,
    el(
      'button',
      {
        type: 'button',
        class: 'btn sm',
        'aria-label': `${L('Скопіювати', 'Copy')}: ${label}`,
        onclick: async (ev) => {
          const btn = ev.currentTarget;
          const value = resolve ? resolve() : Promise.resolve(text);
          try {
            // ClipboardItem з промісом зберігає «жест користувача» поки чекаємо на сервер (Safari інакше відмовляє).
            if (resolve && window.ClipboardItem && navigator.clipboard?.write) {
              await navigator.clipboard.write([new ClipboardItem({ 'text/plain': value.then((t) => new Blob([t], { type: 'text/plain' })) })]);
            } else {
              await navigator.clipboard.writeText(await value);
            }
            btn.textContent = L('Скопійовано', 'Copied');
            if (resolve) toast(L('Скопійовано з ключем — виконайте в терміналі', 'Copied with the key — run it in your terminal'));
          } catch {
            if (resolve) {
              const t = await value.catch(() => null);
              if (!t) return;
              pre.textContent = t;
            }
            const r = document.createRange();
            r.selectNodeContents(pre);
            getSelection().removeAllRanges();
            getSelection().addRange(r);
          }
        },
      },
      L('Копіювати', 'Copy'),
    ),
  );
}

async function viewSettings() {
  const me = await api('/me');
  setMe(me);
  const base = location.origin;
  // MCP входить через GitHub (OAuth) — ключ йому не потрібен. Ключ «лише хуки» лежить у env агента
  // і відкриває тільки /hooks. Повний ключ — для MCP-клієнтів без OAuth (розділ «Інші клієнти»).
  const fresh = !!state.newKey?.hooks;
  const hooksKey = state.newKey?.hooks ?? L('tk_КЛЮЧ', 'tk_KEY');
  const setupCmd = (key) => `curl -fsSL ${base}/install-hooks.mjs | node --input-type=module - ${base} ${key}`;
  const headerCmd = (key) => `claude mcp add --transport http timer --scope user ${base}/mcp --header "Authorization: Bearer ${key}"`;

  const keyList = me.keys.length
    ? el(
        'ul',
        { class: 'list card' },
        me.keys.map((k) =>
          el(
            'li',
            { class: 'sess', style: { padding: '12px 20px' } },
            el(
              'span',
              { class: 'body' },
              el(
                'span',
                { class: 'name', style: { 'font-weight': '500' } },
                k.name,
                ' ',
                el('span', { class: 'badge' }, k.scope === 'hooks' ? L('лише хуки', 'hooks only') : L('повний', 'full')),
                ' ',
                el('span', { class: 'mono muted' }, `${k.prefix}…`),
              ),
              el(
                'span',
                { class: 'sub' },
                L(`створено ${dayTitle(k.created_at)}`, `created ${dayTitle(k.created_at)}`),
                k.last_used_at ? L(` · востаннє ${dayTitle(k.last_used_at)}, ${timeOf(k.last_used_at)}`, ` · last used ${dayTitle(k.last_used_at)}, ${timeOf(k.last_used_at)}`) : L(' · ще не використовувався', ' · never used'),
              ),
            ),
            confirmButton(L('Відкликати', 'Revoke'), L('Точно відкликати?', 'Really revoke?'), () =>
              act(() => api(`/keys/${k.id}`, { method: 'DELETE' }), L('Ключ відкликано', 'Key revoked')).then(() => {
                state.newKey = null;
                render();
              }),
            ),
          ),
        ),
      )
    : el('div', { class: 'card empty' }, L('Ключів ще немає — «Копіювати» в кроці 2 створить ключ сам.', 'No keys yet — “Copy” in step 2 creates one for you.'));

  const keyName = el('input', { placeholder: L('напр. MacBook', 'e.g. MacBook'), 'aria-label': L('Назва комп’ютера', 'Computer name'), autocomplete: 'off', style: { 'max-width': '260px' } });
  // Сервер зберігає лише хеш ключа, тож показати старий ключ неможливо: «Копіювати» створює новий
  // (один на відвідування сторінки) і підставляє його в команду.
  let pending = null;
  const ensureHooksKey = () => {
    if (state.newKey?.hooks) return Promise.resolve(state.newKey.hooks);
    pending ??= act(() => api('/keys', { body: { name: keyName.value.trim() || 'Claude Code', scope: 'hooks' } }))
      .then((k) => {
        state.newKey = { ...state.newKey, hooks: k.key };
        setTimeout(render, 0); // показати підставлений ключ і попередження
        return k.key;
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  };
  const fullKeyOut = el('div', { class: 'stack', style: { gap: '8px' } });
  if (state.newKey?.full) fullKeyOut.append(codeBlock(headerCmd(state.newKey.full), L('команду MCP з ключем', 'the MCP command with the key')));
  const fullKeyBtn = el(
    'button',
    {
      type: 'button',
      class: 'btn sm',
      onclick: async () => {
        const k = await act(() => api('/keys', { body: { name: `${keyName.value.trim() || L('Клієнт без OAuth', 'Client without OAuth')} · MCP`, scope: 'full' } }));
        state.newKey = { ...state.newKey, full: k.key };
        fullKeyOut.replaceChildren(
          el('p', { class: 'hint warn-box', style: { margin: '0' } }, L('Повний ключ відкриває всі ваші дані. Скопіюйте зараз — потім його не буде видно.', 'A full key opens all your data. Copy it now — it won’t be shown again.')),
          codeBlock(headerCmd(k.key), L('команду MCP з ключем', 'the MCP command with the key')),
        );
      },
    },
    L('Створити повний ключ', 'Create a full key'),
  );

  const tzInput = el('input', { value: me.user.timezone, list: 'tz-list', 'aria-label': L('Часовий пояс', 'Time zone'), autocomplete: 'off', style: { 'max-width': '260px' } });
  let zones = [];
  try {
    zones = Intl.supportedValuesOf('timeZone');
  } catch {}
  const noteBox = el('input', { type: 'checkbox', checked: me.user.note_from_prompt });
  const prefs = el(
    'form',
    { class: 'card pad stack' },
    el('div', { class: 'field' }, L('Мова інтерфейсу', 'Interface language'), el('div', {}, seg([['uk', 'Українська'], ['en', 'English']], LANG, (v) => v !== LANG && setLang(v), L('Мова інтерфейсу', 'Interface language')))),
    el('label', { class: 'field' }, L('Часовий пояс (межі днів у звітах)', 'Time zone (day boundaries in reports)'), tzInput, el('datalist', { id: 'tz-list' }, zones.map((z) => el('option', { value: z })))),
    el('label', { class: 'check' }, noteBox, L('Зберігати початок промпту як нотатку запису (до 140 символів)', 'Save the start of the prompt as the entry note (up to 140 characters)')),
    el('p', { class: 'hint', style: { margin: '0' } }, L('Промпти можуть містити приватне; без цієї галочки трекер бачить лише назви папок і задач.', 'Prompts can contain private things; without this box the tracker sees only folder and task names.')),
    el('div', {}, el('button', { type: 'submit', class: 'btn sm' }, L('Зберегти', 'Save'))),
  );
  prefs.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    await act(() => api('/me', { method: 'PATCH', body: { timezone: tzInput.value.trim(), note_from_prompt: noteBox.checked } }), L('Збережено', 'Saved'));
    fmtCache.clear();
    render();
  });

  const confirmWord = me.user.login ?? me.logins?.google?.email ?? '';
  const confirmInput = el('input', { placeholder: confirmWord, 'aria-label': L('Логін GitHub або пошта Google для підтвердження', 'GitHub login or Google email to confirm'), autocomplete: 'off', style: { 'max-width': '260px' } });
  const danger = el(
    'form',
    { class: 'card pad stack' },
    el('p', { class: 'hint', style: { margin: '0' } }, L(`Видалити акаунт разом з усіма проєктами, задачами, записами й ключами. Цього не скасувати. Для підтвердження введіть ${me.user.login ? 'свій логін GitHub' : 'свою пошту Google'}.`, `Delete the account with all projects, tasks, entries and keys. This can’t be undone. To confirm, type ${me.user.login ? 'your GitHub login' : 'your Google email'}.`)),
    el('div', { class: 'row wrap', style: { gap: '8px' } }, confirmInput, el('button', { type: 'submit', class: 'btn sm danger' }, L('Видалити акаунт', 'Delete account'))),
  );
  danger.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    await act(() => api('/me', { method: 'DELETE', body: { confirm: confirmInput.value.trim() } }));
    location.href = '/';
  });

  // Способи входу: GitHub і Google, прив'язати другий або відв'язати (останній — не можна).
  const lg = me.logins ?? { github: { login: me.user.login }, google: null, available: { github: true, google: false } };
  const linked = (lg.github ? 1 : 0) + (lg.google ? 1 : 0);
  const loginRow = (provider, iconEl, title, info) =>
    el(
      'li',
      { class: 'sess', style: { padding: '12px 20px' } },
      iconEl,
      el('span', { class: 'body' }, el('span', { class: 'name', style: { 'font-weight': '500' } }, title), el('span', { class: 'sub' }, info ?? L('не прив’язано', 'not linked'))),
      info
        ? linked > 1
          ? confirmButton(L('Відв’язати', 'Unlink'), L('Точно відв’язати?', 'Really unlink?'), () =>
              act(() => api('/me/unlink', { body: { provider } }), L('Відв’язано', 'Unlinked')).then(() => render()),
            )
          : el('span', { class: 'hint', title: L('Спершу прив’яжіть інший спосіб входу', 'Link another sign-in method first') }, L('єдиний спосіб входу', 'only sign-in method'))
        : lg.available[provider]
          ? el('a', { class: 'btn sm', href: `/auth/${provider}?link=1&next=${encodeURIComponent('/#settings')}` }, L('Прив’язати', 'Link'))
          : el('span', { class: 'hint' }, L('не налаштовано на сервері', 'not configured on the server')),
    );
  const loginsList = el(
    'ul',
    { class: 'list card' },
    loginRow('github', githubIcon(), 'GitHub', lg.github ? `@${lg.github.login}` : null),
    loginRow('google', googleIcon(), 'Google', lg.google ? (lg.google.email ?? L('прив’язано', 'linked')) : null),
  );

  const step = (n, title, ...body) =>
    el('li', { class: 'step' }, el('span', { class: 'num mono' }, String(n)), el('div', { class: 'stack', style: { gap: '8px', 'min-width': '0' } }, el('b', {}, title), ...body));

  return el(
    'div',
    { class: 'stack', style: { gap: '28px' } },
    el(
      'section',
      { class: 'section' },
      el('h1', { class: 'label' }, L('Акаунт', 'Account')),
      el(
        'div',
        { class: 'card pad row between wrap' },
        el(
          'div',
          { class: 'row' },
          me.user.avatar_url ? el('img', { src: me.user.avatar_url, alt: '', width: 40, height: 40, class: 'avatar' }) : null,
          el('div', { class: 'stack', style: { gap: '0' } }, el('b', {}, me.user.name || me.user.login || L('Ви', 'You')), el('span', { class: 'muted' }, me.user.login ? `@${me.user.login}` : (me.logins?.google?.email ?? ''))),
        ),
        el(
          'button',
          {
            type: 'button',
            class: 'btn sm',
            onclick: async () => {
              await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' });
              location.href = '/';
            },
          },
          L('Вийти', 'Sign out'),
        ),
      ),
    ),
    el('section', { class: 'section' }, el('h2', { class: 'label' }, L('Способи входу', 'Sign-in methods')), loginsList),
    el(
      'section',
      { class: 'section' },
      el('h2', { class: 'label' }, L('Підключення Claude', 'Connect Claude')),
      el(
        'ol',
        { class: 'steps card pad' },
        step(
          1,
          L('claude.ai і Claude Desktop', 'claude.ai and Claude Desktop'),
          el('p', { class: 'hint', style: { margin: '0' } }, L('Settings → Connectors → Add custom connector, адреса нижче. Далі — вхід через GitHub.', 'Settings → Connectors → Add custom connector, with the URL below. Then sign in with GitHub.')),
          codeBlock(`${base}/mcp`, L('адресу MCP', 'the MCP URL')),
        ),
        step(
          2,
          L('Claude Code — одна команда', 'Claude Code — one command'),
          el(
            'p',
            { class: 'hint', style: { margin: '0' } },
            L('Ставить хуки (час рахується сам) і MCP-сервер timer. «Копіювати» одразу підставить новий ключ для хуків.', 'Installs the hooks (time is tracked automatically) and the timer MCP server. “Copy” inserts a new hooks key right away.'),
          ),
          fresh ? null : el('label', { class: 'field', style: { 'max-width': '260px' } }, L('Назва цього комп’ютера (для списку ключів)', 'This computer’s name (for the key list)'), keyName),
          codeBlock(setupCmd(hooksKey), L('команду підключення Claude Code', 'the Claude Code setup command'), fresh ? null : () => ensureHooksKey().then(setupCmd)),
          fresh ? el('p', { class: 'hint warn-box', style: { margin: '0' } }, L('Ключ уже в команді. Виконайте її зараз — після переходу на іншу сторінку ключа не буде видно.', 'The key is already in the command. Run it now — after you leave this page the key won’t be shown.')) : null,
          el('p', { class: 'hint', style: { margin: '0' } }, L('Потім перезапустіть Claude Code і введіть /mcp → timer → Authenticate — один раз увійти через GitHub.', 'Then restart Claude Code and run /mcp → timer → Authenticate to sign in with GitHub once.')),
        ),
      ),
    ),
    el(
      'section',
      { class: 'section' },
      el('h2', { class: 'label' }, L('Ключі', 'Keys')),
      el('p', { class: 'hint', style: { margin: '0' } }, L('Ключ «лише хуки» не відкриває ні даних, ні MCP. Непотрібні — відкликайте.', 'A “hooks only” key opens neither your data nor MCP. Revoke the ones you don’t need.')),
      keyList,
      el(
        'details',
        { class: 'card pad' },
        el('summary', {}, L('Інші клієнти: MCP без входу через браузер', 'Other clients: MCP without browser sign-in')),
        el(
          'div',
          { class: 'stack', style: { gap: '8px', 'margin-top': '12px' } },
          el('p', { class: 'hint', style: { margin: '0' } }, L('Для клієнта, що не вміє OAuth, або сервера без браузера: повний ключ у заголовку Authorization.', 'For a client without OAuth support or a headless server: a full key in the Authorization header.')),
          el('div', {}, fullKeyBtn),
          fullKeyOut,
        ),
      ),
    ),
    el('section', { class: 'section' }, el('h2', { class: 'label' }, L('Налаштування', 'Preferences')), prefs),
    el('section', { class: 'section' }, el('h2', { class: 'label' }, L('Небезпечна зона', 'Danger zone')), danger),
  );
}

// ───────── старт

const VIEWS = { now: viewNow, reports: viewReports, entries: viewEntries, projects: viewProjects, settings: viewSettings };
window.addEventListener('hashchange', () => {
  // Свіжий ключ показуємо лише поки ви на сторінці налаштувань.
  if (route().name !== 'settings') state.newKey = null;
  render();
  view.focus({ preventScroll: true });
  window.scrollTo(0, 0);
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && route().name === 'now') refresh();
});
// Хто увійшов: без сесії — лендінг із входом через GitHub.
api('/me')
  .then((me) => {
    setMe(me);
    // Новий користувач без жодного ключа — одразу на сторінку підключення.
    if (!me.keys.length && !location.hash) location.hash = '#settings';
    render();
    if (!['now', 'projects'].includes(route().name)) api('/now').then((x) => setRunning(x.running.length), () => {});
  })
  .catch((e) => {
    if (!(e instanceof AuthError)) view.replaceChildren(el('div', { class: 'card empty' }, e.message));
  });
