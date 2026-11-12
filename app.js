const $ = (s) => document.querySelector(s);
const view = $('#view');
const MASK = '••••••••••••••••';
const TOKEN_KEY = 'fp_session';
let timer = null;
let range = 'today';
let fw = 'html';
let showKey = false;

const getToken = () => localStorage.getItem(TOKEN_KEY);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => '₹' + Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const when = (t) => new Date(t).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const tile = (label, value, cls) => `<div class="tile ${cls}"><span>${label}</span><strong>${value}</strong></div>`;

async function api(url, options = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (getToken()) headers.Authorization = 'Bearer ' + getToken();
  const res = await fetch(url, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    localStorage.removeItem(TOKEN_KEY);
    showLogin();
    throw new Error('Please sign in again.');
  }
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

const getStatus = () => api('/api/status');

// ---------- sign-in ----------
async function showLogin() {
  clearInterval(timer);
  $('#app').hidden = true;
  $('#login').hidden = false;
  $('#loginNote').textContent = '';
  const cfg = await fetch('/api/config').then((r) => r.json());
  const init = () => {
    google.accounts.id.initialize({ client_id: cfg.googleClientId, callback: onGoogle });
    google.accounts.id.renderButton($('#gbtn'), { theme: 'filled_black', size: 'large', shape: 'pill', text: 'signin_with', width: 280 });
  };
  if (window.google?.accounts) return init();
  const wait = setInterval(() => {
    if (window.google?.accounts) { clearInterval(wait); init(); }
  }, 200);
}

async function onGoogle(resp) {
  try {
    const r = await fetch('/api/auth/google', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential: resp.credential }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error);
    localStorage.setItem(TOKEN_KEY, data.token);
    $('#who').textContent = data.email;
    startApp();
  } catch (e) {
    $('#loginNote').textContent = e.message;
  }
}

function startApp() {
  $('#login').hidden = true;
  $('#app').hidden = false;
  route();
}

$('#logoutBtn').onclick = async () => {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
  localStorage.removeItem(TOKEN_KEY);
  openDrawer(false);
  showLogin();
};

// ---------- drawer (top-left menu) ----------
function openDrawer(open) {
  $('#drawer').classList.toggle('open', open);
  $('#overlay').hidden = !open;
}
$('#menuBtn').onclick = () => openDrawer(true);
$('#overlay').onclick = () => openDrawer(false);
document.querySelectorAll('[data-tab]').forEach((a) => a.addEventListener('click', () => openDrawer(false)));

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

// ---------- API docs: instructions an AI can follow ----------
const SHARED_DOCS = `ROLE
You are adding the FamePay Gateway payment system to the user's project. Follow every rule below exactly. Do not invent endpoints, field names, or URLs. Do not use relative URLs for the gateway.

GATEWAY CONFIG (copy these exactly)
- Base URL: __BASE__/api/v1
- API key: __KEY__
- Every request must send the header: X-API-Key: __KEY__
- Send Content-Type: application/json on every POST.
- The gateway is a SEPARATE server. Never call /api/payments or any path that starts with / on the user's own site. Those point to the wrong server and fail with "File not found" or invalid JSON. Always use the full URL that starts with __BASE__.
- Keep the API key on the server. Never put it in code that a customer can read (HTML, Flutter, or Android apps). The HTML and Flutter examples are for local testing only.

WHAT THE GATEWAY DOES
Each payment has an "id". For every payment the gateway creates a unique payable amount: the requested amount plus 0.01 to 0.20. Example: requested 10 becomes payable 10.07. The customer pays that payable amount by UPI through the QR page. The gateway checks the owner's Gmail for the bank alert with that exact amount, then sets the payment to success.

ENDPOINT 1: CREATE A PAYMENT
Method: POST
URL: __BASE__/payments
Full URL: __BASE__/payments
Headers: Content-Type: application/json, X-API-Key: __KEY__
Body: {"amount": 10}
- amount: number, required, 0.01 to 100000, decimals allowed (49.5 is valid).
Response, HTTP 200:
{
  "id": "a1b2c3d4e5f60718",
  "requested_amount": 10,
  "amount": 10.07,
  "status": "pending",
  "pay_url": "__BASE__/pay.html?id=a1b2c3d4e5f60718",
  "expires_at": 1731400180000
}
Meaning of each field:
- id: save it. It identifies this payment everywhere.
- amount: the EXACT amount the customer must pay. Show this to the customer.
- requested_amount: the amount you credit to the user's balance after success.
- pay_url: open it in a new browser tab or window (or in the app's browser).
- expires_at: Unix time in milliseconds. After this time the payment is failed.

ENDPOINT 2: CHECK A PAYMENT
Method: GET
URL: __BASE__/payments/{id}
Replace {id} with the saved id. No trailing slash.
Headers: X-API-Key: __KEY__
Response, HTTP 200:
{
  "id": "a1b2c3d4e5f60718",
  "requested_amount": 10,
  "amount": 10.07,
  "status": "pending",
  "paid_at": null
}
status values:
- "pending": not paid yet. Keep polling.
- "success": paid. Credit requested_amount once, then stop polling.
- "failed": not paid before expires_at. Credit nothing, then stop polling.
paid_at: Unix milliseconds when the payment succeeded, otherwise null.

POLLING RULES
- Poll every 3 seconds, no faster.
- Stop when status is "success" or "failed".
- Also stop at expires_at + 60 seconds and treat the payment as failed.
- Poll from your server or a background job, not only from the browser. Save the id first, so a page reload can continue checking.

CREDITING RULES (most important)
- Credit requested_amount. Never credit amount.
- Credit only when status is "success".
- Credit each id only once. Store the id with a unique constraint, and use INSERT ... ON CONFLICT DO NOTHING (or INSERT OR IGNORE) before adding the balance. Only add the balance if the insert actually happened.
- Do the insert and the balance update in one database transaction.
- Recommended tables:
  users(id, balance)
  credited_payments(id PRIMARY KEY, user_id, requested_amount, credited_at)

ERRORS
- 400: amount missing or invalid. Show the "error" text to the user.
- 401: X-API-Key missing or wrong. Check the key.
- 403: the gateway owner has not connected Gmail yet. Show "Payment service not ready".
- 404: id not found. Check the saved id.
- 429: too many pending payments for this amount. Wait 1 minute and create again.
- 5xx or network error: retry with a short delay, then show an error.

ORDER OF OPERATIONS IN YOUR APP
1. The user enters an amount and taps Pay.
2. Your server calls ENDPOINT 1 and saves the payment with status "pending".
3. Your server returns amount and pay_url to the client. The client opens pay_url.
4. The customer scans the QR and pays the exact amount.
5. Your server polls ENDPOINT 2 every 3 seconds.
6. On "success": credit requested_amount once, mark the payment done, show "Payment received".
7. On "failed": mark the payment failed, show "Payment expired. Please try again."

TESTING CHECKLIST
1. Create a payment for 10. Confirm amount is between 10.01 and 10.20.
2. Open pay_url. Confirm the QR shows the same amount.
3. Pay that amount. Confirm status becomes "success" within about a minute.
4. Confirm the balance increased by 10 (requested_amount), not by 10.07.
5. Reload the page during polling. Confirm the balance is not credited twice.
`;

const FW_DOCS = {
  html: {
    label: 'HTML',
    title: 'HTML + JavaScript (testing only)',
    body: `YOUR TASK: create one HTML page that starts a payment and checks it.
Step 1: Save the code below as index.html.
Step 2: Open it in a browser, enter an amount, and tap Pay.
Step 3: The balance rule is shown in the code. In production, move the credit to your server (see PHP).

--- FILE: index.html ---
<!DOCTYPE html>
<html>
<body>
<input id="amount" type="number" value="10">
<button onclick="pay()">Pay</button>
<p id="msg"></p>
<script>
const BASE = "__BASE__/api/v1";
const KEY = "__KEY__";
const HEADERS = { "Content-Type": "application/json", "X-API-Key": KEY };
const show = (t) => document.getElementById("msg").textContent = t;

async function pay() {
  const tab = window.open("about:blank", "_blank");
  const amount = Number(document.getElementById("amount").value);
  const r = await fetch(BASE + "/payments", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ amount: amount })
  });
  const p = await r.json();
  if (!r.ok) { tab.close(); return show(p.error); }
  tab.location.href = p.pay_url;
  show("Pay exactly " + p.amount.toFixed(2) + ". Waiting...");
  watch(p.id, p.requested_amount, p.expires_at);
}

function watch(id, requested, expiresAt) {
  const timer = setInterval(async () => {
    if (Date.now() > expiresAt + 60000) { clearInterval(timer); return show("Expired. Nothing credited."); }
    const r = await fetch(BASE + "/payments/" + id, { headers: HEADERS });
    const p = await r.json();
    if (p.status === "pending") return;
    clearInterval(timer);
    if (p.status === "success") show("Success. Credit " + requested.toFixed(2) + " to the user.");
    else show("Failed or expired. Credit nothing.");
  }, 3000);
}
</script>
</body>
</html>
--- END FILE ---`,
  },

  php: {
    label: 'PHP',
    title: 'PHP (recommended for real websites)',
    body: `YOUR TASK: add FamePay to a PHP website. The API key stays on the server.
Step 1: Enable the PHP curl and pdo_sqlite extensions.
Step 2: Create famepay.php (gateway helper).
Step 3: Create create_payment.php. Your page calls it to start a payment.
Step 4: Create check_payment.php. Your page calls it every 3 seconds with the payment id.
Step 5: Create credit.php and call it only when status is "success".

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
--- END FILE ---

--- FILE: create_payment.php ---
<?php
require "famepay.php";
header("Content-Type: application/json");
$body = json_decode(file_get_contents("php://input"), true);
[$code, $res] = fp_call("POST", "/payments", ["amount" => (float)($body["amount"] ?? 0)]);
http_response_code($code);
echo json_encode($res);
--- END FILE ---

--- FILE: check_payment.php ---
<?php
require "famepay.php";
header("Content-Type: application/json");
[$code, $res] = fp_call("GET", "/payments/" . urlencode($_GET["id"] ?? ""));
http_response_code($code);
echo json_encode($res);
--- END FILE ---

--- FILE: credit.php ---
<?php
// Call this ONLY when check_payment returned status "success".
// Credits requested_amount exactly once per payment id.
function credit_once(PDO $pdo, string $userId, array $payment): bool {
    $pdo->beginTransaction();
    $ins = $pdo->prepare("INSERT OR IGNORE INTO credited_payments (id, user_id, requested_amount) VALUES (?, ?, ?)");
    $ins->execute([$payment["id"], $userId, $payment["requested_amount"]]);
    if ($ins->rowCount() === 1) {
        $pdo->prepare("UPDATE users SET balance = balance + ? WHERE id = ?")
            ->execute([$payment["requested_amount"], $userId]);
        $pdo->commit();
        return true;
    }
    $pdo->rollBack();
    return false; // already credited
}
--- END FILE ---

Browser side: POST to your own create_payment.php with {"amount": 10}, open the returned pay_url, then poll your own check_payment.php?id=... every 3 seconds. When status is "success", your server calls credit_once(). Never call the gateway URL from the browser in production.`,
  },

  flutter: {
    label: 'Flutter',
    title: 'Flutter (Dart)',
    body: `YOUR TASK: add FamePay to a Flutter app.
Step 1: Run: flutter pub add http url_launcher
Step 2: Create lib/famepay.dart with the code below.
Step 3: On the Pay button, call createPayment(10), open pay_url with launchUrl, then call waitForPayment(id).
Step 4: If the result status is "success", credit requested_amount once for that id. Do this on your backend when possible.
Note: a key inside a published app can be read by anyone. For a released app, have your own server call FamePay.

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

Future<Map<String, dynamic>> waitForPayment(String id, DateTime expiresAt) async {
  while (DateTime.now().isBefore(expiresAt.add(const Duration(seconds: 60)))) {
    await Future.delayed(const Duration(seconds: 3));
    final p = await checkPayment(id);
    if (p['status'] != 'pending') return p;
  }
  return {'status': 'failed'};
}
--- END FILE ---

Usage:
final p = await createPayment(10);
await launchUrl(Uri.parse(p['pay_url']), mode: LaunchMode.externalApplication);
final expires = DateTime.fromMillisecondsSinceEpoch(p['expires_at']);
final result = await waitForPayment(p['id'], expires);
if (result['status'] == 'success') {
  // credit p['requested_amount'] once per p['id']
}`,
  },

  java: {
    label: 'Java',
    title: 'Java (Java 11+ and Gson)',
    body: `YOUR TASK: add FamePay to a Java server or desktop app.
Step 1: Add the Gson dependency (com.google.code.gson:gson).
Step 2: Create FamePay.java with the code below.
Step 3: Call FamePay.createPayment(10). Send pay_url to the customer.
Step 4: Call FamePay.waitForPayment(id, expiresAtMillis). If status is "success", credit requested_amount once per id, using a database unique constraint on id.

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
        return parse(client.send(req, HttpResponse.BodyHandlers.ofString()).body());
    }

    public static JsonObject checkPayment(String id) throws Exception {
        HttpRequest req = HttpRequest.newBuilder(URI.create(BASE + "/payments/" + id))
            .header("X-API-Key", KEY)
            .GET()
            .build();
        return parse(client.send(req, HttpResponse.BodyHandlers.ofString()).body());
    }

    public static JsonObject waitForPayment(String id, long expiresAtMillis) throws Exception {
        while (System.currentTimeMillis() < expiresAtMillis + 60000) {
            Thread.sleep(3000);
            JsonObject p = checkPayment(id);
            if (!p.get("status").getAsString().equals("pending")) return p;
        }
        JsonObject failed = new JsonObject();
        failed.addProperty("status", "failed");
        return failed;
    }

    static JsonObject parse(String text) {
        return JsonParser.parseString(text).getAsJsonObject();
    }
}
--- END FILE ---

Usage:
JsonObject p = FamePay.createPayment(10);
System.out.println("Open: " + p.get("pay_url").getAsString());
JsonObject r = FamePay.waitForPayment(p.get("id").getAsString(), p.get("expires_at").getAsLong());
if (r.get("status").getAsString().equals("success")) {
    // credit p.get("requested_amount") once per p.get("id")
}`,
  },

  kotlin: {
    label: 'Kotlin',
    title: 'Kotlin (Android or JVM)',
    body: `YOUR TASK: add FamePay to a Kotlin app. Run network calls off the main thread (Dispatchers.IO in coroutines).
Step 1: Create FamePay.kt with the code below. It uses only built-in libraries (org.json is part of Android).
Step 2: Call createPayment(10.0) on a background thread. Open pay_url in a browser.
Step 3: Call waitForPayment(id, expiresAt). If status is "success", credit requested_amount once per id.
Note: an app's API key can be extracted. For a released app, have your own server call FamePay.

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
    return JSONObject(stream.bufferedReader().use { it.readText() })
}

fun createPayment(amount: Double): JSONObject =
    fpRequest("POST", "/payments", JSONObject().put("amount", amount).toString())

fun checkPayment(id: String): JSONObject = fpRequest("GET", "/payments/" + id)

fun waitForPayment(id: String, expiresAtMillis: Long): JSONObject {
    while (System.currentTimeMillis() < expiresAtMillis + 60000) {
        Thread.sleep(3000)
        val p = checkPayment(id)
        if (p.getString("status") != "pending") return p
    }
    return JSONObject().put("status", "failed")
}
--- END FILE ---

Usage:
val p = createPayment(10.0)
// open p.getString("pay_url") in a browser
val result = waitForPayment(p.getString("id"), p.getLong("expires_at"))
if (result.getString("status") == "success") {
    // credit p.getDouble("requested_amount") once per p.getString("id")
}`,
  },

  python: {
    label: 'Python',
    title: 'Python (Flask, Django, or scripts)',
    body: `YOUR TASK: add FamePay to a Python project. Keep the API key on the server.
Step 1: Run: pip install requests
Step 2: Create famepay.py with the code below.
Step 3: Call create_payment(10). Send pay_url to the customer.
Step 4: Call wait_for_payment(id, expires_at). If status is "success", credit requested_amount once per id.

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

def wait_for_payment(payment_id, expires_at_ms):
    while time.time() * 1000 < expires_at_ms + 60000:
        time.sleep(3)
        p = check_payment(payment_id)
        if p["status"] != "pending":
            return p
    return {"status": "failed"}
--- END FILE ---

Usage:
p = create_payment(10)
print(p["pay_url"])
result = wait_for_payment(p["id"], p["expires_at"])
if result["status"] == "success":
    # credit p["requested_amount"] once per p["id"]
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
        <p class="muted">Copy the docs for your framework and give them to an AI. The docs contain the exact URLs, requests, responses, and rules.</p></header>
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

async function boot() {
  if (!getToken()) return showLogin();
  try {
    const st = await getStatus();
    $('#who').textContent = st.email || '';
    startApp();
  } catch {
    showLogin();
  }
}
boot();
