const view = document.getElementById('view');
const $ = (s) => document.querySelector(s);
const MASK = '••••••••••••••••';
let timer = null;
let range = 'today';
let fw = 'html';
let showKey = false;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => '₹' + Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const when = (t) => new Date(t).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const tile = (label, value, cls) => `<div class="tile ${cls}"><span>${label}</span><strong>${value}</strong></div>`;

async function api(url, options = {}) {
  const res = await fetch(url, {
    method: options.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

function toast(msg, bad = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (bad ? ' bad' : '');
  t.hidden = false;
  clearTimeout(toast.h);
  toast.h = setTimeout(() => (t.hidden = true), 2800);
}

function copyText(text, label) {
  navigator.clipboard.writeText(text).then(
    () => toast(label + ' copied'),
    () => toast('Copy failed. Select the text and copy it manually.', true)
  );
}

function locked(title, text) {
  view.innerHTML = `
    <header class="head"><h1>${title}</h1></header>
    <div class="card lock"><p>${text}</p><a class="btn primary" href="#integration">Go to Integration</a></div>`;
}

async function getStatus() { return api('/api/status'); }

// ---------- dashboard ----------
async function pageDashboard() {
  view.innerHTML = `
    <header class="head"><h1>Dashboard</h1><p class="muted">Payments confirmed from your inbox.</p></header>
    <section class="hero"><p class="lbl">Total received</p><p class="big" id="total">₹0.00</p></section>
    <div class="seg">
      <button data-range="today" class="${range === 'today' ? 'on' : ''}">Today</button>
      <button data-range="all" class="${range === 'all' ? 'on' : ''}">All time</button>
    </div>
    <section class="grid" id="tiles"></section>`;
  view.querySelectorAll('[data-range]').forEach((b) =>
    (b.onclick = () => { range = b.dataset.range; route(); }));

  const paint = async () => {
    try {
      const d = await api('/api/dashboard?range=' + range);
      $('#total').textContent = money(d.totalReceived);
      $('#tiles').innerHTML = [
        tile('Received', money(d.rangeReceived), 'amber'),
        tile('Successful', d.successCount, 'green'),
        tile('Failed', d.failedCount, 'red'),
        tile('Pending', d.pendingCount, ''),
      ].join('');
    } catch (e) { toast(e.message, true); }
  };
  await paint();
  timer = setInterval(paint, 5000);
}

// ---------- test payment ----------
const orderRow = (o) => `
  <li class="order">
    <div><strong>${money(o.amount)}</strong><span class="muted">${when(o.createdAt)}</span></div>
    <span class="pill ${o.status}">${o.status}</span>
    <code class="link">${esc(location.origin + o.pay_url)}</code>
    <div class="acts">
      <button class="btn small" data-act="open" data-id="${o.id}">Open</button>
      ${o.status !== 'pending' ? `<button class="btn small ghost" data-act="clear" data-id="${o.id}">Clear</button>` : ''}
    </div>
  </li>`;

async function pageTest() {
  const st = await getStatus();
  if (!st.connected)
    return locked('Test payment', 'Connect your Gmail in Integration first. Payments are only confirmed after the inbox connects.');

  view.innerHTML = `
    <header class="head"><h1>Test payment</h1>
      <p class="muted">Each payment gets its own amount, from +₹0.01 to +₹0.20, so every payment matches the right email.</p></header>
    <form class="card row" id="payForm">
      <label class="field"><span>Amount (₹)</span><input id="amt" inputmode="decimal" placeholder="10" autocomplete="off" required></label>
      <button class="btn primary" type="submit">Pay</button>
    </form>
    <div class="split"><h2>Payment links</h2><button class="btn small ghost" id="clearDone" type="button">Clear finished</button></div>
    <ul class="orders" id="orders"></ul>`;

  const list = async () => {
    try {
      const orders = await api('/api/orders');
      $('#orders').innerHTML = orders.length
        ? orders.map(orderRow).join('')
        : '<li class="empty">No payment links yet. Enter an amount and tap Pay.</li>';
    } catch (e) { toast(e.message, true); }
  };

  $('#payForm').onsubmit = async (e) => {
    e.preventDefault();
    // Open the window synchronously so mobile browsers don't block it
    const w = window.open('', '_blank');
    if (!w) return toast('Allow pop-ups for this site, then tap Pay again.', true);
    try {
      const o = await api('/api/orders', { method: 'POST', body: { amount: $('#amt').value } });
      w.location.href = o.pay_url;
      $('#amt').value = '';
      toast('Payment window opened for ' + money(o.amount));
      list();
    } catch (err) {
      w.close();
      toast(err.message, true);
    }
  };

  $('#clearDone').onclick = async () => {
    await api('/api/orders', { method: 'DELETE' }).catch((err) => toast(err.message, true));
    list();
  };

  $('#orders').onclick = async (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    if (b.dataset.act === 'open') window.open('/pay.html?id=' + b.dataset.id, '_blank');
    if (b.dataset.act === 'clear') {
      await api('/api/orders/' + b.dataset.id, { method: 'DELETE' }).catch((err) => toast(err.message, true));
      list();
    }
  };

  await list();
  timer = setInterval(list, 4000);
}

// ---------- integration ----------
async function pageIntegration() {
  const st = await getStatus();
  view.innerHTML = `
    <header class="head"><h1>Integration</h1>
      <p class="muted">Connect the Gmail that receives your FamePay alerts. Test payments and the API unlock after this succeeds.</p></header>
    ${st.connected ? `
      <div class="card split">
        <div><strong>Connected</strong>
          <p class="muted">${esc(st.email)} · inbox checked every 8 seconds</p>
          ${st.lastError ? `<p class="err">${esc(st.lastError)}</p>` : ''}
        </div>
        <button class="btn small ghost" id="disconnect" type="button">Disconnect</button>
      </div>` : ''}
    <form class="card form" id="intForm">
      <label class="field"><span>Gmail address</span>
        <input name="email" type="email" value="${esc(st.email || '')}" placeholder="you@gmail.com" required></label>
      <label class="field"><span>Google app password</span>
        <input name="appPassword" type="password" value="${st.connected ? MASK : ''}" placeholder="xxxx xxxx xxxx xxxx" autocomplete="new-password" required></label>
      <label class="field"><span>FamePay UPI ID</span>
        <input name="upiId" value="${esc(st.upiId || '')}" placeholder="yourname@fam" required></label>
      <label class="field"><span>Merchant name</span>
        <input name="merchantName" value="${esc(st.merchantName || '')}" placeholder="Your shop name"></label>
      <button class="btn primary wide" type="submit">${st.connected ? 'Save and reconnect' : 'Connect'}</button>
    </form>`;

  $('#intForm').onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    const keep = f.appPassword === MASK;
    try {
      await api('/api/integration', { method: 'POST', body: { ...f, keep } });
      toast('Gmail connected');
      location.hash = '#test';
    } catch (err) { toast(err.message, true); }
  };

  const d = $('#disconnect');
  if (d) d.onclick = async () => {
    await api('/api/integration', { method: 'DELETE' });
    toast('Disconnected');
    pageIntegration();
  };
}

// ---------- API docs ----------
const FRAMEWORKS = {
  html: {
    label: 'HTML',
    steps: [
      'Paste the script below into your page, just before the closing body tag.',
      'Call payNow() from a button, for example onclick="payNow()".',
      'The payment page opens in a new tab with the exact amount and QR code.',
      'Call checkPayment(id) every 3 seconds to show success or failure.',
      'The key is visible to visitors. On a public site, send the request through your own server.',
    ],
    code: `<script>
const FP_BASE = "__BASE__";
const FP_KEY = "__KEY__";

async function createPayment(amount) {
  const res = await fetch(FP_BASE + "/api/v1/payments", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": FP_KEY },
    body: JSON.stringify({ amount: amount })
  });
  return res.json(); // { id, amount, status, pay_url }
}

async function checkPayment(id) {
  const res = await fetch(FP_BASE + "/api/v1/payments/" + id, {
    headers: { "X-API-Key": FP_KEY }
  });
  return res.json(); // { status: "pending" | "success" | "failed" }
}

async function payNow() {
  const p = await createPayment(10);
  window.open(p.pay_url, "_blank");
}
</script>`,
  },
  python: {
    label: 'Python',
    steps: [
      'Install the requests library: pip install requests',
      'Save the code below as famepay.py.',
      'Call create_payment(10) and open the returned pay_url.',
      'Call check_payment(id) every 3 seconds until status is success or failed.',
    ],
    code: `import requests

BASE = "__BASE__"
API_KEY = "__KEY__"
HEADERS = {"X-API-Key": API_KEY}

def create_payment(amount):
    r = requests.post(BASE + "/api/v1/payments", json={"amount": amount}, headers=HEADERS, timeout=15)
    r.raise_for_status()
    return r.json()  # id, amount, status, pay_url

def check_payment(payment_id):
    r = requests.get(BASE + "/api/v1/payments/" + payment_id, headers=HEADERS, timeout=15)
    return r.json()  # status: pending | success | failed

p = create_payment(10)
print(p["pay_url"])`,
  },
  flutter: {
    label: 'Flutter',
    steps: [
      'Add the http package to your project: flutter pub add http',
      'Create lib/famepay.dart and paste the code below.',
      'Call createPayment(10) on tap, then open pay_url in a browser or WebView.',
      'Call checkPayment(id) every 3 seconds until status is success or failed.',
    ],
    code: `import 'dart:convert';
import 'package:http/http.dart' as http;

const String famepayBase = '__BASE__';
const String famepayKey = '__KEY__';

Future<Map<String, dynamic>> createPayment(double amount) async {
  final res = await http.post(
    Uri.parse(famepayBase + '/api/v1/payments'),
    headers: {'Content-Type': 'application/json', 'X-API-Key': famepayKey},
    body: jsonEncode({'amount': amount}),
  );
  if (res.statusCode != 200) throw Exception(res.body);
  return jsonDecode(res.body) as Map<String, dynamic>;
}

Future<Map<String, dynamic>> checkPayment(String id) async {
  final res = await http.get(
    Uri.parse(famepayBase + '/api/v1/payments/' + id),
    headers: {'X-API-Key': famepayKey},
  );
  return jsonDecode(res.body) as Map<String, dynamic>;
}

// Usage:
// final p = await createPayment(10);
// print(p['pay_url']);`,
  },
  java: {
    label: 'Java',
    steps: [
      'Use Java 11 or newer. No extra libraries are needed for the HTTP calls.',
      'Save the code below as FamePay.java, then compile with javac FamePay.java.',
      'createPayment returns JSON with pay_url. Open that URL in a browser.',
      'Parse the JSON with Gson or Jackson, then poll checkPayment(id) until it is final.',
    ],
    code: `import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;

public class FamePay {
    static final String BASE = "__BASE__";
    static final String API_KEY = "__KEY__";
    static final HttpClient client = HttpClient.newHttpClient();

    public static String createPayment(double amount) throws Exception {
        String body = "{\\"amount\\": " + amount + "}";
        HttpRequest req = HttpRequest.newBuilder(URI.create(BASE + "/api/v1/payments"))
            .header("Content-Type", "application/json")
            .header("X-API-Key", API_KEY)
            .POST(HttpRequest.BodyPublishers.ofString(body))
            .build();
        return client.send(req, HttpResponse.BodyHandlers.ofString()).body();
    }

    public static String checkPayment(String id) throws Exception {
        HttpRequest req = HttpRequest.newBuilder(URI.create(BASE + "/api/v1/payments/" + id))
            .header("X-API-Key", API_KEY)
            .GET()
            .build();
        return client.send(req, HttpResponse.BodyHandlers.ofString()).body();
    }

    public static void main(String[] args) throws Exception {
        System.out.println(createPayment(10));
    }
}`,
  },
  php: {
    label: 'PHP',
    steps: [
      'Make sure the curl extension is enabled in PHP.',
      'Save the code below as famepay.php.',
      'Call create_payment(10), then redirect the customer to pay_url.',
      'Call check_payment($id) on a timer or from a status page until it is final.',
    ],
    code: `<?php
$BASE = "__BASE__";
$API_KEY = "__KEY__";

function fp_request($method, $url, $body = null) {
    global $API_KEY;
    $ch = curl_init($url);
    curl_setopt($ch, CURLOPT_CUSTOMREQUEST, $method);
    curl_setopt($ch, CURLOPT_HTTPHEADER, ["Content-Type: application/json", "X-API-Key: " . $API_KEY]);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    if ($body !== null) curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($body));
    $res = curl_exec($ch);
    curl_close($ch);
    return json_decode($res, true);
}

function create_payment($amount) {
    global $BASE;
    return fp_request("POST", $BASE . "/api/v1/payments", ["amount" => $amount]);
}

function check_payment($id) {
    global $BASE;
    return fp_request("GET", $BASE . "/api/v1/payments/" . $id);
}

$p = create_payment(10);
echo $p["pay_url"];`,
  },
};

async function pageApi() {
  const st = await getStatus();
  if (!st.connected)
    return locked('API docs', 'Connect Gmail first. Your API key is created after the inbox connects.');

  const base = location.origin;
  const render = () => {
    const f = FRAMEWORKS[fw];
    const code = f.code.replaceAll('__BASE__', base).replaceAll('__KEY__', st.apiKey);
    const docs = f.steps.map((s, i) => (i + 1) + '. ' + s).join('\n') + '\n\n' + code;

    view.innerHTML = `
      <header class="head"><h1>API docs</h1>
        <p class="muted">Create payments from your own app or site. Pick a framework and follow the steps.</p></header>
      <section class="card form">
        <div class="split"><strong>Your API key</strong><button class="btn small ghost" id="regen" type="button">Regenerate</button></div>
        <p class="key">${showKey ? esc(st.apiKey) : MASK}</p>
        <div class="row">
          <button class="btn small" id="toggleKey" type="button">${showKey ? 'Hide' : 'Show'} key</button>
          <button class="btn small" id="copyKey" type="button">Copy key</button>
        </div>
      </section>
      <div class="tabsx">
        ${Object.entries(FRAMEWORKS).map(([k, v]) =>
          `<button class="btn small ${k === fw ? 'primary' : 'ghost'}" data-fw="${k}" type="button">${v.label}</button>`).join('')}
      </div>
      <section class="card form">
        <h2>${f.label} integration</h2>
        <ol class="steps">${f.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
        <div class="split">
          <span class="muted">Full code</span>
          <button class="btn small primary" id="copyDocs" type="button">Copy ${f.label} docs</button>
        </div>
        <pre><code>${esc(code)}</code></pre>
      </section>`;

    view.querySelectorAll('[data-fw]').forEach((b) => (b.onclick = () => { fw = b.dataset.fw; render(); }));
    $('#toggleKey').onclick = () => { showKey = !showKey; render(); };
    $('#copyKey').onclick = () => copyText(st.apiKey, 'API key');
    $('#copyDocs').onclick = () => copyText(docs, f.label + ' docs');
    $('#regen').onclick = async () => {
      if (!confirm('The old key will stop working. Continue?')) return;
      const r = await api('/api/integration/apikey', { method: 'POST' });
      st.apiKey = r.apiKey;
      toast('New key created');
      render();
    };
  };
  render();
}

// ---------- router ----------
const pages = { dashboard: pageDashboard, test: pageTest, integration: pageIntegration, api: pageApi };

async function route() {
  clearInterval(timer);
  const name = location.hash.slice(1) in pages ? location.hash.slice(1) : 'dashboard';
  document.querySelectorAll('[data-tab]').forEach((a) => a.classList.toggle('on', a.dataset.tab === name));
  try { await pages[name](); }
  catch (e) { toast(e.message, true); }
}

window.addEventListener('hashchange', route);
route();
