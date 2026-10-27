// Reads series.json, fetches every series page, and writes data.json.
// Runs in GitHub Actions on a schedule; no dependencies beyond Node 20+.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERIES_FILE = path.join(ROOT, 'series.json');
const DATA_FILE = path.join(ROOT, 'data.json');
const DELAY_MS = 1500;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

const THAI_MONTHS = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
  'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
const EN_MONTHS = ['january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function fetchHtml(url, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'th,en;q=0.8' }, redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { html: await res.text(), finalUrl: res.url };
    } catch (err) {
      lastErr = err;
      await sleep(2000 * (i + 1));
    }
  }
  throw lastErr;
}

function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .trim();
}

// "กุมภาพันธ์ 16, 2025" or "February 16, 2025" -> "2025-02-16"
function parseDate(text) {
  const m = text.trim().match(/^(\S+)\s+(\d{1,2}),\s*(\d{4})$/);
  if (!m) return null;
  let month = THAI_MONTHS.indexOf(m[1]);
  if (month < 0) month = EN_MONTHS.indexOf(m[1].toLowerCase());
  if (month < 0) return null;
  let year = Number(m[3]);
  if (year > 2400) year -= 543; // Buddhist era
  return `${year}-${String(month + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}

const isSeriesUrl = (url) => /\/manga\/[^/]+\/?$/.test(new URL(url).pathname);

// Chapter pages link back to their series via "All chapters are in ..." (div.allc) or the breadcrumb.
function findSeriesUrl(html) {
  const m = html.match(/class="allc"[^>]*>[\s\S]*?href="([^"]+\/manga\/[^"]+)"/)
    || html.match(/itemprop="item"\s+href="([^"]+\/manga\/[^"]+)"/);
  return m ? m[1] : null;
}

function parseSeries(html) {
  const title = (html.match(/<h1[^>]*class="entry-title"[^>]*>([\s\S]*?)<\/h1>/) || [])[1];
  const cover = (html.match(/property="og:image"\s+content="([^"]+)"/) || [])[1]
    || (html.match(/class="thumb"[\s\S]*?<img[^>]+src="([^"]+)"/) || [])[1];

  const listStart = html.indexOf('id="chapterlist"');
  if (listStart < 0) throw new Error('ไม่พบรายการตอนในหน้าเรื่อง');
  const listHtml = html.slice(listStart);

  const chapters = [];
  const liRe = /<li\s+data-num="([^"]+)"[^>]*>([\s\S]*?)<\/li>/g;
  let m;
  while ((m = liRe.exec(listHtml))) {
    const num = parseFloat(m[1]);
    if (Number.isNaN(num)) continue; // skips the {{number}} template row
    const body = m[2];
    const url = (body.match(/href="([^"]+)"/) || [])[1];
    const name = (body.match(/class="chapternum">([\s\S]*?)<\/span>/) || [])[1];
    const dateText = (body.match(/class="chapterdate">([\s\S]*?)<\/span>/) || [])[1];
    if (!url) continue;
    chapters.push({
      num,
      name: name ? decodeEntities(name) : `ตอนที่ ${num}`,
      url,
      date: dateText ? parseDate(decodeEntities(dateText)) : null,
    });
  }
  if (!chapters.length) throw new Error('ไม่พบตอนใดๆ ในหน้าเรื่อง');

  const seen = new Set();
  const unique = chapters
    .sort((a, b) => b.num - a.num)
    .filter((c) => (seen.has(c.num) ? false : seen.add(c.num)));

  return { title: title ? decodeEntities(title.replace(/<[^>]+>/g, '')) : null, cover: cover || null, chapters: unique };
}

async function checkOne(inputUrl, prev, now) {
  let seriesUrl = prev?.seriesUrl;
  if (!seriesUrl) {
    if (isSeriesUrl(inputUrl)) {
      seriesUrl = inputUrl;
    } else {
      const { html } = await fetchHtml(inputUrl);
      seriesUrl = findSeriesUrl(html);
      if (!seriesUrl) throw new Error('หาหน้ารวมของเรื่องจากลิงก์นี้ไม่เจอ');
      await sleep(DELAY_MS);
    }
  }

  const { html } = await fetchHtml(seriesUrl);
  const parsed = parseSeries(html);

  // Keep when we first saw each chapter, so the UI can say "found 2 hours ago".
  // On the very first check nothing is "new", so firstSeen stays null.
  const prevSeen = new Map((prev?.chapters || []).map((c) => [c.num, c.firstSeen ?? null]));
  const isFirstCheck = !prev?.chapters?.length;
  const chapters = parsed.chapters.map((c) => ({
    ...c,
    firstSeen: prevSeen.has(c.num) ? prevSeen.get(c.num) : (isFirstCheck ? null : now),
  }));

  const newCount = isFirstCheck ? 0 : chapters.filter((c) => !prevSeen.has(c.num)).length;
  return {
    seriesUrl,
    title: parsed.title || prev?.title || seriesUrl,
    cover: parsed.cover || prev?.cover || null,
    chapters,
    lastChange: newCount || isFirstCheck ? now : (prev?.lastChange ?? now),
    error: null,
    newCount,
  };
}

async function main() {
  const seriesList = (await readJson(SERIES_FILE, { series: [] })).series || [];
  const data = await readJson(DATA_FILE, { series: {} });
  const prevSeries = data.series || {};
  const now = new Date().toISOString();
  const next = {};

  for (const [i, item] of seriesList.entries()) {
    const url = item.url;
    const prev = prevSeries[url];
    try {
      const { newCount, ...result } = await checkOne(url, prev, now);
      next[url] = result;
      console.log(`✓ ${result.title} — ล่าสุด ${result.chapters[0].num}${newCount ? ` (+${newCount} ใหม่)` : ''}`);
    } catch (err) {
      // Keep the old data so one failed fetch doesn't wipe the card.
      // errorAt only moves when the error changes, so a site that stays down doesn't commit every hour.
      const error = String(err.message || err);
      next[url] = { ...(prev || {}), error, errorAt: prev?.error === error ? prev.errorAt : now };
      console.warn(`✗ ${url} — ${err.message || err}`);
    }
    if (i < seriesList.length - 1) await sleep(DELAY_MS);
  }

  const out = JSON.stringify({ series: next }, null, 1) + '\n';
  const before = await readFile(DATA_FILE, 'utf8').catch(() => '');
  if (out !== before) {
    await writeFile(DATA_FILE, out);
    console.log('data.json updated');
  } else {
    console.log('no changes');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
