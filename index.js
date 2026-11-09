/**
 * cod-pre-register-payment-worker  (v2.5.0 — تاب المعلّقة والمحصّلة: pending_details)
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
 *   pending_details – (GET · قراءة بس) KV + D1 (تسجيل + تحصيل) + شوبيفاي الحية لكل الأوردرات المسجّلة مسبقًا
 *   check_employee / register_pin / verify_employee / log_logout / get_employees — Universal D1 Auth
 *   get_logs / get_logs_count / get_logs_export — tool=cod_preregister
 *   diag / get_config — فحص ذاتي + نسخة الـ Worker (إلزاميان لأي Worker بيكتب)
 *
 * D1: tool = 'cod_preregister' | type = 'preregister' / 'login' / 'logout'
 */

// ══════════════════════════════════════════════════════
// §CONSTANTS
// ══════════════════════════════════════════════════════
const TOOL_NAME      = 'cod_preregister';
const WORKER_VERSION = '2.5.0';

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
 * بنّاء شرط الفلترة الموحّد للسجل — التلات دوال تحته بتستخدمه.
 * القوايم (employees/types) والقيمة المفردة (employee/type) الاتنين مقبولين،
 * فالترقية متوافقة رجوعيًا ١٠٠٪.
 * ⚠️ dateFrom/dateTo بيتقارنوا بـ substr(timestamp,1,10) — يعني **UTC**، والعرض
 * بتوقيت القاهرة (UTC+3). فرق التلات ساعات ممكن يحط عملية بعد ٩ مساءً بتوقيت
 * القاهرة في يوم UTC اللي بعده. مقبول لفلتر بالأيام — بس مكتوب.
 */
function buildLogFilterSQL(select, {
  tool      = null,
  employee  = null, employees = null,
  type      = null, types     = null,
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
  if (search) {
    sql += ' AND (order_name LIKE ? OR notes LIKE ?)';
    b.push(`%${search}%`, `%${search}%`);
  }
  if (dateFrom) { sql += ' AND substr(timestamp, 1, 10) >= ?'; b.push(dateFrom); }
  if (dateTo)   { sql += ' AND substr(timestamp, 1, 10) <= ?'; b.push(dateTo); }

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
//   • شوبيفاي — الحالة الحية + بيانات العميل **للعرض فقط** (نداء nodes واحد)
//
// ⛔ بيانات العميل بتتحط في رد الـ endpoint ده بس — ممنوع تدخل writeLog/extra.
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

// الحالة الحية من شوبيفاي — نداء nodes واحد للصفحة كلها (≤100 أوردر).
// بترمي عند الفشل؛ اللي بينادي بيلقطها ويكمّل من غيرها.
async function getOrdersLiveState(env, orderIds) {
  assertEnv(env, 'shopify');
  const token = await getAccessToken(env);
  const query = `
    query liveState($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on Order {
          id displayFinancialStatus cancelledAt phone
          customer { displayName phone }
          shippingAddress { name phone }
          totalOutstandingSet { shopMoney { amount } }
        }
      }
    }
  `;
  const data = await shopifyGQL(env, token, query,
    { ids: orderIds.map(id => `gid://shopify/Order/${id}`) }, 'liveState');
  const out = {};
  for (const n of (data?.data?.nodes || [])) {
    if (!n || !n.id) continue;
    out[n.id.replace('gid://shopify/Order/', '')] = {
      financialStatus: n.displayFinancialStatus || null,
      cancelled:       !!n.cancelledAt,
      outstanding:     n.totalOutstandingSet?.shopMoney?.amount ?? null,
      customerName:    n.customer?.displayName || n.shippingAddress?.name || null,
      customerPhone:   n.shippingAddress?.phone || n.customer?.phone || n.phone || null,
    };
  }
  return out;
}

async function buildPendingDetails(env, p) {
  // ── ١) المصادر الأساسية بالتوازي ────────────────────────────────
  const { sql, b } = buildLogFilterSQL(
    'SELECT id, order_id, order_name, timestamp, employee, value_after',
    { tool: TOOL_NAME, types: ['preregister'], employees: p.employees,
      search: p.search, dateFrom: p.dateFrom, dateTo: p.dateTo });

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

  // ── ٢) اتحصّل ولا لأ؟ — صف payment في لوج أداة التحصيل بعد وقت التسجيل ──
  const collectedAt = new Map();
  if (byOrder.size) {
    const minTs = regRows[regRows.length - 1].timestamp;
    const col = await env.DB.prepare(`
      SELECT order_id, MAX(timestamp) AS collected_at FROM logs
      WHERE tool = ? AND type = 'payment' AND timestamp >= ?
        AND order_id IN (SELECT order_id FROM logs WHERE tool = ? AND type = 'preregister')
      GROUP BY order_id
    `).bind(PAYMENT_TOOL, minTs, TOOL_NAME).all();
    for (const r of (col.results || [])) collectedAt.set(r.order_id, r.collected_at);
  }

  const items = [];
  for (const r of byOrder.values()) {
    const inKV = kv.ids.has(r.order_id);
    const col  = collectedAt.get(r.order_id);
    const collected = !!col && col >= r.timestamp;
    items.push({
      orderId: r.order_id, orderName: r.order_name, rowId: r.id,
      registeredAt: r.timestamp, registeredBy: r.employee || null,
      amount: r.value_after, registrations: r.registrations, inKV,
      status: inKV ? (collected ? 'stale' : 'pending') : (collected ? 'collected' : 'cleared'),
    });
  }

  // ── ٣) مفاتيح KV من غير صف تسجيل في D1 (مثلاً backlog بوسطة) ──────
  // التفاصيل (الاسم/الوقت) في قيمة المفتاح نفسها، فبنقراها — بسقف. فلتر الموظف
  // بيستبعدها لأن مفيش موظف مسجّل ليها.
  const allReg = new Set((allRegRes.results || []).map(r => r.order_id));
  const orphanIds = [...kv.ids].filter(id => !allReg.has(id));
  let orphansTruncated = false;
  if (orphanIds.length && !(p.employees && p.employees.length)) {
    const slice = orphanIds.slice(0, PENDING_ORPHAN_CAP);
    orphansTruncated = orphanIds.length > slice.length;
    const q = (p.search || '').toLowerCase();
    const vals = await Promise.all(slice.map(async id => [id, safeJSON(await env.PRE_REG_KV.get(`preReg:${id}`))]));
    for (const [id, e] of vals) {
      const day = (e.preRegisteredAt || '').slice(0, 10);
      if (q && !(String(e.orderName || '').toLowerCase().includes(q) || id.includes(q))) continue;
      if (p.dateFrom && !(day && day >= p.dateFrom)) continue;
      if (p.dateTo   && !(day && day <= p.dateTo))   continue;
      items.push({
        orderId: id, orderName: e.orderName || null, rowId: null,
        registeredAt: e.preRegisteredAt || null, registeredBy: null,
        amount: e.amount != null ? Number(e.amount) : null, registrations: 0, inKV: true,
        status: 'kv_only',
        _kv: e,
      });
    }
  }

  // ── ٤) عدّادات الحالات (قبل فلتر الحالة) + الفلترة + الصفحة ────────
  items.sort((a, b2) => String(b2.registeredAt || '').localeCompare(String(a.registeredAt || '')));
  const counts = { all: items.length };
  PD_STATUSES.forEach(s => { counts[s] = 0; });
  items.forEach(i => { counts[i.status] += 1; });

  const filtered = p.statuses && p.statuses.length ? items.filter(i => p.statuses.includes(i.status)) : items;
  const page = filtered.slice(p.offset, p.offset + p.limit);

  // ── ٥) تفاصيل الصفحة بس: D1 (المنتجات/المندوب) + التحصيل + شوبيفاي ──
  const regDetail = new Map();   // rowId → extra
  for (const ch of chunkArray(page.filter(i => i.rowId).map(i => i.rowId))) {
    const r = await env.DB.prepare(`SELECT id, extra FROM logs WHERE id IN (${ch.map(() => '?').join(',')})`)
      .bind(...ch).all();
    for (const row of (r.results || [])) regDetail.set(row.id, safeJSON(row.extra));
  }

  const collDetail = new Map();  // order_id → آخر صف تحصيل بعد وقت التسجيل
  const needColl = page.filter(i => i.status === 'collected' || i.status === 'stale');
  for (const ch of chunkArray(needColl.map(i => i.orderId))) {
    const r = await env.DB.prepare(`
      SELECT order_id, timestamp, employee, value_after, extra FROM logs
      WHERE tool = '${PAYMENT_TOOL}' AND type = 'payment' AND order_id IN (${ch.map(() => '?').join(',')})
      ORDER BY timestamp DESC
    `).bind(...ch).all();
    for (const row of (r.results || [])) if (!collDetail.has(row.order_id)) collDetail.set(row.order_id, row);
  }

  let live = {}, shopify = { ok: true };
  if (page.length) {
    try { live = await getOrdersLiveState(env, page.map(i => i.orderId)); }
    catch (e) { shopify = { ok: false, error: e.message }; }
  }

  const rows = page.map(i => {
    const ex = i.rowId ? (regDetail.get(i.rowId) || {}) : (i._kv || {});
    const c  = collDetail.get(i.orderId);
    const cx = c ? safeJSON(c.extra) : null;
    return {
      orderId: i.orderId, orderName: i.orderName, status: i.status, inKV: i.inKV,
      registeredAt: i.registeredAt, registeredBy: i.registeredBy,
      amount: i.amount, registrations: i.registrations,
      courier: ex.courier || null, lineItems: ex.lineItems || [],
      transactionId: ex.transactionId || null, result: ex.result || null,
      collection: c ? {
        at: c.timestamp, by: c.employee || null, amount: c.value_after,
        courier: cx.courier || null, paymentMethods: cx.paymentMethods || null,
      } : null,
      live: shopify.ok ? (live[i.orderId] || { notFound: true }) : null,
    };
  });

  return {
    rows, total: filtered.length, counts,
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
        const result = await buildPendingDetails(env, {
          statuses:  csv('statuses').filter(s => PD_STATUSES.includes(s)),
          employees: csv('employees'),
          search:    url.searchParams.get('search')   || null,
          dateFrom:  url.searchParams.get('dateFrom') || null,
          dateTo:    url.searchParams.get('dateTo')   || null,
          limit:     Math.min(Math.max(parseInt(url.searchParams.get('limit')  || '100') || 100, 1), 100),
          offset:    Math.max(parseInt(url.searchParams.get('offset') || '0') || 0, 0),
        });
        return json({ ok: true, ...result }, 200, request);
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
