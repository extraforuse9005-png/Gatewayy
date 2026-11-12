const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'data.json');
const ORDER_MS = 3 * 60 * 1000; // each payment link lives 3 minutes
const SLOT_COUNT = 20;          // base + 0.01 ... base + 0.20
const CHECK_MS = 8000;          // inbox check interval
const CREDIT_WORDS = /(received|credited|credit|paid you|payment)/i;
const MASK = '••••••••••••••••';

const app = express();
app.use(express.json());
app.use('/api/v1', (req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Serve the front-end files from the top level of the repo
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
['app.js', 'style.css', 'pay.html', 'index.html'].forEach((f) =>
  app.get('/' + f, (req, res) => res.sendFile(path.join(__dirname, f)))
);

// ---------- storage (simple JSON file) ----------
function load() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch { return { account: null, apiKey: null, orders: [], seen: [] }; }
}
let db = load();
db.orders ||= [];
db.seen ||= [];
let lastError = null;
let checking = false;
function save() { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }

// ---------- helpers ----------
const newId = () => crypto.randomBytes(8).toString('hex');
const newKey = () => 'fp_live_' + crypto.randomBytes(16).toString('hex');
const rupees = (paise) => (paise / 100).toFixed(2);

function parseAmount(v) {
  const n = Number(String(v ?? '').trim());
  if (!Number.isFinite(n) || n <= 0 || n > 100000) return null;
  return Math.round(n * 100);
}

function publicOrder(o, base = '') {
  return {
    id: o.id,
    requested_amount: Number(rupees(o.baseAmount)),
    amount: Number(rupees(o.amount)),
    status: o.status,
    createdAt: o.createdAt,
    expiresAt: o.expiresAt,
    paidAt: o.paidAt,
    pay_url: base + '/pay.html?id=' + o.id,
  };
}

function expireOrders() {
  const now = Date.now();
  let changed = false;
  for (const o of db.orders) {
    if (o.status === 'pending' && now > o.expiresAt) { o.status = 'failed'; changed = true; }
  }
  if (changed) save();
}

function createOrder(basePaise) {
  expireOrders();
  for (let slot = 1; slot <= SLOT_COUNT; slot++) {
    const amount = basePaise + slot;
    if (db.orders.some(o => o.status === 'pending' && o.amount === amount)) continue;
    const now = Date.now();
    const order = {
      id: newId(), baseAmount: basePaise, amount, status: 'pending',
      createdAt: now, expiresAt: now + ORDER_MS, paidAt: null, messageId: null,
    };
    db.orders.push(order);
    save();
    return order;
  }
  return null;
}

// Matches 10.07 exactly, not 110.07 or 10.070
function amountPattern(paise) {
  const s = rupees(paise).replace('.', '\\.');
  return new RegExp('(?<![\\d.])' + s + '(?!\\d)');
}

function imapClient(acc) {
  return new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: acc.email, pass: acc.appPassword },
    logger: false,
  });
}

// ---------- inbox checker ----------
async function checkMail() {
  if (!db.account || checking) return;
  expireOrders();
  const pending = db.orders.filter(o => o.status === 'pending');
  if (!pending.length) return;
  checking = true;
  const client = imapClient(db.account);
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const since = new Date(Math.min(...pending.map(o => o.createdAt)) - 60 * 1000);
      const uids = (await client.search({ since }, { uid: true })) || [];
      for (const uid of uids.slice(-50)) {
        const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
        if (!msg || !msg.source) continue;
        const mail = await simpleParser(msg.source);
        const mid = mail.messageId || 'uid-' + uid;
        if (db.seen.includes(mid)) continue;
        db.seen.push(mid);
        const text = [mail.subject, mail.text, mail.html && String(mail.html).replace(/<[^>]+>/g, ' ')]
          .filter(Boolean).join('\n');
        if (!CREDIT_WORDS.test(text)) continue;
        const sent = mail.date ? mail.date.getTime() : 0;
        const order = db.orders.find(o =>
          o.status === 'pending' &&
          sent >= o.createdAt - 15000 &&
          sent <= o.expiresAt &&
          amountPattern(o.amount).test(text)
        );
        if (order) {
          order.status = 'success';
          order.paidAt = Date.now();
          order.messageId = mid;
        }
      }
      db.seen = db.seen.slice(-1000);
      save();
      lastError = null;
    } finally {
      lock.release();
    }
    await client.logout();
  } catch (err) {
    lastError = 'Inbox check failed: ' + err.message;
    try { client.close(); } catch {}
  } finally {
    checking = false;
  }
}
setInterval(() => { expireOrders(); checkMail(); }, CHECK_MS);

// ---------- middleware ----------
const requireAccount = (req, res, next) =>
  db.account ? next() : res.status(403).json({ error: 'Connect Gmail in Integration first.' });

const requireApiKey = (req, res, next) => {
  if (!db.account || !db.apiKey || req.get('X-API-Key') !== db.apiKey)
    return res.status(401).json({ error: 'Invalid or missing API key.' });
  next();
};

// ---------- integration ----------
app.get('/api/status', (req, res) => {
  const a = db.account;
  res.json({
    connected: !!a,
    email: a ? a.email : null,
    upiId: a ? a.upiId : null,
    merchantName: a ? a.merchantName : null,
    passwordMask: a ? MASK : null,
    apiKey: a ? db.apiKey : null,
    lastError,
  });
});

app.post('/api/integration', async (req, res) => {
  const b = req.body || {};
  const email = String(b.email || '').trim();
  const upiId = String(b.upiId || '').trim();
  const merchantName = String(b.merchantName || '').trim() || 'Merchant';
  const appPassword = b.keep && db.account
    ? db.account.appPassword
    : String(b.appPassword || '').replace(/\s/g, '');
  if (!email || !appPassword || !upiId)
    return res.status(400).json({ error: 'Gmail, app password and UPI ID are required.' });

  const test = imapClient({ email, appPassword });
  try {
    await test.connect();
    await test.logout().catch(() => {});
  } catch {
    return res.status(400).json({
      error: 'Gmail login failed. Check the address, the 16-character app password, and that IMAP is on in Gmail settings.',
    });
  }
  db.account = { email, appPassword, upiId, merchantName };
  db.apiKey = db.apiKey || newKey();
  lastError = null;
  save();
  res.json({ ok: true });
});

app.delete('/api/integration', (req, res) => {
  db.account = null;
  save();
  res.json({ ok: true });
});

app.post('/api/integration/apikey', requireAccount, (req, res) => {
  db.apiKey = newKey();
  save();
  res.json({ apiKey: db.apiKey });
});

// ---------- dashboard ----------
app.get('/api/dashboard', (req, res) => {
  expireOrders();
  const range = req.query.range === 'all' ? 'all' : 'today';
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const from = range === 'today' ? start.getTime() : 0;
  const sum = arr => arr.reduce((s, o) => s + o.amount, 0);

  const success = db.orders.filter(o => o.status === 'success');
  const inRange = db.orders.filter(o => o.createdAt >= from);
  const rangeSuccess = success.filter(o => o.paidAt >= from);

  res.json({
    range,
    totalReceived: Number(rupees(sum(success))),
    rangeReceived: Number(rupees(sum(rangeSuccess))),
    successCount: inRange.filter(o => o.status === 'success').length,
    failedCount: inRange.filter(o => o.status === 'failed').length,
    pendingCount: inRange.filter(o => o.status === 'pending').length,
  });
});

// ---------- payment links (test payment page) ----------
app.post('/api/orders', requireAccount, (req, res) => {
  const paise = parseAmount(req.body?.amount);
  if (!paise) return res.status(400).json({ error: 'Enter a valid amount, for example 10 or 49.5.' });
  const o = createOrder(paise);
  if (!o) return res.status(429).json({ error: 'All 20 amounts for this base are busy. Wait a minute and try again.' });
  res.json(publicOrder(o));
});

app.get('/api/orders', requireAccount, (req, res) => {
  expireOrders();
  res.json(
    db.orders.slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, 100).map(o => publicOrder(o))
  );
});

app.get('/api/orders/:id', (req, res) => {
  expireOrders();
  const o = db.orders.find(x => x.id === req.params.id);
  if (!o || !db.account) return res.status(404).json({ error: 'Payment link not found.' });
  res.json({ ...publicOrder(o), upiId: db.account.upiId, merchantName: db.account.merchantName });
});

app.delete('/api/orders/:id', requireAccount, (req, res) => {
  const o = db.orders.find(x => x.id === req.params.id);
  if (!o) return res.status(404).json({ error: 'Not found.' });
  if (o.status === 'pending') return res.status(400).json({ error: 'Wait until this payment finishes before clearing it.' });
  db.orders = db.orders.filter(x => x !== o);
  save();
  res.json({ ok: true });
});

app.delete('/api/orders', requireAccount, (req, res) => {
  db.orders = db.orders.filter(o => o.status === 'pending');
  save();
  res.json({ ok: true });
});

// ---------- public API v1 ----------
const apiOrder = (o, base) => ({
  id: o.id,
  requested_amount: Number(rupees(o.baseAmount)),
  amount: Number(rupees(o.amount)),
  status: o.status,
  pay_url: base + '/pay.html?id=' + o.id,
  expires_at: o.expiresAt,
});

app.post('/api/v1/payments', requireApiKey, (req, res) => {
  const paise = parseAmount(req.body?.amount);
  if (!paise) return res.status(400).json({ error: 'amount must be a positive number' });
  const o = createOrder(paise);
  if (!o) return res.status(429).json({ error: 'Too many pending payments for this amount. Retry in a minute.' });
  res.json(apiOrder(o, `${req.protocol}://${req.get('host')}`));
});

app.get('/api/v1/payments/:id', requireApiKey, (req, res) => {
  expireOrders();
  const o = db.orders.find(x => x.id === req.params.id);
  if (!o) return res.status(404).json({ error: 'Payment not found.' });
  res.json({
    id: o.id,
    requested_amount: Number(rupees(o.baseAmount)),
    amount: Number(rupees(o.amount)),
    status: o.status,
    paid_at: o.paidAt,
  });
});

app.listen(PORT, () => console.log('FamePay gateway running on port ' + PORT));
