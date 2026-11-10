/**
 * cod-pre-register-payment-worker  (v2.9.0 — تاب المعلّقة منفصل عن المحصّلة + المندوب الحالي من شوبيفاي + حذف سجل «اتمسح»)
 *
 * skills: ecommoda-worker-builder v3.7.1 · ecommoda-constants v3.1.0 ·
 *         shopify-graphql-helper v1.0.0 · ecommoda-tool-migration-playbook (01-09-2026)
 *
 * Env bindings required:
 *   WORKER_SECRET  — secret للحماية (Bearer)
 *   SHOP_DOMAIN, CLIENT_ID, CLIENT_SECRET — Shopify OAuth
 *   DB             — D1 binding → ecommoda-dev-logs (نفس القاعدة المشتركة)
 *   PRE_REG_KV     — KV namespace — لسه هنا بنفس الغرض (حالة "معلّق" مؤقتة،
 *                    مش لوج — فده استخدام KV الصح أصلاً، مفيش داعي ينتقل لـ D1)
 *
 * Actions:
 *   resolveByName  – order number → numeric ID
 *   preview        – fetch order data (+ بيانات العميل للعرض فقط) + فحص KV
 *   preRegister    – mark as paid on Shopify + save KV + set metafield + D1 log
 *   checkPending / clearPending / listPending — API لـ cod-payment-center-worker
 *   pending_details – (GET · قراءة بس) KV + D1 (تسجيل + تحصيل) + شوبيفاي الحية — scope=pending|collected (تابين منفصلين)
 *   delete_preregister – (POST · **حذف فعلي من D1**) صفوف التسجيل المسبق لأوردر حالته «اتمسح بدون تحصيل مسجّل» بس — بيتحقق من PIN الموظف
 *   check_employee / register_pin / verify_employee / log_logout / get_employees — Universal D1 Auth
 *   get_logs / get_logs_count / get_logs_export / get_logs_facets — tool=cod_preregister
 *   diag / get_config — فحص ذاتي + نسخة الـ Worker (إلزاميان لأي Worker بيكتب)
 *
 * D1: tool = 'cod_preregister' | type = 'preregister' / 'login' / 'logout'
 */

// ══════════════════════════════════════════════════════
// §CONSTANTS
// ══════════════════════════════════════════════════════
const TOOL_NAME      = 'cod_preregister';
const WORKER_VERSION = '2.9.0';

// ══════════════════════════════════════════════════════
// §CORS
// ══════════════════════════════════════════════════════
// دومين واحد — ecommoda24.github.io و ahmedibraheemsb.github.io اتشالوا
// (ecommoda-constants §11 بندي 10 و11). القيمة [0] كمان هي fallback الـ CORS،
// فوجود دومين مهجور فيها كان بيدّي ترويسة CORS بدومين ميت لأي origin غير معروف.
const ALLOWED_ORIGINS = [
  'https://ecommoda-dev.github.io',
];
function getCORS(request) {
  const origin  = request.headers.get('Origin') || '';
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin':  allowed,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Vary': 'Origin',
  };
}

// ══════════════════════════════════════════════════════
// §HELPERS
// ══════════════════════════════════════════════════════
function json(data, status = 200, request = null) {
  const headers = { 'Content-Type': 'application/json' };
  Object.assign(headers, request ? getCORS(request) : { 'Access-Control-Allow-Origin': ALLOWED_ORIGINS[0] });
  return new Response(JSON.stringify(data), { status, headers });
}

// ══════════════════════════════════════════════════════
// §SHARED — copy verbatim — never modify
// ══════════════════════════════════════════════════════
async function verifyEmployee(db, username, pin) {
  const row = await db.prepare(
    'SELECT display_name, is_active FROM employees WHERE username = ? AND pin = ?'
  ).bind(username, pin).first();

  if (!row) return null;
  if (!row.is_active) throw new Error('الحساب موقوف — تواصل مع المسؤول');

  db.prepare('UPDATE employees SET last_login = ? WHERE username = ?')
    .bind(new Date().toISOString(), username)
    .run()
    .catch(() => {});

  return row.display_name;
}

async function checkEmployee(db, username) {
  const row = await db.prepare(
    'SELECT is_active, pin FROM employees WHERE username = ?'
  ).bind(username).first();

  if (!row) return { exists: false, hasPin: false, isActive: false };
  return { exists: true, hasPin: !!row.pin, isActive: !!row.is_active };
}

async function registerPin(db, username, pin) {
  const row = await db.prepare(
    'SELECT pin, is_active FROM employees WHERE username = ?'
  ).bind(username).first();

  if (!row)           throw new Error('اسم المستخدم غير موجود');
  if (!row.is_active) throw new Error('الحساب موقوف — تواصل مع المسؤول');
  if (row.pin)        throw new Error('هذا المستخدم مسجّل بالفعل — تواصل مع المسؤول لإعادة الضبط');

  await db.prepare('UPDATE employees SET pin = ? WHERE username = ?').bind(pin, username).run();
  return true;
}

// ══════════════════════════════════════════════════════
// §LOG-REG — الحارس الديناميكي لقيم اللوج (الطبقة ٥، ecommoda-worker-builder Step 7-ج)
// ══════════════════════════════════════════════════════
// قطعة الأداة دي بس من log-values.json اللي جنبها — بتتحدّث معاه في نفس الـ
// commit. الأداة دي بتكتب (tool, type) واحد بس (cod_preregister) — مفيش
// كاتب تاني ومفيش writeLogsBatch.
const LOG_REGISTRY = {
  cod_preregister: new Set(['login', 'logout', 'preregister']),
};

const isRegisteredLogValue = (tool, type) => !!LOG_REGISTRY[tool]?.has(type);

// UPSERT على (source_tool, tool, type) — صف واحد لكل قيمة، hits بيعدّ.
// الحدث الكامل مش بيضيع: الصف الأصلي موجود في logs وعليه _unregistered،
// والجدول ده فهرس مش سجل تاني — عشان كده dedupe مش صف لكل حدث.
const LOG_ALERT_SQL = `
  INSERT INTO log_value_alerts
    (source_tool, tool, type, first_seen, last_seen, hits,
     worker_version, sample_order_name, sample_employee, sample_notes)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(source_tool, tool, type) DO UPDATE SET
    last_seen         = excluded.last_seen,
    hits              = log_value_alerts.hits + excluded.hits,
    worker_version    = excluded.worker_version,
    sample_order_name = excluded.sample_order_name,
    sample_employee   = excluded.sample_employee,
    sample_notes      = excluded.sample_notes,
    status            = CASE WHEN log_value_alerts.status = 'ignored'
                             THEN 'ignored' ELSE 'open' END
`;

// فشل التنبيه ممنوع يأثر على أي حاجة — try/catch صامت.
async function noteUnregisteredLogValues(db, entries) {
  const byPair = new Map();
  for (const e of entries) {
    const key = `${e.tool}\u0000${e.type}`;
    const acc = byPair.get(key);
    if (acc) { acc.hits++; continue; }
    byPair.set(key, { entry: e, hits: 1 });
  }
  const now = new Date().toISOString();
  for (const { entry, hits } of byPair.values()) {
    try {
      await db.prepare(LOG_ALERT_SQL).bind(
        TOOL_NAME, entry.tool ?? '(بدون tool)', entry.type ?? '(بدون type)',
        now, now, hits, WORKER_VERSION ?? null,
        entry.orderName ?? null, entry.employee ?? null,
        entry.notes ? String(entry.notes).slice(0, 200) : null,
      ).run();
    } catch (e) { /* متعمّد: التنبيه فهرس، وفشله أهون من تعطيل الأداة */ }
  }
}

async function writeLog(db, entry) {
  const unregistered = !isRegisteredLogValue(entry.tool, entry.type);
  const extra = unregistered
    ? { ...(entry.extra || {}), _unregistered: true }
    : entry.extra;

  await db.prepare(`
    INSERT INTO logs
      (timestamp, tool, type, employee, order_id, order_name,
       sku, product_title, delta, value_before, value_after, notes, extra)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    entry.timestamp    ?? new Date().toISOString(),
    entry.tool,
    entry.type,
    entry.employee     ?? null,
    entry.orderId      ?? null,
    entry.orderName    ?? null,
    entry.sku          ?? null,
    entry.productTitle ?? null,
    entry.delta        ?? null,
    entry.valueBefore  ?? null,
    entry.valueAfter   ?? null,
    entry.notes        ?? null,
    extra ? JSON.stringify(extra) : null
  ).run();

  if (unregistered) await noteUnregisteredLogValues(db, [entry]);   // بعد الكتابة، مش قبلها
}

const LOG_EXPORT_MAX = 2000;   // سقف التصدير — بيرجع للواجهة كـ `cap`

/**
 * بنّاء شرط الفلترة الموحّد للسجل — التلات دوال تحته بيستخدموه.
 * القوايم (employees/types/results) والقيمة المفردة (employee/type) الاتنين مقبولين.
 * v2.7.0 (فلاتر رأس العمود): `orders` (أرقام — OR) · `amountFrom/To` · `results`.
 * ⚠️ dateFrom/dateTo = **يوم بتوقيت القاهرة** (من أول اليوم لأول اللي بعده، حدود
 * محسوبة بـ Intl مش إزاحة ثابتة) — نفس يوم العرض في الواجهة. كانت بتقارن substr
 * الـ UTC وعملية بعد ٩/١٠ مساءً كانت بتقع في اليوم اللي بعده.
 */
// نتيجة العملية من extra JSON: success | warning | none (صفوف قبل v2.1.0 مالهاش الحقل)
const LOG_RESULT_SQL = `COALESCE(CASE WHEN json_valid(extra) THEN json_extract(extra, '$.result') END, 'none')`;
const LOG_RESULT_VALUES = ['success', 'warning', 'none'];

function cairoMidnightUTC(day) {   // 'YYYY-MM-DD' → ISO بتاع أول لحظة في اليوم ده بالقاهرة
  const [y, m, d] = day.split('-').map(Number);
  for (const off of [3, 2]) {      // التوقيت الصيفي (+3) أو الشتوي (+2)
    const t = new Date(Date.UTC(y, m - 1, d) - off * 3600 * 1000);
    const p = cairoParts(t);
    if (`${p.year}-${p.month}-${p.day}` === day && p.hour === '00' && p.minute === '00') return t.toISOString();
  }
  return new Date(Date.UTC(y, m - 1, d) - 2 * 3600 * 1000).toISOString();
}

function buildLogFilterSQL(select, {
  tool      = null,
  employee  = null, employees = null,
  type      = null, types     = null,
  results   = null,
  orders    = null,
  amountFrom = null, amountTo = null,
  search    = null,
  dateFrom  = null, dateTo    = null,
} = {}) {
  let sql = `${select} FROM logs WHERE type NOT IN ('login','logout')`;
  const b = [];

  const emps = Array.isArray(employees) && employees.length ? employees : (employee ? [employee] : []);
  const typs = Array.isArray(types)     && types.length     ? types     : (type     ? [type]     : []);

  if (tool) { sql += ' AND tool = ?'; b.push(tool); }
  if (emps.length) {
    sql += ` AND employee IN (${emps.map(() => '?').join(',')})`; b.push(...emps);
  }
  if (typs.length) {
    sql += ` AND type IN (${typs.map(() => '?').join(',')})`; b.push(...typs);
  }
  if (Array.isArray(results) && results.length) {
    sql += ` AND ${LOG_RESULT_SQL} IN (${results.map(() => '?').join(',')})`; b.push(...results);
  }
  if (Array.isArray(orders) && orders.length) {   // أرقام بس — أي واحد منهم (OR)
    sql += ` AND (${orders.map(() => 'order_name LIKE ?').join(' OR ')})`;
    b.push(...orders.map(t => `%${t}%`));
  }
  if (Number.isFinite(amountFrom)) { sql += ' AND value_after >= ?'; b.push(amountFrom); }
  if (Number.isFinite(amountTo))   { sql += ' AND value_after <= ?'; b.push(amountTo); }
  if (search) {
    sql += ' AND (order_name LIKE ? OR notes LIKE ?)';
    b.push(`%${search}%`, `%${search}%`);
  }
  if (dateFrom) { sql += ' AND timestamp >= ?'; b.push(cairoMidnightUTC(dateFrom)); }
  if (dateTo) {
    const [y, m, d] = dateTo.split('-').map(Number);
    sql += ' AND timestamp < ?'; b.push(cairoMidnightUTC(new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10)));
  }

  return { sql, b };
}

// ⚠️ whitelist إجباري — الترتيب بيتحقن في SQL، فأي قيمة من المستخدم ممنوعة.
// الأعمدة اللي مش في الجدول (المندوب مثلاً — جوه extra JSON) مش قابلة للترتيب
// server-side، وعشان كده مش موجودة هنا ولا `sortable-th` في الواجهة.
const LOG_SORT_COLUMNS = {
  timestamp:   'timestamp',
  employee:    'employee',
  order_name:  'order_name',
  value_after: 'value_after',
};

/**
 * الترتيب server-side مش client-side — السجل مقسّم صفحات، والترتيب على
 * الصفحة المعروضة بس بيدّي ترتيب كذّاب (الصف الأكبر ممكن يكون في صفحة تانية).
 */
async function getLogs(db, { limit = 100, offset = 0, sortKey = null, sortDir = 'desc', ...filters } = {}) {
  const { sql, b } = buildLogFilterSQL('SELECT *', filters);
  const col = LOG_SORT_COLUMNS[sortKey] || 'timestamp';
  const dir = String(sortDir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const q = `${sql} ORDER BY ${col} ${dir}, timestamp DESC LIMIT ? OFFSET ?`;
  return (await db.prepare(q)
    .bind(...b, Math.min(limit, 100), Math.max(offset, 0)).all()).results;
}

async function getLogsCount(db, filters = {}) {
  const { sql, b } = buildLogFilterSQL('SELECT COUNT(*) as total', filters);
  const row = await db.prepare(sql).bind(...b).first();
  return row?.total ?? 0;
}

/**
 * عدّاد كل قيمة في قوايم فلاتر رأس العمود (الموظف · النتيجة) — كل facet بيتعدّ
 * على الصفوف المطابقة لكل الفلاتر **التانية** (مش الفلتر نفسه)، فالرقم جنب القيمة
 * بيقول «هتجيب كام لو اخترتها».
 */
async function getLogsFacets(db, filters = {}) {
  const e = buildLogFilterSQL('SELECT employee AS v, COUNT(*) AS c', { ...filters, employee: null, employees: null });
  const r = buildLogFilterSQL(`SELECT ${LOG_RESULT_SQL} AS v, COUNT(*) AS c`, { ...filters, results: null });
  const [er, rr] = await Promise.all([
    db.prepare(e.sql + ' AND employee IS NOT NULL GROUP BY employee').bind(...e.b).all(),
    db.prepare(r.sql + ' GROUP BY v').bind(...r.b).all(),
  ]);
  const out = { employee: {}, result: {} };
  LOG_RESULT_VALUES.forEach(v => { out.result[v] = 0; });
  (er.results || []).forEach(x => { out.employee[x.v] = x.c; });
  (rr.results || []).forEach(x => { out.result[x.v] = x.c; });
  return out;
}

/**
 * ⚠️ بتقص عند LOG_EXPORT_MAX في السكوت — الـ endpoint لازم يرجّع
 * cap/total/truncated معاها، وإلا الواجهة بتقول "تم التصدير ✓" على ملف ناقص.
 */
async function getLogsExport(db, filters = {}) {
  const { sql, b } = buildLogFilterSQL('SELECT *', filters);
  const q = sql + ' ORDER BY timestamp DESC LIMIT ?';
  return (await db.prepare(q).bind(...b, LOG_EXPORT_MAX).all()).results;
}

/**
 * مصدر واحد لقراءة فلاتر السجل من الـ query string — CSV للقوايم
 * (employees=ahmed,sara · types=preregister). الاسم المفرد لسه مقبول.
 * التلات endpoints بتستخدمه، فمفيش endpoint بيفلتر بشكل مختلف عن اللي جنبه
 * (وده بالظبط اللي بيخلي التصدير ينزّل غير المعروض).
 */
function logParamsFrom(url, tool) {
  const csv = (k) => (url.searchParams.get(k) || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  const employees = csv('employees'), types = csv('types');
  return {
    tool,
    employees: employees.length ? employees : null,
    employee:  url.searchParams.get('employee') || null,
    types:     types.length ? types : null,
    results:   csv('results').filter(v => LOG_RESULT_VALUES.includes(v)).length
                 ? csv('results').filter(v => LOG_RESULT_VALUES.includes(v)) : null,
    orders:    csv('orders').map(t => t.replace(/\D/g, '')).filter(Boolean).length
                 ? csv('orders').map(t => t.replace(/\D/g, '')).filter(Boolean) : null,
    amountFrom: url.searchParams.get('amountFrom') ? Number(url.searchParams.get('amountFrom')) : null,
    amountTo:   url.searchParams.get('amountTo')   ? Number(url.searchParams.get('amountTo'))   : null,
    // ملحوظة: sortKey/sortDir مش فلاتر — بيتقروا في get_logs لوحدها
    type:      url.searchParams.get('type')     || null,
    search:    url.searchParams.get('search')   || null,
    dateFrom:  url.searchParams.get('dateFrom') || null,
    dateTo:    url.searchParams.get('dateTo')   || null,
  };
}

// ══════════════════════════════════════════════════════
// §SHOPIFY
// ══════════════════════════════════════════════════════

// ─── §SHOPIFY::getAccessToken ───
// بترمي برسالة واضحة بدل ما ترجّع null — الـ null كان بيوصل للنداء اللي بعده
// ويطلع "Failed to get Shopify access token" من غير أي سبب.
async function getAccessToken(env) {
  let res, text;
  try {
    res = await fetch(`https://${env.SHOP_DOMAIN}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'client_credentials',
        client_id:     env.CLIENT_ID,
        client_secret: env.CLIENT_SECRET,
      }),
    });
    text = await res.text();
  } catch (e) {
    throw new Error(`OAuth: فشل الاتصال بشوبيفاي — ${e.message}`);
  }
  if (!res.ok) throw new Error(`OAuth: شوبيفاي ردّت HTTP ${res.status} — ${text.slice(0, 180)}`);

  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error(`OAuth: رد شوبيفاي مش JSON صالح — ${text.slice(0, 180)}`); }

  if (!data.access_token) throw new Error('OAuth: مفيش access_token في الرد — راجع CLIENT_ID و CLIENT_SECRET');
  return data.access_token;
}

// ─── §SHOPIFY::shopifyGQL — العقد الإلزامي، منسوخة كما هي من السكيل ───
// أي فشل بيترمي. مفيش رد بيعدّي وهو فاشل:
//   ① فشل شبكة  ② HTTP status  ③ رد مش JSON  ④ data.errors  ⑤ data فاضية
// ⚠️ ④ هو الخطير: ميوتيشن مرفوضة على مستوى الحقل (صلاحية ناقصة مثلاً) بترجع
// {"errors":[…],"data":null} — والـ userErrors بتبقى [] لأن مفيش payload أصلاً.
// كود بيفحص userErrors بس بيقرا ده **نجاح**.
async function shopifyGQL(env, token, query, variables = {}, opName = 'shopify') {
  const MAX_ATTEMPTS = 3;
  let lastErr = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let resp, text;
    try {
      resp = await fetch(`https://${env.SHOP_DOMAIN}/admin/api/2026-01/graphql.json`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
        body:    JSON.stringify({ query, variables }),
      });
      text = await resp.text();
    } catch (e) {
      lastErr = new Error(`${opName}: فشل الاتصال بشوبيفاي — ${e.message}`);
      if (attempt < MAX_ATTEMPTS) { await new Promise(r => setTimeout(r, 400 * attempt)); continue; }
      throw lastErr;
    }

    if (!resp.ok) {
      const retriable = resp.status === 429 || resp.status >= 500;
      lastErr = new Error(`${opName}: شوبيفاي ردّت HTTP ${resp.status} — ${text.slice(0, 180)}`);
      if (retriable && attempt < MAX_ATTEMPTS) { await new Promise(r => setTimeout(r, 700 * attempt)); continue; }
      throw lastErr;
    }

    let data;
    try { data = JSON.parse(text); }
    catch { throw new Error(`${opName}: رد شوبيفاي مش JSON صالح — ${text.slice(0, 180)}`); }

    if (Array.isArray(data.errors) && data.errors.length) {
      const codes = data.errors.map(e => e?.extensions?.code).filter(Boolean);
      lastErr = new Error(
        `${opName}: ${data.errors.map(e => e.message).join(' | ')}` +
        (codes.length ? ` [${codes.join(',')}]` : '')
      );
      if (codes.includes('THROTTLED') && attempt < MAX_ATTEMPTS) {
        await new Promise(r => setTimeout(r, 1200 * attempt)); continue;
      }
      throw lastErr;
    }

    if (!data.data) throw new Error(`${opName}: رد شوبيفاي بدون data — ${text.slice(0, 180)}`);
    return data;
  }
  throw lastErr || new Error(`${opName}: فشل غير معروف`);
}

// ─── §HELPERS::assertEnv ───
// متغير ناقص لازم يوقف العملية برسالة باسمه. SHOP_DOMAIN الناقص بيتحوّل لـ
// https://undefined/... وبيرجّع "error code: 1003 is not valid JSON".
const ENV_REQUIRED = {
  shopify: ['SHOP_DOMAIN', 'CLIENT_ID', 'CLIENT_SECRET'],
};

function assertEnv(env, ...groups) {
  const missing = [];
  for (const g of groups) {
    for (const key of (ENV_REQUIRED[g] || [])) {
      if (env[key] === undefined || env[key] === null || String(env[key]).trim() === '') missing.push(key);
    }
  }
  if (!env.DB)         missing.push('DB (D1 binding)');
  if (!env.PRE_REG_KV) missing.push('PRE_REG_KV (KV binding)');
  if (missing.length) {
    throw new Error(
      `متغيرات ناقصة في الـ Worker: ${missing.join('، ')} — ضِفها من ` +
      `Dashboard → Settings → Variables ثم Promote النسخة. (شغّل ?action=diag)`
    );
  }
}

async function getOrderDataById(env, numericId) {
  const token = await getAccessToken(env);
  if (!token) throw new Error('Failed to get Shopify access token');

  const query = `
    query getOrderById($id: ID!) {
      order(id: $id) {
        id name canMarkAsPaid displayFinancialStatus
        phone
        customer { displayName phone }
        shippingAddress { name phone }
        totalOutstandingSet { shopMoney { amount } }
        subtotalPriceSet    { shopMoney { amount } }
        shippingLine { originalPriceSet { shopMoney { amount } } }
        courierMeta: metafield(namespace: "custom", key: "courier") { value }
        lineItems(first: 50) {
          nodes {
            sku quantity currentQuantity name
            discountedUnitPriceSet { shopMoney { amount } }
            discountedTotalSet     { shopMoney { amount } }
          }
        }
      }
    }
  `;

  const data  = await shopifyGQL(env, token, query, { id: `gid://shopify/Order/${numericId}` }, 'getOrderById');
  const order = data?.data?.order;
  if (!order) return null;   // ← دلوقتي دي "الأوردر مش موجود" فعلاً، مش فشل مقنّع

  const outstanding    = parseFloat(order.totalOutstandingSet?.shopMoney?.amount || '0');
  const subtotal       = parseFloat(order.subtotalPriceSet?.shopMoney?.amount || '0');
  const shippingAmount = parseFloat(order.shippingLine?.originalPriceSet?.shopMoney?.amount || '0');
  const canMarkAsPaid  = order.canMarkAsPaid;
  const financialStatus = order.displayFinancialStatus;
  const courier        = order.courierMeta?.value || null;

  // بيانات العميل — للعرض في الواجهة **بس**. ⛔ ممنوع تدخل writeLog أو extra:
  // السجل بيتصدّر XLSX وبيتقرا من أدوات تانية، والبيانات دي شخصية.
  // محتاجة صلاحية read_customers على تطبيق شوبيفاي (اتأكد بـ ?action=diag).
  const customerName  = order.customer?.displayName || order.shippingAddress?.name  || null;
  const customerPhone = order.shippingAddress?.phone || order.customer?.phone || order.phone || null;

  const lineItems = (order.lineItems?.nodes || [])
    .filter(li => li.sku && li.currentQuantity > 0)
    .map(li => ({
      sku:        li.sku,
      quantity:   li.currentQuantity,
      name:       li.name,
      unitPrice:  parseFloat(li.discountedUnitPriceSet?.shopMoney?.amount || '0').toFixed(2),
      totalPrice: parseFloat(li.discountedTotalSet?.shopMoney?.amount || '0').toFixed(2),
    }));

  let skipReason = null;
  if (!canMarkAsPaid) {
    if (outstanding < 0)                                    skipReason = 'مستحق استرداد';
    else if (outstanding === 0 || financialStatus === 'PAID') skipReason = 'مدفوع بالكامل';
    else                                                    skipReason = `لا يمكن الدفع (${financialStatus})`;
  }

  return {
    orderName:      order.name,
    outstanding:    outstanding.toFixed(2),
    subtotal:       subtotal.toFixed(2),
    shippingAmount: shippingAmount.toFixed(2),
    canMarkAsPaid,
    skipReason,
    financialStatus,
    courier,
    customerName,
    customerPhone,
    lineItems,
  };
}

async function getOrderIdByName(env, orderNumber) {
  const token = await getAccessToken(env);
  if (!token) throw new Error('Failed to get Shopify access token');

  const query = `
    query getOrderByNumber($query: String!) {
      orders(first: 1, query: $query) { nodes { id name } }
    }
  `;
  const data   = await shopifyGQL(env, token, query, { query: `name:#${orderNumber}` }, 'getOrderByName');
  const orders = data?.data?.orders?.nodes;
  if (!orders || orders.length === 0) return null;
  return orders[0].id.replace('gid://shopify/Order/', '');
}

async function createTransaction(token, env, numericOrderId, amount) {
  const res = await fetch(
    `https://${env.SHOP_DOMAIN}/admin/api/2026-01/orders/${numericOrderId}/transactions.json`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
      body: JSON.stringify({
        transaction: { kind: 'capture', status: 'success', amount, currency: 'EGP', gateway: 'manual' },
      }),
    }
  );
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); }
  catch { return { success: false, error: `رد شوبيفاي مش JSON صالح — ${text.slice(0, 180)}` }; }

  // تأكيد الـ payload — مش الاكتفاء بـ res.ok
  if (res.ok && data.transaction?.id) return { success: true, transactionId: data.transaction.id };
  return { success: false, error: data.errors ? JSON.stringify(data.errors) : `HTTP ${res.status} — ${text.slice(0, 180)}` };
}

async function setPreRegMetafield(token, env, numericId) {
  const mutation = `
    mutation setMetafield($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id }
        userErrors { field message }
      }
    }
  `;
  // ① top-level errors بترمي من جوه shopifyGQL
  const data = await shopifyGQL(env, token, mutation, {
    metafields: [{
      ownerId:   `gid://shopify/Order/${numericId}`,
      namespace: 'custom',
      key:       'pre_register_payment',
      value:     'Pre-Registered Payment',
      type:      'single_line_text_field',
    }],
  }, 'metafieldsSet');

  const result = data?.data?.metafieldsSet;
  // ② userErrors
  const errors = result?.userErrors || [];
  if (errors.length) throw new Error('metafieldsSet: ' + errors.map(e => e.message).join(' | '));
  // ③ تأكيد الـ payload — userErrors فاضية معناها "مفيش اعتراض" مش "اتنفّذت"
  if (!result?.metafields?.length) throw new Error('metafieldsSet: شوبيفاي ما أكدتش كتابة الميتافيلد');
}

// ══════════════════════════════════════════════════════
// §PENDING-DETAILS — تاب «المعلّقة والمحصّلة» (v2.5.0)
// ══════════════════════════════════════════════════════
// قراءة بس — مفيش كتابة في KV ولا D1 ولا شوبيفاي. ما بيلمسش checkPending/
// clearPending/listPending (عقد مع cod-payment-center-worker).
//
// المصادر التلاتة:
//   • KV       — مين لسه معلّق دلوقتي (مفتاح preReg:<id> موجود)
//   • D1       — tool=cod_preregister/preregister: مين سجّل ومتى وبكام
//                tool=cod_payment/payment (أداة التحصيل): اتحصّل ولا لأ
//   • شوبيفاي — الحالة الحية: الحالة المالية + المندوب الحالي + S1/S2 (نداء nodes واحد)
//
// بيانات العميل اتشالت من الـ endpoint ده في v2.9.0 (عمود العميل اتحذف). `preview` لسه بيرجّعها للعرض فقط.
const PAYMENT_TOOL         = 'cod_payment';   // لوج أداة التحصيل — بنقراه بس
const PENDING_DETAILS_CAP  = 2000;            // سقف صفوف التسجيل المسبق في الاستعلام
const PENDING_ORPHAN_CAP   = 200;             // سقف قراءة مفاتيح KV اللي مالهاش صف في D1
const PD_STATUSES = ['pending', 'collected', 'stale', 'cleared', 'kv_only'];

// D1 بيسمح بـ ١٠٠ باراميتر بس في الاستعلام الواحد — القوايم الطويلة بتتقسّم.
function chunkArray(arr, n = 50) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}
function safeJSON(s) { try { return s ? JSON.parse(s) : {}; } catch { return {}; } }

async function listKvPendingIds(kv) {
  const ids = new Set();
  let cursor, complete = false;
  for (let page = 0; page < 20; page++) {
    const l = await kv.list({ prefix: 'preReg:', cursor });
    (l.keys || []).forEach(k => ids.add(k.name.slice('preReg:'.length)));
    if (l.list_complete || !l.cursor) { complete = true; break; }
    cursor = l.cursor;
  }
  return { ids, complete };
}

// الحالة الحية من شوبيفاي (nodes) — بتتقسّم على مجموعات صغيرة. من v2.9.0 اتشالت بيانات العميل من
// الاستعلام (العمود اتحذف) فالتكلفة نزلت عن ~٩ نقاط للأوردر؛ التقسيم بـ ٥٠ فضل كما هو (هامش أمان).
// الكاش هنا في ذاكرة الـ isolate **بس** (TTL قصير، بيموت مع الـ isolate) — ممنوع يتحط في KV/D1.
// بترمي عند الفشل؛ اللي بينادي بيلقطها ويكمّل من غيرها.
const LIVE_CHUNK = 50;
const LIVE_TTL_MS = 120000;
const LIVE_CACHE = new Map();   // orderId → { at, state }

async function getOrdersLiveState(env, orderIds) {
  const now = Date.now();
  const out = {}, missing = [];
  for (const id of orderIds) {
    const c = LIVE_CACHE.get(id);
    if (c && now - c.at < LIVE_TTL_MS) out[id] = c.state; else missing.push(id);
  }
  if (!missing.length) return out;

  assertEnv(env, 'shopify');
  const token = await getAccessToken(env);
  const query = `
    query liveState($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on Order {
          id displayFinancialStatus cancelledAt
          totalOutstandingSet { shopMoney { amount } }
          courier: metafield(namespace: "custom", key: "courier") { value }
          s1: metafield(namespace: "custom", key: "manual_status") { value }
          s2: metafield(namespace: "custom", key: "status_2_r_e") { value }
        }
      }
    }
  `;
  if (LIVE_CACHE.size > 3000) LIVE_CACHE.clear();
  // بالتسلسل — التوازي على مجموعات كتير بيحرق bucket شوبيفاي ويرجّع THROTTLED
  for (const ch of chunkArray(missing, LIVE_CHUNK)) {
    const data = await shopifyGQL(env, token, query,
      { ids: ch.map(id => `gid://shopify/Order/${id}`) }, 'liveState');
    for (const n of (data?.data?.nodes || [])) {
      if (!n || !n.id) continue;
      const id = n.id.replace('gid://shopify/Order/', '');
      const state = {
        financialStatus: n.displayFinancialStatus || null,
        cancelled:       !!n.cancelledAt,
        outstanding:     n.totalOutstandingSet?.shopMoney?.amount ?? null,
        courier:         n.courier?.value || null,   // custom.courier — المندوب الحالي (مش وقت التسجيل)
        s1:              n.s1?.value || null,   // custom.manual_status
        s2:              n.s2?.value || null,   // custom.status_2_r_e
      };
      out[id] = state;
      LIVE_CACHE.set(id, { at: Date.now(), state });
    }
  }
  return out;
}

// ── توقيت القاهرة محسوب بـ Intl (ecommoda-constants §13) — مش إزاحة ثابتة ──
const _cairoFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
function cairoParts(d) {
  const o = {};
  for (const p of _cairoFmt.formatToParts(d)) if (p.type !== 'literal') o[p.type] = p.value;
  if (o.hour === '24') o.hour = '00';
  return o;
}
function cairoDayHM(iso) {
  if (!iso) return { day: '', hm: '' };
  const d = new Date(iso);
  if (isNaN(d)) return { day: '', hm: '' };
  const p = cairoParts(d);
  return { day: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}` };
}
function addDaysStr(s, n) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

// ⚠️ whitelist إجباري للترتيب (نفس مبدأ LOG_SORT_COLUMNS). المنتجات وأعمدة شوبيفاي الحية
// (المندوب · الحالة المالية · S1 · S2) قابلة للفلترة بس — مش للترتيب (مشتقّة من extra أو من شوبيفاي الحية).
const PD_SORT = {
  registeredAt: (i) => i.registeredAt || '',
  employee:     (i) => i.registeredBy || '',
  orderName:    (i) => Number(i.orderDigits) || 0,
  amount:       (i) => Number(i.amount) || 0,
  status:       (i) => i.status,
  collectedAt:  (i) => i.collectedAt || '',
  collAmount:   (i) => Number(i.collAmount) || 0,
};

const PD_NONE = '__none__';           // قيمة «بدون» في فلاتر المندوب/S1/S2
// تابين منفصلين: «المعلّقة» = لسه مستنية/اتمسحت من غير تحصيل/مفتاح يتيم · «المحصّلة» = اتحصّلت (حتى لو المفتاح عالق)
const PD_SCOPES = { pending: ['pending', 'cleared', 'kv_only'], collected: ['collected', 'stale'] };
const PD_LIVE_FILTER_CAP = 250;       // أقصى عدد أوردرات نجيب لها شوبيفاي الحية عشان نفلتر بيها

// ── فلاتر الأعمدة الحية (بتتطبّق بعد جلب شوبيفاي لمجموعة المرشّحين) ──
function pdFinKeys(lv) {
  if (!lv || lv.notFound) return ['NOT_FOUND'];
  const k = [];
  if (lv.cancelled) k.push('CANCELLED');
  if (lv.financialStatus) k.push(lv.financialStatus);
  return k;
}
const pdSVal = (lv, key) => (lv && !lv.notFound && lv[key]) ? lv[key] : PD_NONE;

async function buildPendingDetails(env, p) {
  // ── ١) المصادر الأساسية بالتوازي ────────────────────────────────
  // التاريخ في SQL **موسَّع يوم من كل طرف** عشان فرق UTC/القاهرة ما يضيّعش صفوف،
  // والفلترة الدقيقة بتوقيت القاهرة بتتم في الذاكرة بعد كده (نفس عرض الواجهة).
  // extra بيتجاب لكل الصفوف (≤ السقف) عشان المندوب والمنتجات يتفلتروا قبل تقسيم الصفحات.
  const { sql, b } = buildLogFilterSQL(
    'SELECT id, order_id, order_name, timestamp, employee, value_after, extra',
    { tool: TOOL_NAME, types: ['preregister'],
      dateFrom: p.dateFrom ? addDaysStr(p.dateFrom, -1) : null,
      dateTo:   p.dateTo   ? addDaysStr(p.dateTo, 1)    : null });

  const [kv, regRes, allRegRes] = await Promise.all([
    listKvPendingIds(env.PRE_REG_KV),
    env.DB.prepare(`${sql} ORDER BY timestamp DESC LIMIT ?`).bind(...b, PENDING_DETAILS_CAP + 1).all(),
    // كل أوردرات التسجيل المسبق **بدون فلاتر** — عشان مفتاح KV يتحسب «يتيم» بس
    // لو ملوش صف في D1 أصلاً، مش لو الفلتر استبعد صفه.
    env.DB.prepare(`SELECT DISTINCT order_id FROM logs WHERE tool = ? AND type = 'preregister' AND order_id IS NOT NULL`)
      .bind(TOOL_NAME).all(),
  ]);

  let regRows = regRes.results || [];
  const truncated = regRows.length > PENDING_DETAILS_CAP;
  if (truncated) regRows = regRows.slice(0, PENDING_DETAILS_CAP);

  // نفس الأوردر مسجّل أكتر من مرة؟ بنعرض الأحدث ونعدّ المرات.
  const byOrder = new Map();
  for (const r of regRows) {
    if (!r.order_id) continue;
    const prev = byOrder.get(r.order_id);
    if (prev) prev.registrations += 1;
    else byOrder.set(r.order_id, { ...r, registrations: 1 });
  }

  // ── ٢) اتحصّل ولا لأ؟ — آخر صف payment في لوج أداة التحصيل بعد وقت التسجيل ──
  // SQLite: مع MAX() واحد بس، الأعمدة العادية (employee · value_after) بتيجي من نفس الصف صاحب الـ MAX.
  // value_after = مبلغ الأوردر ده (مش إجمالي جلسة التحصيل) — ده المطلوب عرضه.
  const collection = new Map();   // order_id → { at, by, amount }
  if (byOrder.size) {
    const minTs = regRows[regRows.length - 1].timestamp;
    const col = await env.DB.prepare(`
      SELECT order_id, MAX(timestamp) AS collected_at, employee AS coll_by, value_after AS coll_amount FROM logs
      WHERE tool = ? AND type = 'payment' AND timestamp >= ?
        AND order_id IN (SELECT order_id FROM logs WHERE tool = ? AND type = 'preregister')
      GROUP BY order_id
    `).bind(PAYMENT_TOOL, minTs, TOOL_NAME).all();
    for (const r of (col.results || []))
      collection.set(r.order_id, { at: r.collected_at, by: r.coll_by || null, amount: r.coll_amount });
  }

  const skusOf = (ex) => [...new Set((ex.lineItems || []).map(li => String(li?.sku ?? '').trim()).filter(Boolean))];
  const items = [];
  for (const r of byOrder.values()) {
    const inKV = kv.ids.has(r.order_id);
    const c = collection.get(r.order_id);
    const collected = !!c && c.at >= r.timestamp;
    const ex = safeJSON(r.extra);
    items.push({
      orderId: r.order_id, orderName: r.order_name,
      registeredAt: r.timestamp, registeredBy: r.employee || null,
      amount: r.value_after, registrations: r.registrations, inKV,
      collectedAt: collected ? c.at : null,
      collBy: collected ? c.by : null,
      collAmount: collected ? c.amount : null,
      courier: ex.courier || null, lineItems: ex.lineItems || [], skus: skusOf(ex),
      transactionId: ex.transactionId || null, result: ex.result || null,
      status: inKV ? (collected ? 'stale' : 'pending') : (collected ? 'collected' : 'cleared'),
    });
  }

  // ── ٣) مفاتيح KV من غير صف تسجيل في D1 (مثلاً backlog بوسطة) ──────
  // التفاصيل (الاسم/الوقت) في قيمة المفتاح نفسها، فبنقراها — بسقف. مفيش موظف
  // مسجّل ليها، فأي فلتر موظف بيستبعدها.
  const allReg = new Set((allRegRes.results || []).map(r => r.order_id));
  const orphanIds = [...kv.ids].filter(id => !allReg.has(id));
  let orphansTruncated = false;
  if (orphanIds.length) {
    const slice = orphanIds.slice(0, PENDING_ORPHAN_CAP);
    orphansTruncated = orphanIds.length > slice.length;
    const vals = await Promise.all(slice.map(async id => [id, safeJSON(await env.PRE_REG_KV.get(`preReg:${id}`))]));
    for (const [id, e] of vals) {
      items.push({
        orderId: id, orderName: e.orderName || null,
        registeredAt: e.preRegisteredAt || null, registeredBy: null,
        amount: e.amount != null ? Number(e.amount) : null, registrations: 0, inKV: true,
        collectedAt: null, collBy: null, collAmount: null,
        courier: e.courier || null, lineItems: e.lineItems || [], skus: skusOf(e),
        transactionId: null, result: null, status: 'kv_only',
      });
    }
  }

  // ── ٤) الفلترة (بتوقيت القاهرة) + الـ facets + الترتيب + الصفحة ─────
  // كل فلتر شرط مستقل، والـ facet بتاع أي فلتر بيتعدّ على الصفوف المطابقة لكل
  // الفلاتر **التانية** — فعدّاد قيمة جوّه قايمة الفلتر بيقول «هتجيب كام لو اخترتها».
  // الأعمدة الحية (العميل · الحالة المالية · S1 · S2) بتتفلتر بعد جلب شوبيفاي لمجموعة المرشّحين
  // (اللي عدّت الفلاتر التانية) — وبسقف PD_LIVE_FILTER_CAP، ولو اتجاوز بيرجع liveBlocked صريح.
  const scopeSt = PD_SCOPES[p.scope] || PD_STATUSES;
  const inScope = items.filter(i => scopeSt.includes(i.status));   // التاب بيشوف حالاته بس — قبل أي فلتر أو facet
  const emps = p.employees || [], stats = (p.statuses || []).filter(s => scopeSt.includes(s)), ords = p.orders || [];
  const its = p.items || [];
  const aF = Number.isFinite(p.amountFrom) ? p.amountFrom : null;
  const aT = Number.isFinite(p.amountTo)   ? p.amountTo   : null;
  const cAF = Number.isFinite(p.cAmountFrom) ? p.cAmountFrom : null;
  const cAT = Number.isFinite(p.cAmountTo)   ? p.cAmountTo   : null;
  const lf = { courier: p.couriers || [], fin: p.fins || [], s1: p.s1 || [], s2: p.s2 || [] };
  const needLive = Object.values(lf).some(a => a.length > 0);

  const facets = { status: {}, employee: {}, items: {}, live: null, courierVocab: [] };
  scopeSt.forEach(s => { facets.status[s] = 0; });
  // كل القيم الموجودة (حتى بعدّاد صفر) عشان القايمة ما تفضّيش لما فلتر تاني يستبعدها
  const vocab = new Set();
  for (const i of inScope) {
    if (i.registeredBy && !(i.registeredBy in facets.employee)) facets.employee[i.registeredBy] = 0;
    if (i.courier) vocab.add(i.courier);   // مفردات قايمة فلتر المندوب (من وقت التسجيل) — الفلترة نفسها على المندوب الحي
    i.skus.forEach(sk => { if (!(sk in facets.items)) facets.items[sk] = 0; });
  }

  facets.courierVocab = [...vocab].sort();
  const candidates = [];
  for (const i of inScope) {
    const { day, hm } = cairoDayHM(i.registeredAt);
    const cd = cairoDayHM(i.collectedAt);
    i.orderDigits = String(i.orderName || '').replace(/\D/g, '');
    const amt = i.amount == null ? NaN : Number(i.amount);
    const camt = i.collAmount == null ? NaN : Number(i.collAmount);
    const ok = {
      emp:     !emps.length || (!!i.registeredBy && emps.includes(i.registeredBy)),
      status:  !stats.length || stats.includes(i.status),
      orders:  !ords.length || ords.some(t => i.orderDigits.includes(t)),
      amount:  (aF === null || amt >= aF) && (aT === null || amt <= aT),
      date:    (!p.dateFrom || (!!day && day >= p.dateFrom)) && (!p.dateTo || (!!day && day <= p.dateTo)),
      time:    (!p.timeFrom || (!!hm && hm >= p.timeFrom)) && (!p.timeTo || (!!hm && hm <= p.timeTo)),
      items:   !its.length || i.skus.some(sk => its.includes(sk)),
      cdate:   (!p.cDateFrom || (!!cd.day && cd.day >= p.cDateFrom)) && (!p.cDateTo || (!!cd.day && cd.day <= p.cDateTo)),
      ctime:   (!p.cTimeFrom || (!!cd.hm && cd.hm >= p.cTimeFrom)) && (!p.cTimeTo || (!!cd.hm && cd.hm <= p.cTimeTo)),
      camount: (cAF === null || camt >= cAF) && (cAT === null || camt <= cAT),
    };
    const failed = Object.keys(ok).filter(k => !ok[k]);
    if (!failed.length) candidates.push(i);
    if (failed.every(k => k === 'status')) facets.status[i.status] += 1;
    if (failed.every(k => k === 'emp') && i.registeredBy) facets.employee[i.registeredBy] += 1;
    if (failed.every(k => k === 'items')) i.skus.forEach(sk => { facets.items[sk] += 1; });
  }
  // لو فيه فلتر حي، عدّادات الأعمدة العادية بتتحوّل «—» (مش محسوبة على كل الصفوف) — صريح بدل رقم غلط
  const blankCounts = () => {
    for (const k of ['status', 'employee', 'items']) for (const v in facets[k]) facets[k][v] = null;
  };

  // ── الفلاتر الحية ───────────────────────────────────────────────
  let live = {}, shopify = { ok: true }, liveBlocked = null, passing = candidates;
  if (needLive) {
    blankCounts();
    if (candidates.length > PD_LIVE_FILTER_CAP)
      liveBlocked = { reason: 'too_many', candidates: candidates.length, cap: PD_LIVE_FILTER_CAP };
    else if (candidates.length) {
      try { live = await getOrdersLiveState(env, candidates.map(i => i.orderId)); }
      catch (e) { shopify = { ok: false, error: e.message }; liveBlocked = { reason: 'shopify_failed', error: e.message }; }
    }
    if (liveBlocked) {
      return {
        rows: [], total: 0, facets, liveBlocked, shopify,
        cap: PENDING_DETAILS_CAP, truncated, orphansTruncated, kvComplete: kv.complete,
      };
    }
    const FIN_ALL = ['PAID', 'PENDING', 'PARTIALLY_PAID', 'AUTHORIZED', 'REFUNDED', 'PARTIALLY_REFUNDED', 'VOIDED', 'EXPIRED', 'CANCELLED', 'NOT_FOUND'];
    facets.live = { fin: {}, courier: {}, s1: {}, s2: {} };
    FIN_ALL.forEach(v => { facets.live.fin[v] = 0; });
    passing = [];
    for (const i of candidates) {
      const lv = live[i.orderId] || { notFound: true };
      const fk = pdFinKeys(lv), vc = pdSVal(lv, 'courier'), v1 = pdSVal(lv, 's1'), v2 = pdSVal(lv, 's2');
      const ok = {
        courier: !lf.courier.length || lf.courier.includes(vc),
        fin:  !lf.fin.length || fk.some(k => lf.fin.includes(k)),
        s1:   !lf.s1.length || lf.s1.includes(v1),
        s2:   !lf.s2.length || lf.s2.includes(v2),
      };
      const failed = Object.keys(ok).filter(k => !ok[k]);
      if (!failed.length) passing.push(i);
      if (failed.every(k => k === 'fin')) fk.forEach(k => { facets.live.fin[k] = (facets.live.fin[k] || 0) + 1; });
      if (failed.every(k => k === 'courier')) facets.live.courier[vc] = (facets.live.courier[vc] || 0) + 1;
      if (failed.every(k => k === 's1')) facets.live.s1[v1] = (facets.live.s1[v1] || 0) + 1;
      if (failed.every(k => k === 's2')) facets.live.s2[v2] = (facets.live.s2[v2] || 0) + 1;
    }
  }

  const keyFn = PD_SORT[p.sortKey];
  const dir = p.sortDir === 'asc' ? 1 : -1;
  passing.sort((a, b2) => {
    if (keyFn) {
      const x = keyFn(a), y = keyFn(b2);
      const c = typeof x === 'string' ? x.localeCompare(y) : x - y;
      if (c) return c * dir;
    }
    return String(b2.registeredAt || '').localeCompare(String(a.registeredAt || ''));   // كاسر التعادل + الترتيب الافتراضي
  });
  const page = passing.slice(p.offset, p.offset + p.limit);

  // ── ٥) شوبيفاي الحية للصفحة (لو ما اتجابتش للفلترة) ─────────────────
  if (!needLive && page.length) {
    try { live = await getOrdersLiveState(env, page.map(i => i.orderId)); }
    catch (e) { shopify = { ok: false, error: e.message }; }
  }

  const rows = page.map(i => ({
    orderId: i.orderId, orderName: i.orderName, status: i.status, inKV: i.inKV,
    registeredAt: i.registeredAt, registeredBy: i.registeredBy,
    amount: i.amount, registrations: i.registrations,
    lineItems: i.lineItems,
    transactionId: i.transactionId, result: i.result,
    // مبلغ الأوردر ده بس — من غير تفاصيل جلسة التحصيل (كاش/إنستاباي/محفظة)
    collection: i.collectedAt ? { at: i.collectedAt, by: i.collBy, amount: i.collAmount } : null,
    live: shopify.ok ? (live[i.orderId] || { notFound: true }) : null,
  }));

  return {
    rows, total: passing.length, facets,
    cap: PENDING_DETAILS_CAP, truncated, orphansTruncated, kvComplete: kv.complete,
    shopify,
  };
}

// ══════════════════════════════════════════════════════
// §HANDLER
// ══════════════════════════════════════════════════════
export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: getCORS(request) });

    const auth = request.headers.get('Authorization');
    if (!auth || auth !== `Bearer ${env.WORKER_SECRET}`) return json({ error: 'Unauthorized' }, 401, request);

    const url = new URL(request.url);
    let bodyData = {};
    if (request.method === 'POST') bodyData = await request.json().catch(() => ({}));
    const action = url.searchParams.get('action') || bodyData.action || '';

    try {
      if (!action) return json({ error: 'action is required' }, 400, request);

      // ─── §DIAG ──────────────────────────────────────────────────
      // get_config — الواجهة بتقارن النسخة دي بـ MIN_WORKER_VERSION بتاعتها،
      // فبيكشف Promote ناقص أو بناء فاشل أو Worker شبح.
      if (action === 'get_config') {
        return json({ ok: true, version: WORKER_VERSION, tool: TOOL_NAME }, 200, request);
      }

      // diag — فحص ذاتي بدون أي كتابة. ⚠️ ممنوع يرجّع قيمة أي سر — الأسماء والأطوال بس.
      if (action === 'diag') {
        const checks = [];
        const envKeys = Object.keys(env)
          .map(k => ({ name: k, len: typeof env[k] === 'string' ? env[k].length : null }))
          .sort((a, b) => a.name.localeCompare(b.name));

        for (const k of ['SHOP_DOMAIN', 'CLIENT_ID', 'CLIENT_SECRET', 'WORKER_SECRET']) {
          const v = env[k];
          checks.push({
            name: k,
            ok:   typeof v === 'string' && v.trim() !== '',
            info: typeof v === 'string' ? `مضبوط (${v.length} حرف)` : 'ناقص',
          });
        }
        checks.push({ name: 'DB (D1)',            ok: !!env.DB,         info: env.DB ? 'مربوط' : 'ناقص' });
        checks.push({ name: 'PRE_REG_KV (KV)',    ok: !!env.PRE_REG_KV, info: env.PRE_REG_KV ? 'مربوط' : 'ناقص' });

        // D1 — قراءة فقط
        try {
          const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM employees WHERE is_active = 1').first();
          checks.push({ name: 'D1 employees', ok: true, info: `${row?.n ?? 0} موظف نشط` });
        } catch (e) {
          checks.push({ name: 'D1 employees', ok: false, info: e.message });
        }

        // KV — قراءة فقط
        try {
          const list = await env.PRE_REG_KV.list({ prefix: 'preReg:', limit: 1000 });
          checks.push({ name: 'KV preReg', ok: true, info: `${list.keys.length} مفتاح معلّق${list.list_complete === false ? '+' : ''}` });
        } catch (e) {
          checks.push({ name: 'KV preReg', ok: false, info: e.message });
        }

        // شوبيفاي — OAuth + صلاحيات التطبيق
        let scopes = [];
        try {
          const token = await getAccessToken(env);
          checks.push({ name: 'Shopify OAuth', ok: true, info: 'التوكن اتجاب' });
          try {
            const d = await shopifyGQL(env, token,
              `{ currentAppInstallation { accessScopes { handle } } }`, {}, 'diagScopes');
            scopes = (d?.data?.currentAppInstallation?.accessScopes || []).map(x => x.handle);
            const needed = ['read_orders', 'write_orders', 'read_customers'];
            const miss   = needed.filter(x => !scopes.includes(x));
            checks.push({
              name: 'Shopify scopes',
              ok:   miss.length === 0,
              info: miss.length ? `ناقص: ${miss.join('، ')}` : `${scopes.length} صلاحية`,
            });
          } catch (e) {
            checks.push({ name: 'Shopify scopes', ok: false, info: e.message });
          }
        } catch (e) {
          checks.push({ name: 'Shopify OAuth', ok: false, info: e.message });
        }

        return json({
          ok: true,
          version: WORKER_VERSION,
          tool:    TOOL_NAME,
          origin:  request.headers.get('Origin') || '(بدون Origin)',
          originAllowed: ALLOWED_ORIGINS.includes(request.headers.get('Origin') || ''),
          allowedOrigins: ALLOWED_ORIGINS,
          envKeys,
          scopes,
          checks,
        }, 200, request);
      }

      // ─── §AUTH ──────────────────────────────────────────────────
      if (action === 'check_employee') {
        const username = url.searchParams.get('username');
        if (!username) return json({ ok: false, error: 'username مطلوب' }, 400, request);
        const result = await checkEmployee(env.DB, username);
        return json({ ok: true, ...result }, 200, request);
      }

      if (action === 'register_pin') {
        if (request.method !== 'POST') return json({ error: 'POST required' }, 405, request);
        const { username, pin } = bodyData;
        if (!username || !pin) return json({ ok: false, error: 'username و pin مطلوبان' }, 400, request);
        await registerPin(env.DB, username, pin);
        return json({ ok: true }, 200, request);
      }

      if (action === 'verify_employee') {
        if (request.method !== 'POST') return json({ error: 'POST required' }, 405, request);
        const { username, pin } = bodyData;
        if (!username || !pin) return json({ ok: false, error: 'username و pin مطلوبان' }, 400, request);
        const displayName = await verifyEmployee(env.DB, username, pin);
        if (!displayName) return json({ ok: false, error: 'PIN خطأ أو المستخدم غير موجود' }, 401, request);
        // الدخول نفسه نجح فعلاً هنا — فشل D1 بعد كده يرجع logged:false مش 500
        let logged = true;
        try {
          await writeLog(env.DB, { tool: TOOL_NAME, type: 'login', employee: username, notes: `دخول: ${displayName}` });
        } catch (e) { logged = false; }
        return json({ ok: true, displayName, logged }, 200, request);
      }

      if (action === 'log_logout') {
        const username = url.searchParams.get('username');
        let logged = true;
        if (username) {
          try {
            await writeLog(env.DB, { tool: TOOL_NAME, type: 'logout', employee: username, notes: `خروج: ${username.replace(/_/g, ' ')}` });
          } catch (e) { logged = false; }
        }
        return json({ ok: true, logged }, 200, request);
      }

      if (action === 'get_employees') {
        const { results } = await env.DB.prepare(
          'SELECT username, display_name FROM employees WHERE is_active = 1 ORDER BY display_name'
        ).all();
        return json({ ok: true, employees: results }, 200, request);
      }
      // ──────────────────────────────────────────────────────────────

      const orderId   = bodyData.orderId;
      const numericId = orderId ? orderId.toString().trim() : null;

      // ── resolveByName ─────────────────────────────────────────────
      if (action === 'resolveByName') {
        assertEnv(env, 'shopify');
        const orderName = bodyData.orderName;
        if (!orderName) return json({ error: 'orderName is required' }, 400, request);
        const id = await getOrderIdByName(env, String(orderName).replace(/^#/, '').trim());
        if (!id) return json({ success: false, notFound: true }, 200, request);
        return json({ success: true, orderId: id }, 200, request);
      }

      // ── checkPending — لـ cod-payment-center-worker ─────────────
      if (action === 'checkPending') {
        if (!numericId) return json({ error: 'orderId is required' }, 400, request);
        const raw = await env.PRE_REG_KV.get(`preReg:${numericId}`);
        if (!raw) return json({ success: true, pending: false }, 200, request);
        return json({ success: true, pending: true, entry: JSON.parse(raw) }, 200, request);
      }

      // ── clearPending — لـ cod-payment-center-worker ─────────────
      if (action === 'clearPending') {
        if (!numericId) return json({ error: 'orderId is required' }, 400, request);
        await env.PRE_REG_KV.delete(`preReg:${numericId}`);
        return json({ success: true }, 200, request);
      }

      // ── listPending — لـ getCourierOrders (نداء واحد بدل N) ──────
      if (action === 'listPending') {
        const list = await env.PRE_REG_KV.list({ prefix: 'preReg:' });
        const entries = {};
        await Promise.all(list.keys.map(async (k) => {
          const raw = await env.PRE_REG_KV.get(k.name);
          if (raw) entries[k.name.replace('preReg:', '')] = JSON.parse(raw);
        }));
        return json({ success: true, entries }, 200, request);
      }

      // ── pending_details — تاب «المعلّقة والمحصّلة» في الواجهة ─────
      // GET · قراءة بس. endpoint **منفصل** عن listPending (شكل ردّه مقفول).
      // الحارس هنا جوّه الـ endpoint — مش سطر عام (انظر فخ v2.0.0 تحت).
      if (action === 'pending_details') {
        assertEnv(env);   // DB + PRE_REG_KV بس — شوبيفاي بيتفحص جوّه وبيتحمّل فشله
        const csv = (k) => (url.searchParams.get(k) || '').split(',').map(s => s.trim()).filter(Boolean);
        // قوايم القيم الحرّة (مندوب · SKU · S1/S2) بتتفصل بـ '||' — القيمة نفسها ممكن تحتوي فاصلة
        const list = (k) => (url.searchParams.get(k) || '').split('||').map(x => x.trim()).filter(Boolean);
        const num  = (k) => { const v = url.searchParams.get(k); return v === null || v === '' ? NaN : Number(v); };
        const hm   = (k) => { const v = url.searchParams.get(k) || ''; return /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : null; };
        const day  = (k) => { const v = url.searchParams.get(k) || ''; return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null; };
        const result = await buildPendingDetails(env, {
          statuses:   csv('statuses').filter(s => PD_STATUSES.includes(s)),
          employees:  csv('employees'),
          orders:     csv('orders').map(t => t.replace(/\D/g, '')).filter(Boolean),   // أرقام بس — المسافة/الفاصلة = أوردر تاني (OR)
          amountFrom: num('amountFrom'), amountTo: num('amountTo'),
          dateFrom:   day('dateFrom'),   dateTo:   day('dateTo'),
          timeFrom:   hm('timeFrom'),    timeTo:   hm('timeTo'),
          scope:      url.searchParams.get('scope') || null,   // pending | collected — whitelist جوّه buildPendingDetails (PD_SCOPES)
          couriers:   list('couriers'),  items: list('items'),
          cAmountFrom: num('cAmountFrom'), cAmountTo: num('cAmountTo'),
          cDateFrom:  day('cDateFrom'),  cDateTo:  day('cDateTo'),
          cTimeFrom:  hm('cTimeFrom'),   cTimeTo:  hm('cTimeTo'),
          fins: list('fins'), s1: list('s1'), s2: list('s2'),
          sortKey:    url.searchParams.get('sortKey') || null,   // whitelist جوّه buildPendingDetails (PD_SORT)
          sortDir:    url.searchParams.get('sortDir') || 'desc',
          limit:      Math.min(Math.max(parseInt(url.searchParams.get('limit')  || '100') || 100, 1), 100),
          offset:     Math.max(parseInt(url.searchParams.get('offset') || '0') || 0, 0),
        });
        return json({ ok: true, ...result }, 200, request);
      }

      // ── delete_preregister — حذف فعلي من D1 لأوردر «اتمسح بدون تحصيل مسجّل» ─────
      // ⚠️ أول endpoint بيكتب/بيحذف في تاب المعلّقة. الصف ده أثر دفع حقيقي (capture على شوبيفاي)،
      // فالحذف مقصور على حالة `cleared` بس: المفتاح مش في KV **ومفيش** تحصيل مسجّل بعد التسجيل.
      // الحارس جوّه الـ endpoint (مش سطر عام). بيحذف كل صفوف `preregister` للأوردر ده (مش الأحدث بس)
      // عشان الأوردر ما يرجعش يظهر بصف أقدم. مفيش حذف لأي type تاني ولا لأداة تانية.
      if (action === 'delete_preregister') {
        if (request.method !== 'POST') return json({ error: 'POST required' }, 405, request);
        assertEnv(env);
        const { username, pin } = bodyData;
        if (!numericId) return json({ error: 'orderId is required' }, 400, request);
        if (!username || !pin) return json({ ok: false, error: 'username و pin مطلوبان' }, 400, request);
        const displayName = await verifyEmployee(env.DB, username, pin);
        // 403 مش 401: الواجهة بتفسّر 401 على إنه «Worker Secret غلط» — والـ PIN الغلط مش ده
        if (!displayName) return json({ ok: false, error: 'PIN خطأ أو المستخدم غير موجود' }, 403, request);

        const kvKey = `preReg:${numericId}`;
        const reg = await env.DB.prepare(
          `SELECT COUNT(*) AS n, MAX(timestamp) AS last_ts, MAX(order_name) AS order_name FROM logs
           WHERE tool = ? AND type = 'preregister' AND order_id = ?`
        ).bind(TOOL_NAME, numericId).first();
        if (!reg || !reg.n) return json({ ok: false, error: 'مفيش سجل تسجيل مسبق للأوردر ده في D1' }, 404, request);

        if (await env.PRE_REG_KV.get(kvKey))
          return json({ ok: false, error: 'المفتاح لسه موجود في KV — الأوردر معلّق فعلاً، مش هيتحذف' }, 409, request);
        const paid = await env.DB.prepare(
          `SELECT COUNT(*) AS n FROM logs WHERE tool = ? AND type = 'payment' AND order_id = ? AND timestamp >= ?`
        ).bind(PAYMENT_TOOL, numericId, reg.last_ts).first();
        if (paid && paid.n)
          return json({ ok: false, error: 'الأوردر ده اتحصّل فعلاً (فيه تحصيل مسجّل) — السجل هو الدليل الوحيد على التحصيل، مش هيتحذف' }, 409, request);

        // آخر فحص للمفتاح قبل الحذف مباشرة (تسجيل جديد ممكن يكون حصل في الفاصل)
        if (await env.PRE_REG_KV.get(kvKey))
          return json({ ok: false, error: 'المفتاح اتسجّل من جديد في KV — العملية اتلغت' }, 409, request);
        const del = await env.DB.prepare(
          `DELETE FROM logs WHERE tool = ? AND type = 'preregister' AND order_id = ?`
        ).bind(TOOL_NAME, numericId).run();
        const deleted = del?.meta?.changes ?? 0;
        console.log(`delete_preregister: order=${numericId} name=${reg.order_name || ''} rows=${deleted} by=${username}`);
        return json({ ok: true, deleted, orderId: numericId, orderName: reg.order_name || null }, 200, request);
      }

      // ⛔ endpoint الترحيل المؤقت `import_pending_kv` اتشال في v2.3.0 —
      // كان بينقل مفاتيح PRE_REG_KV من حساب ecommoda24 المهجور، والترحيل خلص.
      // أي endpoint ترحيل مؤقت منشور بعد ما يخلص غرضه = سطح هجوم بلا مقابل.
      // لو احتجت ترحيل تاني يومًا، ارجع لنسخته في الـ git history (commit b3f7906).

      // 🔴 كان هنا حارس عام: `if (!numericId) return 400 orderId is required`
      // — وهو **قبل** §LOG-ENDPOINTS. `get_logs`/`get_logs_count`/
      // `get_logs_export` كلهم GET، يعني `bodyData = {}` و `numericId = null`،
      // فالتلاتة كانوا بيرجعوا 400 ومحصلش إن الطلب وصلهم أصلاً. السجل كان
      // مكسور من v2.0.0 (النسخة اللي كانت منشورة من الداشبورد) — ظهر بس لما
      // الواجهة بقت بتعرض الخطأ بدل ما تبلعه في توست.
      // الدرس: الحارس يبقى **جوه الـ endpoint اللي محتاجه**، مش سطر عام في
      // نص الـ handler — العام بيبلع كل اللي بعده في صمت.

      // ── preview ───────────────────────────────────────────────────
      if (action === 'preview') {
        if (!numericId) return json({ error: 'orderId is required' }, 400, request);
        assertEnv(env, 'shopify');
        const orderData = await getOrderDataById(env, numericId);
        if (!orderData) return json({ success: false, notFound: true }, 200, request);

        const existing = await env.PRE_REG_KV.get(`preReg:${numericId}`);

        return json({
          success:              true,
          orderId:              numericId,
          orderName:            orderData.orderName,
          amount:               orderData.outstanding,
          subtotal:              orderData.subtotal,
          shippingAmount:        orderData.shippingAmount,
          canMarkAsPaid:         orderData.canMarkAsPaid,
          skipReason:            orderData.skipReason || null,
          financialStatus:       orderData.financialStatus,
          courier:               orderData.courier,
          customerName:          orderData.customerName,
          customerPhone:         orderData.customerPhone,
          lineItems:             orderData.lineItems,
          alreadyPreRegistered:  !!existing,
          registeredAt:          existing ? JSON.parse(existing).preRegisteredAt : null,
        }, 200, request);
      }

      // ── preRegister ───────────────────────────────────────────────
      if (action === 'preRegister') {
        if (!numericId) return json({ error: 'orderId is required' }, 400, request);
        assertEnv(env, 'shopify');
        const { amount, orderName, subtotal, shippingAmount, courier, lineItems, employee } = bodyData;
        if (!amount) return json({ error: 'amount is required' }, 400, request);

        const parsedAmount = parseFloat(amount);
        if (isNaN(parsedAmount) || parsedAmount <= 0) {
          return json({ error: 'Invalid amount' }, 400, request);
        }

        // النتيجة تلات حالات مش اتنين: success | warning | error.
        // `warning` = الفلوس اتسجّلت فعلاً بس خطوة تابعة ما تمّتش — وده **ممنوع**
        // يتحسب نجاح، لأن الموظف بيبني عليه إن الأوردر ظاهر للتحصيل بعدين.
        const actions  = [];   // بتتملي أول بأول — لو رمى استثناء في النص، اللي تم يفضل مسجّل
        const warnings = [];

        let token;
        try {
          token = await getAccessToken(env);
        } catch (e) {
          return json({ success: false, status: 'error', error: e.message, actions, warnings }, 200, request);
        }

        // 1. تسجيل الدفع على شوبيفاي — الخطوة الحرجة الوحيدة
        const txResult = await createTransaction(token, env, numericId, parsedAmount.toFixed(2));
        if (!txResult.success) {
          return json({ success: false, status: 'error', error: txResult.error, actions, warnings }, 200, request);
        }
        actions.push(`تسجيل دفع ${parsedAmount.toFixed(2)} ج على شوبيفاي`);

        // 2. حفظ في KV — إشارة "معلّق للتحصيل الفعلي"
        // ⚠️ كان بلا حارس: فشله بعد ما الفلوس اتسجّلت كان بيرمي 500 والواجهة
        // تقول "خطأ في الاتصال" — والفلوس متسجّلة فعلاً على شوبيفاي.
        const kvEntry = {
          orderId:          numericId,
          orderName:        orderName || '',
          amount:            parsedAmount.toFixed(2),
          subtotal:          subtotal || '0.00',
          shippingAmount:    shippingAmount || '0.00',
          courier:           courier || null,
          lineItems:         lineItems || [],
          preRegisteredAt:   new Date().toISOString(),
          transactionId:     txResult.transactionId,
        };
        let pendingSaved = true;
        try {
          await env.PRE_REG_KV.put(`preReg:${numericId}`, JSON.stringify(kvEntry));
          actions.push('حفظ حالة "معلّق للتحصيل" في KV');
        } catch (e) {
          pendingSaved = false;
          warnings.push(`الفلوس اتسجّلت على شوبيفاي لكن حالة "معلّق" ما اتحفظتش (${e.message}) — الأوردر ده مش هيظهر في أداة التحصيل`);
        }

        // 3. الميتافيلد — أثر دائم على شوبيفاي (غير حرج)
        let metafieldSet = true;
        try {
          await setPreRegMetafield(token, env, numericId);
          actions.push('كتابة ميتافيلد custom.pre_register_payment');
        } catch (e) {
          metafieldSet = false;
          warnings.push(`الميتافيلد ما اتكتبش: ${e.message}`);
        }

        // 4. D1 — سجل دائم (غير حرج، بس فشله لازم يبان مش يتبلع)
        let logged = true;
        try {
          await writeLog(env.DB, {
            tool: TOOL_NAME, type: 'preregister', employee: employee || null,
            orderId: numericId, orderName: orderName || null,
            valueAfter: parsedAmount, notes: null,
            extra: {
              courier: courier || null, lineItems: lineItems || [],
              subtotal: subtotal || null, shippingAmount: shippingAmount || null,
              transactionId: txResult.transactionId,
              result: warnings.length ? 'warning' : 'success',
              pendingSaved, metafieldSet,
            },
          });
        } catch (e) {
          logged = false;
          warnings.push(`العملية تمت لكن ما اتسجلتش في السجل: ${e.message}`);
        }

        return json({
          success:       true,
          status:        warnings.length ? 'warning' : 'success',
          orderId:       numericId,
          transactionId: txResult.transactionId,
          actions, warnings, logged, pendingSaved, metafieldSet,
        }, 200, request);
      }

      // ─── §LOG-ENDPOINTS ─────────────────────────────────────────
      // التلاتة بيقروا الفلاتر من نفس المصدر (logParamsFrom)، فمفيش endpoint
      // بيفلتر بشكل مختلف عن اللي جنبه — وده اللي بيخلي التصدير ينزّل غير المعروض.
      if (action === 'get_logs') {
        const p      = logParamsFrom(url, TOOL_NAME);
        const limit  = Math.min(parseInt(url.searchParams.get('limit')  || '100'), 100);
        const offset = Math.max(parseInt(url.searchParams.get('offset') || '0'),    0);
        const entries = await getLogs(env.DB, {
          ...p, limit, offset,
          sortKey: url.searchParams.get('sortKey') || null,
          sortDir: url.searchParams.get('sortDir') || 'desc',
        });
        return json({ ok: true, entries }, 200, request);
      }

      if (action === 'get_logs_facets') {
        const facets = await getLogsFacets(env.DB, logParamsFrom(url, TOOL_NAME));
        return json({ ok: true, facets }, 200, request);
      }

      if (action === 'get_logs_count') {
        const total = await getLogsCount(env.DB, logParamsFrom(url, TOOL_NAME));
        return json({ ok: true, total }, 200, request);
      }

      // ⚠️ عقد إلزامي: الصفوف **والحقيقة** مع بعض. من غير cap/total/truncated
      // الواجهة بتقول "تم التصدير ✓" على ملف مقصوص من غير ما حد يعرف.
      if (action === 'get_logs_export') {
        const p = logParamsFrom(url, TOOL_NAME);
        const [entries, total] = await Promise.all([
          getLogsExport(env.DB, p),
          getLogsCount(env.DB, p),
        ]);
        return json({ ok: true, entries, cap: LOG_EXPORT_MAX, total,
                      truncated: total > LOG_EXPORT_MAX }, 200, request);
      }
      // ──────────────────────────────────────────────────────────────

      return json({ error: `Unknown action: ${action}` }, 400, request);

    } catch (err) {
      return json({ error: err.message }, 500, request);
    }
  },
};
