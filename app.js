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

// ---------- API docs (instructions for an AI) ----------
const SHARED_DOCS = `You are integrating the FamePay Gateway payment API into my project.
Follow these steps in order. Do not change the payment flow.

BASE URL: __BASE__/api/v1
API KEY: __KEY__
Keep the API key secret. Use it only on the server, never in code that customers can read.

HOW THE PAYMENT WORKS
1. The customer enters an amount, for example 10, and taps Pay.
2. Your server calls POST __BASE__/api/v1/payments with the JSON body {"amount": 10}.
3. Save the returned "id" and "pay_url". Open pay_url in a new tab (or send it to the customer).
4. The pay page shows a QR code for the field "amount" (for example 10.07). The customer must pay that exact amount, not the amount they typed.
5. Every 3 seconds, call GET __BASE__/api/v1/payments/{id} with the header X-API-Key.
6. Stop checking when "status" is "success" or "failed". Also stop after 5 minutes.
7. If status is "success": add "requested_amount" (for example 10) to the customer's balance. Do this only once per id.
8. If status is "failed": add nothing. Tell the customer the payment link expired.

ENDPOINTS
POST __BASE__/api/v1/payments
  Headers: Content-Type: application/json, X-API-Key: __KEY__
  Body: {"amount": 10}
  Response: {"id", "requested_amount", "amount", "status", "pay_url", "expires_at"}

GET __BASE__/api/v1/payments/{id}
  Headers: X-API-Key: __KEY__
  Response: {"id", "requested_amount", "amount", "status", "paid_at"}

STATUS VALUES
- pending: waiting for the customer to pay
- success: paid
- failed: expired or not paid

ERRORS
- 400: invalid amount
- 401: missing or wrong API key
- 403: the gateway owner has not connected Gmail yet
- 404: payment id not found
- 429: too many pending payments for this amount; wait 1 minute and retry

RULES
- Always credit requested_amount. Never credit amount.
- Save every payment id in your database and check it before crediting, so one payment is never credited twice.
- Each payment link expires after 3 minutes.
- Up to 20 payments per base amount can be pending at the same time.
- Show the customer the exact amount to pay (amount) and the result message.
`;

const FW_DOCS = {
  html: {
    label: 'HTML',
    title: 'HTML + JavaScript',
    body: `YOUR TASK: build the payment page in HTML with JavaScript.
Step 1: Create a file named index.html with the code below.
Step 2: Open it in a browser, enter an amount, and tap Pay.
Note: this page exposes the API key to visitors. Use it for testing. For a public site, move the fetch calls to your server (see the PHP docs).

--- FILE: index.html ---
<!DOCTYPE html>
<html>
<body>
<input id="amount" type="number" placeholder="Amount">
<button onclick="pay()">Pay</button>
<p id="msg"></p>
<script>
const BASE = "__BASE__/api/v1";
const KEY = "__KEY__";
const credited = {};
let balance = 0;

async function pay() {
  const amount = Number(document.getElementById("amount").value);
  const msg = document.getElementById("msg");
  const tab = window.open("about:blank", "_blank");
  const r = await fetch(BASE + "/payments", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": KEY },
    body: JSON.stringify({ amount: amount })
  });
  const p = await r.json();
  if (!r.ok) { if (tab) tab.close(); msg.textContent = p.error; return; }
  tab.location.href = p.pay_url;
  msg.textContent = "Pay " + p.amount.toFixed(2) + " in the new tab.";
  watch(p.id);
}

function watch(id) {
  const timer = setInterval(async () => {
    const r = await fetch(BASE + "/payments/" + id, { headers: { "X-API-Key": KEY } });
    const p = await r.json();
    if (p.status === "pending") return;
    clearInterval(timer);
    const msg = document.getElementById("msg");
    if (p.status === "success" && !credited[id]) {
      credited[id] = true;
      balance += p.requested_amount;
      msg.textContent = "Payment received. Added " + p.requested_amount.toFixed(2) + ". Balance: " + balance.toFixed(2);
    } else if (p.status === "failed") {
      msg.textContent = "Payment link expired.";
    }
  }, 3000);
}
</script>
</body>
</html>
--- END FILE ---`,
  },

  php: {
    label: 'PHP',
    title: 'PHP (server side)',
    body: `YOUR TASK: add FamePay to a PHP site. The API key stays on the server.
Step 1: Make sure PHP has the curl extension enabled.
Step 2: Create famepay.php (shared helper).
Step 3: Create create_payment.php. Your page calls it to start a payment.
Step 4: Create check_payment.php. Your page calls it every 3 seconds.
Step 5: Your page: on Pay, call create_payment.php with the amount, open pay_url, then poll check_payment.php?id=... until status is success or failed. On success, add requested_amount to the customer's balance in your database, after checking the id is not already credited.

--- FILE: famepay.php ---
<?php
const FP_BASE = "__BASE__/api/v1";
const FP_KEY = "__KEY__";

function fp_call($method, $path, $body = null) {
    $ch = curl_init(FP_BASE . $path);
    curl_setopt($ch, CURLOPT_CUSTOMREQUEST, $method);
    curl_setopt($ch, CURLOPT_HTTPHEADER, ["Content-Type: application/json", "X-API-Key: " . FP_KEY]);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    if ($body !== null) curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($body));
    $res = curl_exec($ch);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    return [$code, json_decode($res, true)];
}

function fp_create($amount) {
    return fp_call("POST", "/payments", ["amount" => $amount]);
}

function fp_status($id) {
    return fp_call("GET", "/payments/" . urlencode($id));
}
--- END FILE ---

--- FILE: create_payment.php ---
<?php
header("Content-Type: application/json");
require "famepay.php";
$data = json_decode(file_get_contents("php://input"), true);
[$code, $res] = fp_create($data["amount"] ?? 0);
http_response_code($code);
echo json_encode($res);
--- END FILE ---

--- FILE: check_payment.php ---
<?php
header("Content-Type: application/json");
require "famepay.php";
[$code, $res] = fp_status($_GET["id"] ?? "");
http_response_code($code);
echo json_encode($res);
--- END FILE ---

Usage example for your credit step (pseudo code): if status is "success" and the id is not in your processed_payments table, insert the id, then add requested_amount to the balance.`,
  },

  flutter: {
    label: 'Flutter',
    title: 'Flutter (Dart)',
    body: `YOUR TASK: add FamePay to a Flutter app.
Step 1: Run: flutter pub add http url_launcher
Step 2: Create lib/famepay.dart with the code below.
Step 3: On the Pay button, call createPayment(amount), open pay_url with launchUrl, then call waitForPayment(id).
Step 4: If the result status is "success", add requested_amount to the user's balance, once per id.
Note: the API key inside a mobile app can be read by anyone who has the app. For a published app, call your own server, and have the server call FamePay.

--- FILE: lib/famepay.dart ---
import 'dart:convert';
import 'package:http/http.dart' as http;

const String fpBase = '__BASE__/api/v1';
const String fpKey = '__KEY__';

Future<Map<String, dynamic>> createPayment(double amount) async {
  final res = await http.post(
    Uri.parse(fpBase + '/payments'),
    headers: {'Content-Type': 'application/json', 'X-API-Key': fpKey},
    body: jsonEncode({'amount': amount}),
  );
  final data = jsonDecode(res.body) as Map<String, dynamic>;
  if (res.statusCode != 200) throw Exception(data['error'] ?? 'Payment failed');
  return data;
}

Future<Map<String, dynamic>> checkPayment(String id) async {
  final res = await http.get(
    Uri.parse(fpBase + '/payments/' + id),
    headers: {'X-API-Key': fpKey},
  );
  return jsonDecode(res.body) as Map<String, dynamic>;
}

Future<Map<String, dynamic>> waitForPayment(String id) async {
  for (var i = 0; i < 100; i++) {
    await Future.delayed(const Duration(seconds: 3));
    final p = await checkPayment(id);
    if (p['status'] != 'pending') return p;
  }
  return {'status': 'failed'};
}
--- END FILE ---

Usage example:
final p = await createPayment(10);
await launchUrl(Uri.parse(p['pay_url']), mode: LaunchMode.externalApplication);
final result = await waitForPayment(p['id']);
if (result['status'] == 'success') {
  // credit p['requested_amount'] once, using p['id'] to prevent double credit
}`,
  },

  java: {
    label: 'Java',
    title: 'Java (Java 11+)',
    body: `YOUR TASK: add FamePay to a Java project. Use it on the server side.
Step 1: Add the Gson library (com.google.code.gson:gson) to your project.
Step 2: Create FamePay.java with the code below.
Step 3: Call FamePay.createPayment(10). Send pay_url to the customer.
Step 4: Call FamePay.waitForPayment(id). If the status is "success", credit requested_amount once per id.

--- FILE: FamePay.java ---
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;

public class FamePay {
    static final String BASE = "__BASE__/api/v1";
    static final String KEY = "__KEY__";
    static final HttpClient client = HttpClient.newHttpClient();

    public static JsonObject createPayment(double amount) throws Exception {
        String body = "{\\"amount\\": " + amount + "}";
        HttpRequest req = HttpRequest.newBuilder(URI.create(BASE + "/payments"))
            .header("Content-Type", "application/json")
            .header("X-API-Key", KEY)
            .POST(HttpRequest.BodyPublishers.ofString(body))
            .build();
        String text = client.send(req, HttpResponse.BodyHandlers.ofString()).body();
        return JsonParser.parseString(text).getAsJsonObject();
    }

    public static JsonObject checkPayment(String id) throws Exception {
        HttpRequest req = HttpRequest.newBuilder(URI.create(BASE + "/payments/" + id))
            .header("X-API-Key", KEY)
            .GET()
            .build();
        String text = client.send(req, HttpResponse.BodyHandlers.ofString()).body();
        return JsonParser.parseString(text).getAsJsonObject();
    }

    public static JsonObject waitForPayment(String id) throws Exception {
        for (int i = 0; i < 100; i++) {
            Thread.sleep(3000);
            JsonObject p = checkPayment(id);
            if (!p.get("status").getAsString().equals("pending")) return p;
        }
        JsonObject failed = new JsonObject();
        failed.addProperty("status", "failed");
        return failed;
    }
}
--- END FILE ---

Usage example:
JsonObject p = FamePay.createPayment(10);
System.out.println(p.get("pay_url").getAsString());
JsonObject result = FamePay.waitForPayment(p.get("id").getAsString());
if (result.get("status").getAsString().equals("success")) {
    // credit p.get("requested_amount") once, using p.get("id") to prevent double credit
}`,
  },

  kotlin: {
    label: 'Kotlin',
    title: 'Kotlin (Android or JVM)',
    body: `YOUR TASK: add FamePay to a Kotlin app. Run network calls on a background thread (Dispatchers.IO in coroutines), never on the main thread.
Step 1: Create FamePay.kt with the code below. It uses only built-in libraries (org.json is part of Android).
Step 2: Call createPayment(10.0) on a background thread. Open pay_url in a browser.
Step 3: Call waitForPayment(id). If status is "success", credit requested_amount once per id.
Note: the API key inside an app can be read by anyone who has it. For a published app, call your own server, and have the server call FamePay.

--- FILE: FamePay.kt ---
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

const val FP_BASE = "__BASE__/api/v1"
const val FP_KEY = "__KEY__"

fun fpRequest(method: String, path: String, body: String? = null): JSONObject {
    val conn = URL(FP_BASE + path).openConnection() as HttpURLConnection
    conn.requestMethod = method
    conn.setRequestProperty("Content-Type", "application/json")
    conn.setRequestProperty("X-API-Key", FP_KEY)
    if (body != null) {
        conn.doOutput = true
        conn.outputStream.use { it.write(body.toByteArray()) }
    }
    val stream = if (conn.responseCode in 200..299) conn.inputStream else conn.errorStream
    val text = stream.bufferedReader().use { it.readText() }
    return JSONObject(text)
}

fun createPayment(amount: Double): JSONObject =
    fpRequest("POST", "/payments", JSONObject().put("amount", amount).toString())

fun checkPayment(id: String): JSONObject =
    fpRequest("GET", "/payments/" + id)

fun waitForPayment(id: String): JSONObject {
    repeat(100) {
        Thread.sleep(3000)
        val p = checkPayment(id)
        if (p.getString("status") != "pending") return p
    }
    return JSONObject().put("status", "failed")
}
--- END FILE ---

Usage example:
val p = createPayment(10.0)
// open p.getString("pay_url") in a browser
val result = waitForPayment(p.getString("id"))
if (result.getString("status") == "success") {
    // credit p.getDouble("requested_amount") once, using p.getString("id") to prevent double credit
}`,
  },

  python: {
    label: 'Python',
    title: 'Python (Flask or any Python app)',
    body: `YOUR TASK: add FamePay to a Python project. Keep the API key on the server.
Step 1: Install the library: pip install requests
Step 2: Create famepay.py with the code below.
Step 3: Call create_payment(10). Send pay_url to the customer.
Step 4: Call wait_for_payment(id). If the status is "success", credit requested_amount once per id.

--- FILE: famepay.py ---
import time
import requests

BASE = "__BASE__/api/v1"
KEY = "__KEY__"
HEADERS = {"X-API-Key": KEY}

def create_payment(amount):
    r = requests.post(BASE + "/payments", json={"amount": amount}, headers=HEADERS, timeout=15)
    data = r.json()
    if r.status_code != 200:
        raise Exception(data.get("error", "Payment failed"))
    return data

def check_payment(payment_id):
    r = requests.get(BASE + "/payments/" + payment_id, headers=HEADERS, timeout=15)
    return r.json()

def wait_for_payment(payment_id):
    for _ in range(100):
        time.sleep(3)
        p = check_payment(payment_id)
        if p["status"] != "pending":
            return p
    return {"status": "failed"}
--- END FILE ---

Usage example:
p = create_payment(10)
print(p["pay_url"])
result = wait_for_payment(p["id"])
if result["status"] == "success":
    # credit p["requested_amount"] once, using p["id"] to prevent double credit
    pass`,
  },
};

function buildDocs(key, base, apiKey) {
  return (SHARED_DOCS + '\n' + FW_DOCS[key].body)
    .replaceAll('__BASE__', base)
    .replaceAll('__KEY__', apiKey);
}

async function pageApi() {
  const st = await getStatus();
  if (!st.connected)
    return locked('API docs', 'Connect Gmail first. Your API key is created after the inbox connects.');

  const base = location.origin;
  const render = () => {
    const docs = buildDocs(fw, base, st.apiKey);
    const f = FW_DOCS[fw];
    view.innerHTML = `
      <header class="head"><h1>API docs</h1>
        <p class="muted">Copy the docs for your framework and give them to an AI. It will build the payment flow step by step.</p></header>
      <section class="card form">
        <div class="split"><strong>Your API key</strong><button class="btn small ghost" id="regen" type="button">Regenerate</button></div>
        <p class="key">${showKey ? esc(st.apiKey) : MASK}</p>
        <div class="row">
          <button class="btn small" id="toggleKey" type="button">${showKey ? 'Hide' : 'Show'} key</button>
          <button class="btn small" id="copyKey" type="button">Copy key</button>
        </div>
      </section>
      <div class="tabsx">
        ${Object.entries(FW_DOCS).map(([k, v]) =>
          `<button class="btn small ${k === fw ? 'primary' : 'ghost'}" data-fw="${k}" type="button">${v.label}</button>`).join('')}
      </div>
      <section class="card form">
        <h2>${f.title}</h2>
        <button class="btn primary wide" id="copyDocs" type="button">Copy ${f.label} AI docs</button>
        <pre><code>${esc(docs)}</code></pre>
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
