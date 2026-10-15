'use strict';
/*
 * بک‌اند سایت پرشین (بدون وابستگی؛ فقط Node 18 یا بالاتر)
 *
 * مسیرهای عمومی (سایت اصلی):
 *   POST /api/comments  /api/likes  /api/orders
 * مسیرهای ادمین (نیاز به توکن ورود):
 *   POST /api/admin/login
 *   GET  /api/admin/overview
 *   PATCH/DELETE /api/admin/orders/:id      DELETE /api/admin/comments/:id
 *   GET/PUT /api/admin/gh/file               (خواندن/نوشتن data/*.json و images/* روی گیت‌هاب)
 *   POST /api/admin/backup/now  GET /api/admin/backup/download  POST /api/admin/backup/restore
 */

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

// ---------------------------------------------------------------- تنظیمات
const env = (k, d = '') => (process.env[k] === undefined ? d : String(process.env[k]));
const PORT = Number(env('PORT', '3000'));
const ADMIN_USERNAME = env('ADMIN_USERNAME').trim();
const ADMIN_PASSWORD = env('ADMIN_PASSWORD');
const SESSION_HOURS = Number(env('SESSION_HOURS', '12')) || 12;
let SESSION_SECRET = env('SESSION_SECRET');
if (SESSION_SECRET.length < 16) {
  SESSION_SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('[warn] SESSION_SECRET تنظیم نشده؛ با هر ری‌استارت همه‌ی نشست‌ها بسته می‌شن.');
}
const GITHUB_TOKEN = env('GITHUB_TOKEN').trim();
const GITHUB_API = env('GITHUB_API_BASE', 'https://api.github.com').replace(/\/+$/, '');
const CONTENT_REPO = env('CONTENT_REPO').trim();
const CONTENT_BRANCH = env('CONTENT_BRANCH', 'main').trim();
const BACKUP_REPO = env('BACKUP_REPO').trim();
const BACKUP_BRANCH = env('BACKUP_BRANCH', 'main').trim();
const BACKUP_PATH = env('BACKUP_PATH', 'backup.json').trim();
const DATA_FILE = env('DATA_FILE', path.join(__dirname, 'data', 'db.json'));
const ALLOWED_ORIGINS = env('ALLOWED_ORIGINS', 'https://persian4634.ir,https://www.persian4634.ir')
  .split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean);

const MAX_ORDERS = 5000, MAX_COMMENTS = 5000, MAX_LIKE_KEYS = 2000;
const ORDER_STATUSES = ['new', 'confirmed', 'shipped', 'done', 'canceled'];
const COMMENT_KINDS = ['story', 'section', 'general'];

const githubConfigured = () => !!GITHUB_TOKEN;
const backupConfigured = () => !!(GITHUB_TOKEN && BACKUP_REPO);

// ---------------------------------------------------------------- ابزارهای کوچک
const str = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max);
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const sha256 = s => crypto.createHash('sha256').update(String(s)).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(sha256(a), sha256(b));
const b64url = buf => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const newId = () => crypto.randomBytes(8).toString('hex');
const clientIp = req => {
  const xff = String(req.headers['x-forwarded-for'] || '');
  // پروکسی هاست آی‌پی واقعی رو آخر لیست اضافه می‌کنه؛ قسمت‌های قبلی رو کاربر می‌تونه جعل کنه
  return (xff ? xff.split(',').pop().trim() : req.socket.remoteAddress) || 'unknown';
};

// ---------------------------------------------------------------- محدودکننده‌ی درخواست
const buckets = new Map();
function hit(bucket, ip, max, windowMs) {
  const k = bucket + '|' + ip, now = Date.now();
  let e = buckets.get(k);
  if (!e || e.reset < now) { e = { n: 0, reset: now + windowMs }; buckets.set(k, e); }
  e.n++;
  return e.n <= max;
}
function peek(bucket, ip, max) {
  const e = buckets.get(bucket + '|' + ip);
  return !(e && e.reset > Date.now() && e.n >= max);
}
setInterval(() => { const now = Date.now(); for (const [k, e] of buckets) if (e.reset < now) buckets.delete(k); }, 10 * 60 * 1000).unref();

// ---------------------------------------------------------------- توکن نشست
const sign = body => b64url(crypto.createHmac('sha256', SESSION_SECRET).update(body).digest());
function makeToken() {
  const body = b64url(JSON.stringify({ r: 'admin', exp: Date.now() + SESSION_HOURS * 3600 * 1000 }));
  return body + '.' + sign(body);
}
function verifyToken(t) {
  if (typeof t !== 'string') return false;
  const [body, sig] = t.split('.');
  if (!body || !sig) return false;
  const good = sign(body);
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return false;
  try {
    const p = JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return p && p.r === 'admin' && p.exp > Date.now();
  } catch (e) { return false; }
}

// ---------------------------------------------------------------- دیتابیس (فایل JSON)
let db = { orders: [], comments: [], likes: {}, backup: { at: null, ok: null, error: '' } };
let writeChain = Promise.resolve();

async function loadDb() {
  try {
    const raw = JSON.parse(await fsp.readFile(DATA_FILE, 'utf8'));
    db.orders = Array.isArray(raw.orders) ? raw.orders : [];
    db.comments = Array.isArray(raw.comments) ? raw.comments : [];
    db.likes = isObj(raw.likes) ? raw.likes : {};
    db.backup = isObj(raw.backup) ? raw.backup : db.backup;
  } catch (e) { /* فایل هنوز وجود نداره */ }
}
function persist() {
  writeChain = writeChain.then(async () => {
    try {
      await fsp.mkdir(path.dirname(DATA_FILE), { recursive: true });
      const tmp = DATA_FILE + '.tmp';
      await fsp.writeFile(tmp, JSON.stringify(db));
      await fsp.rename(tmp, DATA_FILE);
    } catch (e) { console.error('[db] ذخیره نشد:', e.message); }
  });
  return writeChain;
}
const isEmpty = () => !db.orders.length && !db.comments.length && !Object.keys(db.likes).length;
const snapshot = () => ({ version: 1, exportedAt: new Date().toISOString(), orders: db.orders, comments: db.comments, likes: db.likes });

// ---------------------------------------------------------------- اعتبارسنجی داده‌ها
function cleanOrder(o, keepMeta) {
  if (!isObj(o)) return null;
  const items = (Array.isArray(o.items) ? o.items : []).slice(0, 50).map(i => ({
    id: str(i && i.id, 80),
    title: str(i && i.title, 200),
    price: Math.min(Math.max(Number(i && i.price) || 0, 0), 1e10),
    qty: Math.min(Math.max(Math.floor(Number(i && i.qty)) || 1, 1), 999),
  })).filter(i => i.title);
  if (!items.length) return null;
  const c = isObj(o.customer) ? o.customer : {};
  const total = items.reduce((s, i) => s + i.price * i.qty, 0);
  const code = str(o.discountCode, 40);
  const percent = Math.min(Math.max(Number(o.discountPercent) || 0, 0), 100);
  const discount = code && percent > 0 ? Math.round(total * percent / 100) : 0;
  const out = {
    id: str(o.id, 40).replace(/[^A-Za-z0-9_-]/g, '') || newId().toUpperCase(),
    customer: { name: str(c.name, 100), phone: str(c.phone, 30), email: str(c.email, 120) },
    items, total, discountCode: discount ? code : '', discountPercent: discount ? percent : 0,
    discount, payable: total - discount,
    status: 'new', createdAt: new Date().toISOString(),
  };
  if (keepMeta) {
    if (ORDER_STATUSES.includes(o.status)) out.status = o.status;
    if (o.createdAt && !isNaN(Date.parse(o.createdAt))) out.createdAt = new Date(o.createdAt).toISOString();
  }
  return out;
}
function cleanComment(c, keepMeta) {
  if (!isObj(c)) return null;
  const message = str(c.message, 2000);
  if (!message) return null;
  const out = {
    id: keepMeta && c.id ? str(c.id, 40) : newId(),
    kind: COMMENT_KINDS.includes(c.kind) ? c.kind : 'general',
    ref: str(c.ref, 200), name: str(c.name, 100) || 'بدون نام',
    message, phone: str(c.phone, 30), email: str(c.email, 120),
    createdAt: new Date().toISOString(),
  };
  if (keepMeta && c.createdAt && !isNaN(Date.parse(c.createdAt))) out.createdAt = new Date(c.createdAt).toISOString();
  return out;
}
function cleanLikes(l) {
  const out = {};
  if (!isObj(l)) return out;
  for (const k of Object.keys(l).slice(0, MAX_LIKE_KEYS)) {
    const v = l[k];
    let arr = [];
    if (Array.isArray(v)) arr = v.map(x => str(x, 80)).filter(Boolean);
    else if (Number(v) > 0) arr = Array.from({ length: Math.min(Number(v), 100000) }, (_, i) => 'legacy-' + i);
    if (arr.length) out[str(k, 300)] = Array.from(new Set(arr));
  }
  return out;
}

// ---------------------------------------------------------------- گیت‌هاب
const encPath = p => p.split('/').map(encodeURIComponent).join('/');
async function ghRequest(method, repo, filePath, branch, body) {
  if (!githubConfigured()) { const e = new Error('GITHUB_TOKEN روی سرور تنظیم نشده.'); e.status = 503; throw e; }
  if (!repo) { const e = new Error('ریپوی گیت‌هاب روی سرور تنظیم نشده.'); e.status = 503; throw e; }
  const url = `${GITHUB_API}/repos/${repo}/contents/${encPath(filePath)}` + (method === 'GET' ? `?ref=${encodeURIComponent(branch)}` : '');
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: 'Bearer ' + GITHUB_TOKEN,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'persian-backend',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000),
    });
  } catch (e) { const err = new Error('ارتباط با گیت‌هاب برقرار نشد.'); err.status = 502; throw err; }
  const data = await res.json().catch(() => ({}));
  return { res, data };
}
async function ghReadFile(repo, filePath, branch) {
  const { res, data } = await ghRequest('GET', repo, filePath, branch);
  if (res.status === 404) return { exists: false };
  if (!res.ok) { const e = new Error('خطای گیت‌هاب: ' + (data.message || res.status)); e.status = res.status === 401 || res.status === 403 ? 502 : res.status; throw e; }
  let content = String(data.content || '').replace(/\s+/g, '');
  if (!content && data.sha) { // فایل‌های بزرگ‌تر از ۱ مگابایت
    const r = await fetch(`${GITHUB_API}/repos/${repo}/git/blobs/${data.sha}`, {
      headers: { Authorization: 'Bearer ' + GITHUB_TOKEN, Accept: 'application/vnd.github+json', 'User-Agent': 'persian-backend' },
    });
    const b = await r.json().catch(() => ({}));
    content = String(b.content || '').replace(/\s+/g, '');
  }
  return { exists: true, sha: data.sha, content };
}
async function ghWriteFile(repo, filePath, branch, contentB64, message, sha) {
  const { res, data } = await ghRequest('PUT', repo, filePath, branch, { message, content: contentB64, branch, ...(sha ? { sha } : {}) });
  if (!res.ok) {
    const e = new Error(res.status === 409 || res.status === 422
      ? 'فایل تو این فاصله تغییر کرده؛ صفحه رو رفرش کنید و دوباره امتحان کنید. (' + (data.message || res.status) + ')'
      : 'خطای گیت‌هاب: ' + (data.message || res.status));
    e.status = res.status === 401 || res.status === 403 ? 502 : (res.status === 409 || res.status === 422 ? 409 : res.status);
    throw e;
  }
  return data;
}

// ---------------------------------------------------------------- بکاپ
let backupTimer = null;
function scheduleBackup() {
  if (!backupConfigured()) return;
  clearTimeout(backupTimer);
  backupTimer = setTimeout(() => { doBackup().catch(() => {}); }, 30 * 1000);
  backupTimer.unref();
}
async function doBackup() {
  try {
    const cur = await ghReadFile(BACKUP_REPO, BACKUP_PATH, BACKUP_BRANCH);
    const b64 = Buffer.from(JSON.stringify(snapshot(), null, 2), 'utf8').toString('base64');
    await ghWriteFile(BACKUP_REPO, BACKUP_PATH, BACKUP_BRANCH, b64, 'backup ' + new Date().toISOString(), cur.exists ? cur.sha : undefined);
    db.backup = { at: new Date().toISOString(), ok: true, error: '' };
  } catch (e) {
    db.backup = { at: new Date().toISOString(), ok: false, error: e.message };
    await persist();
    throw e;
  }
  await persist();
}
function applySnapshot(d) {
  if (!isObj(d)) { const e = new Error('فایل بکاپ معتبر نیست.'); e.status = 400; throw e; }
  const orders = (Array.isArray(d.orders) ? d.orders : []).map(o => cleanOrder(o, true)).filter(Boolean).slice(-MAX_ORDERS);
  const comments = (Array.isArray(d.comments) ? d.comments : []).map(c => cleanComment(c, true)).filter(Boolean).slice(-MAX_COMMENTS);
  db.orders = orders; db.comments = comments; db.likes = cleanLikes(d.likes);
  return { orders: orders.length, comments: comments.length };
}
async function restoreFromGithub() {
  const f = await ghReadFile(BACKUP_REPO, BACKUP_PATH, BACKUP_BRANCH);
  if (!f.exists) { const e = new Error('هنوز فایل بکاپی تو گیت‌هاب نیست.'); e.status = 404; throw e; }
  let data;
  try { data = JSON.parse(Buffer.from(f.content, 'base64').toString('utf8')); }
  catch (e) { const err = new Error('فایل بکاپ گیت‌هاب خراب است.'); err.status = 422; throw err; }
  return applySnapshot(data);
}

// ---------------------------------------------------------------- HTTP
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

function corsHeaders(req) {
  const h = { Vary: 'Origin' };
  const o = req.headers.origin;
  if (o && (ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(o.replace(/\/+$/, '')))) {
    h['Access-Control-Allow-Origin'] = o;
    h['Access-Control-Allow-Methods'] = 'GET,POST,PUT,PATCH,DELETE,OPTIONS';
    h['Access-Control-Allow-Headers'] = 'Content-Type, Authorization';
    h['Access-Control-Max-Age'] = '86400';
  }
  return h;
}
function send(req, res, status, obj, extra) {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...corsHeaders(req), ...(extra || {}),
  });
  res.end(body);
}
function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0, failed = false;
    req.on('data', c => {
      if (failed) return;
      size += c.length;
      if (size > limit) { failed = true; reject(new HttpError(413, 'حجم درخواست خیلی زیاده.')); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (failed) return;
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(new HttpError(400, 'بدنه‌ی درخواست JSON معتبر نیست.')); }
    });
    req.on('error', () => reject(new HttpError(400, 'خطا در دریافت درخواست.')));
  });
}
function requireAdmin(req) {
  const m = /^Bearer (.+)$/.exec(String(req.headers.authorization || ''));
  if (!m || !verifyToken(m[1])) throw new HttpError(401, 'نشست تموم شده؛ دوباره وارد بشید.');
}
const FILE_PATH_RE = /^(data\/[A-Za-z0-9._-]+\.json|images\/[A-Za-z0-9._-]+\.(jpe?g|png|webp|gif))$/i;

async function route(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname.replace(/\/+$/, '') || '/';
  const m = req.method;
  const ip = clientIp(req);

  if (m === 'OPTIONS') { res.writeHead(204, corsHeaders(req)); return res.end(); }
  if (m === 'GET' && (p === '/' || p === '/health' || p === '/api/health')) return send(req, res, 200, { ok: true, service: 'persian-backend' });

  // ---------- عمومی ----------
  if (m === 'POST' && p === '/api/comments') {
    if (!hit('comment', ip, 10, 10 * 60 * 1000)) throw new HttpError(429, 'خیلی سریع نظر می‌فرستید؛ کمی بعد دوباره امتحان کنید.');
    const c = cleanComment(await readJson(req, 100 * 1024), false);
    if (!c) throw new HttpError(400, 'متن نظر خالیه.');
    db.comments.push(c); if (db.comments.length > MAX_COMMENTS) db.comments.shift();
    await persist(); scheduleBackup();
    return send(req, res, 200, { ok: true });
  }
  if (m === 'POST' && p === '/api/likes') {
    if (!hit('like', ip, 120, 10 * 60 * 1000)) throw new HttpError(429, 'تعداد درخواست زیاده.');
    const b = await readJson(req, 10 * 1024);
    const key = str(b.key, 300), cid = str(b.clientId, 80);
    if (!key || !cid) throw new HttpError(400, 'اطلاعات ناقصه.');
    if (!db.likes[key] && Object.keys(db.likes).length >= MAX_LIKE_KEYS) throw new HttpError(400, 'تعداد کلیدها زیاده.');
    const set = new Set(db.likes[key] || []);
    if (b.liked) set.add(cid); else set.delete(cid);
    if (set.size) db.likes[key] = Array.from(set); else delete db.likes[key];
    await persist(); scheduleBackup();
    return send(req, res, 200, { ok: true, count: set.size });
  }
  if (m === 'POST' && p === '/api/orders') {
    if (!hit('order', ip, 20, 10 * 60 * 1000)) throw new HttpError(429, 'تعداد سفارش‌ها زیاده؛ کمی بعد دوباره امتحان کنید.');
    const o = cleanOrder(await readJson(req, 200 * 1024), false);
    if (!o) throw new HttpError(400, 'سفارش خالیه یا نامعتبره.');
    if (db.orders.some(x => x.id === o.id)) return send(req, res, 200, { ok: true, id: o.id, duplicate: true });
    db.orders.push(o); if (db.orders.length > MAX_ORDERS) db.orders.shift();
    await persist(); scheduleBackup();
    return send(req, res, 200, { ok: true, id: o.id });
  }

  // ---------- ورود ----------
  if (m === 'POST' && p === '/api/admin/login') {
    if (!ADMIN_PASSWORD) throw new HttpError(503, 'رمز ادمین روی سرور تنظیم نشده (ADMIN_PASSWORD).');
    if (!peek('login-fail', ip, 8)) throw new HttpError(429, 'تلاش‌های ناموفق زیاد بود؛ ۱۵ دقیقه صبر کنید.');
    const b = await readJson(req, 10 * 1024);
    const passOk = safeEqual(b.password == null ? '' : b.password, ADMIN_PASSWORD);
    const userOk = !ADMIN_USERNAME || safeEqual(String(b.username == null ? '' : b.username).trim(), ADMIN_USERNAME);
    if (!(passOk && userOk)) {
      hit('login-fail', ip, 8, 15 * 60 * 1000);
      await new Promise(r => setTimeout(r, 600));
      throw new HttpError(401, ADMIN_USERNAME ? 'نام کاربری یا رمز اشتباهه.' : 'رمز اشتباهه.');
    }
    return send(req, res, 200, { token: makeToken(), expiresInHours: SESSION_HOURS });
  }

  // ---------- ادمین ----------
  if (p.startsWith('/api/admin/')) {
    requireAdmin(req);

    if (m === 'GET' && p === '/api/admin/overview') {
      const likes = {};
      for (const [k, arr] of Object.entries(db.likes)) likes[k] = arr.length;
      return send(req, res, 200, {
        orders: db.orders.slice().reverse(),
        comments: db.comments.slice().reverse(),
        likes,
        backup: { configured: backupConfigured(), ...db.backup },
        totals: { orders: db.orders.length, comments: db.comments.length },
      });
    }
    let mm;
    if ((mm = /^\/api\/admin\/orders\/([^/]+)$/.exec(p))) {
      const id = decodeURIComponent(mm[1]);
      const i = db.orders.findIndex(o => o.id === id);
      if (i < 0) throw new HttpError(404, 'سفارش پیدا نشد.');
      if (m === 'PATCH') {
        const b = await readJson(req, 10 * 1024);
        if (!ORDER_STATUSES.includes(b.status)) throw new HttpError(400, 'وضعیت نامعتبره.');
        db.orders[i].status = b.status;
        await persist(); scheduleBackup();
        return send(req, res, 200, { ok: true });
      }
      if (m === 'DELETE') { db.orders.splice(i, 1); await persist(); scheduleBackup(); return send(req, res, 200, { ok: true }); }
    }
    if ((mm = /^\/api\/admin\/comments\/([^/]+)$/.exec(p)) && m === 'DELETE') {
      const id = decodeURIComponent(mm[1]);
      const i = db.comments.findIndex(c => c.id === id);
      if (i < 0) throw new HttpError(404, 'نظر پیدا نشد.');
      db.comments.splice(i, 1); await persist(); scheduleBackup();
      return send(req, res, 200, { ok: true });
    }
    if (p === '/api/admin/gh/file' && m === 'GET') {
      const fp = url.searchParams.get('path') || '';
      if (!FILE_PATH_RE.test(fp)) throw new HttpError(400, 'مسیر فایل مجاز نیست.');
      const f = await ghReadFile(CONTENT_REPO, fp, CONTENT_BRANCH);
      return send(req, res, 200, f.exists ? { exists: true, sha: f.sha, content: f.content } : { exists: false });
    }
    if (p === '/api/admin/gh/file' && m === 'PUT') {
      const b = await readJson(req, 15 * 1024 * 1024);
      const fp = str(b.path, 200);
      if (!FILE_PATH_RE.test(fp)) throw new HttpError(400, 'مسیر فایل مجاز نیست.');
      const content = String(b.content || '').replace(/\s+/g, '');
      if (!content || !/^[A-Za-z0-9+/]+=*$/.test(content)) throw new HttpError(400, 'محتوای فایل نامعتبره.');
      const data = await ghWriteFile(CONTENT_REPO, fp, CONTENT_BRANCH, content, str(b.message, 200) || 'update ' + fp, b.sha ? str(b.sha, 80) : undefined);
      return send(req, res, 200, { ok: true, sha: data.content && data.content.sha });
    }
    if (p === '/api/admin/backup/now' && m === 'POST') {
      if (!backupConfigured()) throw new HttpError(503, 'بکاپ گیت‌هاب روی سرور تنظیم نشده (GITHUB_TOKEN و BACKUP_REPO).');
      await doBackup();
      return send(req, res, 200, { ok: true });
    }
    if (p === '/api/admin/backup/download' && m === 'GET') {
      return send(req, res, 200, JSON.stringify(snapshot(), null, 2), {
        'Content-Disposition': 'attachment; filename="persian-backup.json"',
      });
    }
    if (p === '/api/admin/backup/restore' && m === 'POST') {
      const b = await readJson(req, 15 * 1024 * 1024);
      let r;
      if (b.fromGithub) {
        if (!backupConfigured()) throw new HttpError(503, 'بکاپ گیت‌هاب روی سرور تنظیم نشده.');
        r = await restoreFromGithub();
      } else r = applySnapshot(b.data);
      await persist();
      return send(req, res, 200, { ok: true, ...r });
    }
    throw new HttpError(404, 'مسیر پیدا نشد.');
  }

  throw new HttpError(404, 'مسیر پیدا نشد.');
}

const server = http.createServer((req, res) => {
  route(req, res).catch(err => {
    const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
    if (status === 500) console.error('[error]', req.method, req.url, err);
    if (!res.headersSent) send(req, res, status, { error: status === 500 ? 'خطای داخلی سرور.' : err.message });
  });
});
server.requestTimeout = 60 * 1000;
server.headersTimeout = 20 * 1000;

(async () => {
  await loadDb();
  if (isEmpty() && backupConfigured()) {
    try { const r = await restoreFromGithub(); await persist(); console.log(`[backup] از گیت‌هاب بازیابی شد (${r.orders} سفارش، ${r.comments} نظر)`); }
    catch (e) { console.log('[backup] بازیابی خودکار انجام نشد:', e.message); }
  }
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`persian-backend روی پورت ${PORT} بالا اومد`);
    if (!ADMIN_PASSWORD) console.warn('[warn] ADMIN_PASSWORD تنظیم نشده؛ ورود ادمین کار نمی‌کنه.');
    if (!githubConfigured()) console.warn('[warn] GITHUB_TOKEN تنظیم نشده؛ ذخیره‌ی تغییرات سایت و بکاپ کار نمی‌کنه.');
  });
})();

process.on('SIGTERM', () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); });
