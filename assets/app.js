// Manga Tracker front end.
// Reads series.json / progress.json / data.json from the GitHub repo and writes
// series.json and progress.json back through the GitHub contents API.

const WORKFLOW_FILE = 'check.yml';
const AUTO_RELOAD_MS = 5 * 60 * 1000;
const ALLOWED_HOST = /(^|\.)manga-za+\.(net|com)$/i;

const $ = (sel) => document.querySelector(sel);
const els = {
  grid: $('#grid'), empty: $('#empty'), banner: $('#banner'), toast: $('#toast'),
  lastCheck: $('#last-check'), refresh: $('#btn-refresh'),
  addForm: $('#add-form'), addUrl: $('#add-url'), addError: $('#add-error'),
  statTotal: $('#stat-total'), statNew: $('#stat-new'), statUnread: $('#stat-unread'),
  search: $('#search'), sort: $('#sort'),
  settings: $('#settings'), settingsForm: $('#settings-form'), settingsError: $('#settings-error'),
  progressDialog: $('#progress-dialog'), progressForm: $('#progress-form'), progressError: $('#progress-error'),
};

// ---------- small utils ----------

const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
  },
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtNum = (n) => (Number.isInteger(n) ? String(n) : String(+n.toFixed(2)));
const urlKey = (u) => { try { return decodeURIComponent(u).toLowerCase().replace(/\/+$/, ''); } catch { return u.toLowerCase(); } };

function relTime(value) {
  if (!value) return '';
  const now = new Date();
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split('-').map(Number);
    const days = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()) - new Date(y, m - 1, d)) / 86400000);
    if (days <= 0) return 'วันนี้';
    if (days === 1) return 'เมื่อวาน';
    if (days < 30) return `${days} วันที่แล้ว`;
    return new Date(y, m - 1, d).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: '2-digit' });
  }
  const t = new Date(value);
  const mins = Math.round((now - t) / 60000);
  if (mins < 1) return 'เมื่อสักครู่';
  if (mins < 60) return `${mins} นาทีที่แล้ว`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} ชม.ที่แล้ว`;
  const days = Math.round(hrs / 24);
  if (days === 1) return 'เมื่อวาน';
  if (days < 30) return `${days} วันที่แล้ว`;
  return t.toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: '2-digit' });
}

const toSortable = (value) => (value ? new Date(value.length === 10 ? `${value}T00:00:00` : value).getTime() : 0);

let toastTimer;
function toast(msg, ms = 3200) {
  els.toast.textContent = msg;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, ms);
}

// ---------- config ----------

function detectRepo() {
  const host = location.hostname;
  if (!host.endsWith('.github.io')) return {};
  const owner = host.replace(/\.github\.io$/, '');
  const first = location.pathname.split('/').filter(Boolean)[0];
  return { owner, repo: first || host };
}

let config = { branch: 'main', ...detectRepo(), ...store.get('mt-config', {}) };
const repoReady = () => Boolean(config.owner && config.repo);
const canWrite = () => repoReady() && Boolean(config.token);

// ---------- GitHub API ----------

async function gh(path, { method = 'GET', body, accept = 'application/vnd.github+json', auth = true } = {}) {
  const headers = { Accept: accept, 'X-GitHub-Api-Version': '2022-11-28' };
  if (auth && config.token) headers.Authorization = `Bearer ${config.token}`;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`https://api.github.com${path}`, { method, headers, body: body && JSON.stringify(body), cache: 'no-store' });
  if (!res.ok) {
    const err = new Error(`GitHub ${res.status}`);
    err.status = res.status;
    try { err.detail = (await res.json()).message; } catch { /* not json */ }
    throw err;
  }
  return res;
}

const repoPath = (p = '') => `/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}${p}`;

function b64ToUtf8(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}
function utf8ToB64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function getFileWithSha(path) {
  try {
    const res = await gh(repoPath(`/contents/${path}?ref=${encodeURIComponent(config.branch || 'main')}`));
    const json = await res.json();
    return { sha: json.sha, value: JSON.parse(b64ToUtf8(json.content)) };
  } catch (err) {
    if (err.status === 404) return { sha: undefined, value: null };
    throw err;
  }
}

// Reads the latest copy from GitHub, applies fn, and writes it back; retries if
// someone else (the scheduled job, another device) committed in between.
async function mutateFile(path, fn, message) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { sha, value } = await getFileWithSha(path);
    const next = fn(value);
    try {
      await gh(repoPath(`/contents/${path}`), {
        method: 'PUT',
        body: { message, content: utf8ToB64(JSON.stringify(next, null, 1) + '\n'), sha, branch: config.branch || 'main' },
      });
      return next;
    } catch (err) {
      if ((err.status === 409 || err.status === 422) && attempt < 2) continue;
      throw err;
    }
  }
}

async function readJsonFile(path) {
  if (repoReady()) {
    try {
      const res = await gh(repoPath(`/contents/${path}?ref=${encodeURIComponent(config.branch || 'main')}`), { accept: 'application/vnd.github.raw+json' });
      return await res.json();
    } catch (err) {
      if (err.status === 404) return null;
      if (err.status === 401) throw new Error('token ไม่ถูกต้องหรือหมดอายุ');
      // Fall through to the copy deployed next to this page.
    }
  }
  const res = await fetch(`./${path}`, { cache: 'no-store' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

// ---------- state ----------

const state = {
  series: [],      // [{ url, addedAt }]
  progress: {},    // { url: lastReadChapterNumber }
  data: {},        // { url: { seriesUrl, title, cover, chapters, error, ... } }
  loaded: false,
  loading: false,
  lastLoad: 0,
  filter: store.get('mt-filter', 'all'),
  sort: store.get('mt-sort', 'updated'),
  query: '',
  openMenu: null,
};

function derive(item) {
  const d = state.data[item.url];
  const chapters = d?.chapters || [];
  const latest = chapters[0];
  const read = state.progress[item.url] ?? 0;
  const unread = chapters.filter((c) => c.num > read);
  const next = unread[unread.length - 1];
  const status = chapters.length ? 'ok' : d?.error ? 'error' : 'pending';
  return {
    ...item,
    d, chapters, latest, read, unread, next, status,
    title: d?.title || urlKey(item.url).replace(/^https?:\/\/[^/]+\//, ''),
    updated: latest?.firstSeen || latest?.date || d?.lastChange || item.addedAt,
  };
}

// ---------- loading ----------

async function load({ quiet = false } = {}) {
  if (state.loading) return;
  state.loading = true;
  els.refresh.classList.add('spin');
  try {
    const [series, progress, data] = await Promise.all([
      readJsonFile('series.json'), readJsonFile('progress.json'), readJsonFile('data.json'),
    ]);
    state.series = series?.series || [];
    state.progress = progress || {};
    state.data = data?.series || {};
    state.loaded = true;
    state.lastLoad = Date.now();
    renderBanner();
    render();
    loadLastRun();
  } catch (err) {
    renderBanner(`โหลดข้อมูลไม่สำเร็จ: ${err.message}`);
    if (!state.loaded) render();
    if (!quiet) toast('โหลดข้อมูลไม่สำเร็จ');
  } finally {
    state.loading = false;
    els.refresh.classList.remove('spin');
  }
}

async function loadLastRun() {
  if (!repoReady()) { els.lastCheck.textContent = ''; return; }
  try {
    const res = await gh(repoPath(`/actions/workflows/${WORKFLOW_FILE}/runs?per_page=1`));
    const run = (await res.json()).workflow_runs?.[0];
    if (!run) { els.lastCheck.textContent = 'ยังไม่เคยเช็ค'; return; }
    if (run.status !== 'completed') { els.lastCheck.textContent = 'กำลังเช็คตอนใหม่…'; return; }
    els.lastCheck.textContent = `เช็คล่าสุด ${relTime(run.updated_at)}${run.conclusion === 'success' ? '' : ' (ล้มเหลว)'}`;
  } catch {
    els.lastCheck.textContent = '';
  }
}

// ---------- rendering ----------

function renderBanner(error) {
  const b = els.banner;
  if (error) {
    b.innerHTML = `<span>${esc(error)}</span><button class="btn" data-act="settings">ตั้งค่า</button>`;
  } else if (!repoReady()) {
    b.innerHTML = '<span>ยังไม่ได้เชื่อม GitHub repo ตอนนี้เปิดดูได้อย่างเดียว</span><button class="btn" data-act="settings">เชื่อม GitHub</button>';
  } else if (!config.token) {
    b.innerHTML = '<span>โหมดอ่านอย่างเดียว ใส่ token เพื่อเพิ่มเรื่องและบันทึกตอนที่อ่าน</span><button class="btn" data-act="settings">ใส่ token</button>';
  } else {
    b.hidden = true;
    return;
  }
  b.hidden = false;
}

function cardHtml(x) {
  const cover = x.d?.cover
    ? `<img src="${esc(x.d.cover)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">`
    : '';
  const initial = esc((x.title.match(/[\p{L}\p{N}]/u) || ['?'])[0].toUpperCase());

  let badge = '';
  let meta = '';
  let actions = '';
  const seriesLink = x.d?.seriesUrl || x.url;

  if (x.status === 'pending') {
    badge = '<span class="badge pending">รอดึงข้อมูล</span>';
    meta = '<div class="meta">ระบบจะดึงข้อมูลภายในไม่กี่นาที</div>';
    actions = `<a class="btn sm" href="${esc(x.url)}" target="_blank" rel="noopener">เปิดลิงก์</a>`;
  } else if (x.status === 'error') {
    badge = '<span class="badge err">ดึงข้อมูลไม่ได้</span>';
    meta = `<div class="meta err">${esc(x.d.error)}</div>`;
    actions = `<a class="btn sm" href="${esc(x.url)}" target="_blank" rel="noopener">เปิดลิงก์</a>`;
  } else {
    const n = x.unread.length;
    badge = n ? `<span class="badge">+${n} ตอนใหม่</span>` : '';
    meta = `<div class="meta">ล่าสุด ${esc(x.latest.name)}${x.updated ? ` · ${esc(relTime(x.updated))}` : ''}</div>`;
    if (n) {
      meta += `<div class="meta">${x.read ? `อ่านถึง ตอนที่ ${fmtNum(x.read)}` : 'ยังไม่เริ่มอ่าน'}</div>`;
      actions = `
        <a class="btn sm read-next" href="${esc(x.next.url)}" target="_blank" rel="noopener" data-act="read" data-num="${x.next.num}">อ่านต่อ ตอน ${fmtNum(x.next.num)}</a>
        <button class="btn sm square" data-act="caught-up" title="อ่านทันแล้ว" aria-label="ทำเครื่องหมายว่าอ่านทันแล้ว">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12l5 5L20 7"/></svg>
        </button>`;
    } else {
      meta += '<div class="meta ok">✓ อ่านทันแล้ว</div>';
      actions = `<a class="btn sm" href="${esc(x.latest.url)}" target="_blank" rel="noopener">เปิดตอนล่าสุด</a>`;
    }
    if (x.d.error) meta += '<div class="meta err">เช็ครอบล่าสุดไม่สำเร็จ</div>';
  }

  const menuOpen = state.openMenu === x.url;
  const menu = menuOpen ? `
    <div class="menu" role="menu">
      ${x.status === 'ok' ? '<button data-act="set-progress" role="menuitem">ตั้งตอนที่อ่านถึง…</button>' : ''}
      <a href="${esc(seriesLink)}" target="_blank" rel="noopener" role="menuitem">เปิดหน้าเรื่อง</a>
      <button data-act="remove" class="danger" role="menuitem">ลบออกจากรายการ</button>
    </div>` : '';

  return `
    <article class="card${x.unread.length ? ' has-new' : ''}" data-url="${esc(x.url)}">
      <a class="cover" href="${esc(seriesLink)}" target="_blank" rel="noopener" tabindex="-1" aria-hidden="true">
        <span class="fallback">${initial}</span>${cover}${badge}
      </a>
      <button class="menu-btn" data-act="menu" aria-label="ตัวเลือกเพิ่มเติม" aria-expanded="${menuOpen}">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg>
      </button>
      ${menu}
      <div class="card-body">
        <a class="title" href="${esc(seriesLink)}" target="_blank" rel="noopener" title="${esc(x.title)}">${esc(x.title)}</a>
        ${meta}
        <div class="card-actions">${actions}</div>
      </div>
    </article>`;
}

function render() {
  if (!state.loaded) {
    els.grid.innerHTML = Array.from({ length: 4 }, () =>
      '<article class="card skeleton"><div class="cover"></div><div class="card-body"><div class="line"></div><div class="line" style="width:60%"></div></div></article>').join('');
    return;
  }

  const all = state.series.map(derive);
  const withNew = all.filter((x) => x.unread.length);
  const caught = all.filter((x) => x.status === 'ok' && !x.unread.length);
  els.statTotal.textContent = all.length;
  els.statNew.textContent = withNew.length;
  els.statUnread.textContent = withNew.reduce((s, x) => s + x.unread.length, 0);

  document.querySelectorAll('.chip').forEach((chip) => {
    const f = chip.dataset.filter;
    const count = f === 'all' ? all.length : f === 'new' ? withNew.length : caught.length;
    chip.classList.toggle('on', f === state.filter);
    chip.innerHTML = `${esc(chip.textContent.replace(/\s*\d+$/, ''))}<span class="count">${count}</span>`;
  });

  let list = state.filter === 'new' ? withNew : state.filter === 'caught' ? caught : all;
  const q = state.query.trim().toLowerCase();
  if (q) list = list.filter((x) => x.title.toLowerCase().includes(q));

  const byUpdated = (a, b) => toSortable(b.updated) - toSortable(a.updated);
  const sorters = {
    updated: (a, b) => (b.unread.length > 0) - (a.unread.length > 0) || byUpdated(a, b),
    unread: (a, b) => b.unread.length - a.unread.length || byUpdated(a, b),
    name: (a, b) => a.title.localeCompare(b.title, 'th'),
    added: (a, b) => toSortable(b.addedAt) - toSortable(a.addedAt),
  };
  list = [...list].sort(sorters[state.sort] || sorters.updated);

  els.grid.innerHTML = list.map(cardHtml).join('');

  if (!all.length) {
    els.empty.innerHTML = '<h3>เริ่มติดตามการ์ตูนเรื่องแรก</h3><p>วางลิงก์ manga-zaa ตอนไหนก็ได้ในช่องด้านบน แล้วกด "เพิ่มเรื่อง"</p>';
    els.empty.hidden = false;
  } else if (!list.length) {
    els.empty.innerHTML = state.filter === 'new' && !q
      ? '<h3>อ่านทันทุกเรื่องแล้ว</h3><p>ตอนใหม่จะขึ้นที่นี่เมื่อระบบเจอ</p>'
      : '<h3>ไม่พบเรื่องที่ตรงกัน</h3><p>ลองเปลี่ยนคำค้นหาหรือตัวกรอง</p>';
    els.empty.hidden = false;
  } else {
    els.empty.hidden = true;
  }
}

// ---------- actions ----------

function requireWrite() {
  if (canWrite()) return true;
  toast('ต้องใส่ GitHub token ก่อนถึงจะบันทึกได้');
  openSettings();
  return false;
}

async function setProgress(url, num, { silent = false } = {}) {
  if (!requireWrite()) return;
  const before = state.progress[url];
  state.progress = { ...state.progress, [url]: num };
  render();
  try {
    state.progress = await mutateFile('progress.json', (p) => ({ ...(p || {}), [url]: num }), `Read ${fmtNum(num)}`);
    render();
    if (!silent) toast(`บันทึกแล้ว: อ่านถึงตอนที่ ${fmtNum(num)}`);
  } catch (err) {
    state.progress = { ...state.progress, [url]: before };
    render();
    toast(`บันทึกไม่สำเร็จ (${err.detail || err.message})`);
  }
}

function chapterFromUrl(url) {
  const u = new URL(url);
  if (/\/manga\//.test(u.pathname)) return null;
  const slug = decodeURIComponent(u.pathname).replace(/\/+$/, '');
  const m = slug.match(/-(\d+(?:\.\d+)?)$/);
  return m ? Number(m[1]) : null;
}

async function addSeries(raw) {
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    return showAddError('ลิงก์ไม่ถูกต้อง ลองคัดลอกจากแถบที่อยู่ของเบราว์เซอร์อีกครั้ง');
  }
  if (!ALLOWED_HOST.test(url.hostname)) return showAddError('ตอนนี้รองรับเฉพาะลิงก์จาก manga-zaa.net');
  url.hash = '';
  url.search = '';
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  const href = url.href;

  const key = urlKey(href);
  const dup = state.series.find((s) => urlKey(s.url) === key || urlKey(state.data[s.url]?.seriesUrl || '') === key);
  if (dup) return showAddError('เรื่องนี้อยู่ในรายการแล้ว');
  if (!requireWrite()) return;

  const btn = els.addForm.querySelector('button');
  btn.setAttribute('aria-busy', 'true');
  try {
    const chapter = chapterFromUrl(href);
    if (chapter != null) {
      state.progress = await mutateFile('progress.json', (p) => ({ ...(p || {}), [href]: chapter }), `Set progress for new series`);
    }
    const entry = { url: href, addedAt: new Date().toISOString() };
    const saved = await mutateFile('series.json', (s) => {
      const list = s?.series || [];
      return { series: list.some((x) => urlKey(x.url) === key) ? list : [...list, entry] };
    }, 'Add series');
    state.series = saved.series;
    els.addUrl.value = '';
    render();
    toast('เพิ่มแล้ว ระบบจะดึงข้อมูลภายใน 1–2 นาที', 4500);
    // The push to series.json triggers the workflow; pick up its result.
    setTimeout(() => load({ quiet: true }), 75000);
    setTimeout(() => load({ quiet: true }), 150000);
  } catch (err) {
    showAddError(`เพิ่มไม่สำเร็จ (${err.detail || err.message})`);
  } finally {
    btn.removeAttribute('aria-busy');
  }
}

function showAddError(msg) {
  els.addError.textContent = msg;
  els.addError.hidden = false;
}

async function removeSeries(url) {
  const x = state.series.find((s) => s.url === url);
  if (!x || !requireWrite()) return;
  const title = state.data[url]?.title || 'เรื่องนี้';
  if (!confirm(`ลบ "${title}" ออกจากรายการ?`)) return;
  try {
    const saved = await mutateFile('series.json', (s) => ({ series: (s?.series || []).filter((i) => i.url !== url) }), 'Remove series');
    state.series = saved.series;
    render();
    mutateFile('progress.json', (p) => { const n = { ...(p || {}) }; delete n[url]; return n; }, 'Remove progress')
      .then((p) => { state.progress = p; })
      .catch(() => { /* leftover progress is harmless */ });
    toast(`ลบ "${title}" แล้ว`);
  } catch (err) {
    toast(`ลบไม่สำเร็จ (${err.detail || err.message})`);
  }
}

let progressTarget = null;
function openProgressDialog(url) {
  if (!requireWrite()) return;
  const x = derive(state.series.find((s) => s.url === url));
  progressTarget = url;
  $('#progress-title').textContent = x.title;
  const input = els.progressForm.elements.chapter;
  input.value = x.read || '';
  input.max = x.latest?.num ?? '';
  els.progressError.hidden = true;
  els.progressDialog.showModal();
  input.select();
}

function openSettings() {
  const f = els.settingsForm.elements;
  f.owner.value = config.owner || '';
  f.repo.value = config.repo || '';
  f.branch.value = config.branch || 'main';
  f.token.value = config.token || '';
  els.settingsError.hidden = true;
  els.settings.showModal();
}

function applyTheme(theme) {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}

// ---------- events ----------

els.grid.addEventListener('click', (e) => {
  const actEl = e.target.closest('[data-act]');
  const card = e.target.closest('.card');
  if (!actEl || !card) return;
  const url = card.dataset.url;
  const act = actEl.dataset.act;

  if (act === 'menu') {
    e.stopPropagation();
    state.openMenu = state.openMenu === url ? null : url;
    render();
    return;
  }
  state.openMenu = null;

  if (act === 'read') {
    // Let the link open normally (keeps popup blockers happy), then save.
    if (canWrite()) setProgress(url, Number(actEl.dataset.num), { silent: true });
    else toast('เปิดตอนแล้ว (ยังไม่บันทึก เพราะยังไม่ได้ใส่ token)');
  } else if (act === 'caught-up') {
    const x = derive(state.series.find((s) => s.url === url));
    setProgress(url, x.latest.num);
  } else if (act === 'set-progress') {
    render();
    openProgressDialog(url);
  } else if (act === 'remove') {
    render();
    removeSeries(url);
  }
});

document.addEventListener('click', (e) => {
  if (state.openMenu && !e.target.closest('.menu')) {
    state.openMenu = null;
    render();
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.openMenu) { state.openMenu = null; render(); }
});

els.banner.addEventListener('click', (e) => {
  if (e.target.closest('[data-act="settings"]')) openSettings();
});

els.addForm.addEventListener('submit', (e) => {
  e.preventDefault();
  els.addError.hidden = true;
  if (!els.addUrl.value.trim()) return showAddError('วางลิงก์การ์ตูนก่อน');
  addSeries(els.addUrl.value);
});
els.addUrl.addEventListener('input', () => { els.addError.hidden = true; });

document.querySelectorAll('.chip').forEach((chip) => chip.addEventListener('click', () => {
  state.filter = chip.dataset.filter;
  store.set('mt-filter', state.filter);
  render();
}));
els.sort.value = state.sort;
els.sort.addEventListener('change', () => { state.sort = els.sort.value; store.set('mt-sort', state.sort); render(); });
els.search.addEventListener('input', () => { state.query = els.search.value; render(); });

els.refresh.addEventListener('click', () => load());

$('#btn-theme').addEventListener('click', () => {
  const current = document.documentElement.dataset.theme
    || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const next = current === 'dark' ? 'light' : 'dark';
  store.set('mt-theme', next);
  applyTheme(next);
});

$('#btn-settings').addEventListener('click', openSettings);
$('#settings-cancel').addEventListener('click', () => els.settings.close());
$('#settings-clear').addEventListener('click', () => {
  els.settingsForm.elements.token.value = '';
});
els.settingsForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = els.settingsForm.elements;
  const next = {
    owner: f.owner.value.trim(),
    repo: f.repo.value.trim(),
    branch: f.branch.value.trim() || 'main',
    token: f.token.value.trim(),
  };
  if (!next.owner || !next.repo) {
    els.settingsError.textContent = 'กรอก Owner และ Repo ก่อน';
    els.settingsError.hidden = false;
    return;
  }
  const saveBtn = $('#settings-save');
  saveBtn.setAttribute('aria-busy', 'true');
  const prev = config;
  config = next;
  try {
    const res = await gh(repoPath(''));
    const repo = await res.json();
    if (next.token && !repo.permissions?.push) throw Object.assign(new Error('token นี้ไม่มีสิทธิ์เขียน repo'), { friendly: true });
    store.set('mt-config', next);
    els.settings.close();
    toast('บันทึกการตั้งค่าแล้ว');
    load();
  } catch (err) {
    config = prev;
    els.settingsError.textContent = err.friendly ? err.message
      : err.status === 401 ? 'token ไม่ถูกต้องหรือหมดอายุ'
      : err.status === 404 ? 'ไม่พบ repo นี้ (หรือ token เข้าถึงไม่ได้)'
      : `เชื่อมต่อไม่สำเร็จ (${err.message})`;
    els.settingsError.hidden = false;
  } finally {
    saveBtn.removeAttribute('aria-busy');
  }
});
els.settingsForm.addEventListener('input', () => { els.settingsError.hidden = true; });

$('#progress-cancel').addEventListener('click', () => els.progressDialog.close());
els.progressForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const val = Number(els.progressForm.elements.chapter.value);
  if (!Number.isFinite(val) || val < 0) {
    els.progressError.textContent = 'ใส่เลขตอนที่ถูกต้อง';
    els.progressError.hidden = false;
    return;
  }
  els.progressDialog.close();
  setProgress(progressTarget, val);
});
els.progressForm.addEventListener('input', () => { els.progressError.hidden = true; });

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && Date.now() - state.lastLoad > 60000) load({ quiet: true });
});
setInterval(() => { if (document.visibilityState === 'visible') load({ quiet: true }); }, AUTO_RELOAD_MS);

// ---------- boot ----------

applyTheme(store.get('mt-theme', null));
render();
load();
