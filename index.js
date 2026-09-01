/**
 * cod-pre-register-payment-worker  (v2.0.0 — D1 migration، ecommoda-dev)
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
 *   preview        – fetch order data + check KV for existing pre-registration
 *   preRegister    – mark as paid on Shopify + save KV + set metafield + D1 log
 *   checkPending / clearPending / listPending — API لـ cod-payment-center-worker
 *   check_employee / register_pin / verify_employee / log_logout / get_employees — Universal D1 Auth
 *   get_logs / get_logs_count / get_logs_export — tool=cod_preregister
 *   import_pending_kv — مؤقت: لترحيل التسجيلات المعلّقة من KV القديم (ecommoda24)
 *
 * D1: tool = 'cod_preregister' | type = 'preregister' / 'login' / 'logout'
 */

// ══════════════════════════════════════════════════════
// §CONSTANTS
// ══════════════════════════════════════════════════════
const TOOL_NAME = 'cod_preregister';

// ══════════════════════════════════════════════════════
// §CORS
// ══════════════════════════════════════════════════════
const ALLOWED_ORIGINS = [
  'https://ecommoda24.github.io',
  'https://ecommoda-dev.github.io',
  'https://ahmedibraheemsb.github.io',
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

async function writeLog(db, entry) {
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
    entry.extra ? JSON.stringify(entry.extra) : null
  ).run();
}

async function getLogs(db, { tool = null, employee = null, type = null, search = null, limit = 100, offset = 0 } = {}) {
  let sql = "SELECT * FROM logs WHERE type NOT IN ('login','logout')";
  const b = [];
  if (tool)     { sql += ' AND tool = ?';     b.push(tool); }
  if (employee) { sql += ' AND employee = ?'; b.push(employee); }
  if (type)     { sql += ' AND type = ?';     b.push(type); }
  if (search)   { sql += ' AND (order_name LIKE ? OR notes LIKE ?)'; b.push(`%${search}%`, `%${search}%`); }
  sql += ' ORDER BY timestamp DESC LIMIT ? OFFSET ?';
  b.push(Math.min(limit, 100), offset);
  return (await db.prepare(sql).bind(...b).all()).results;
}

async function getLogsCount(db, { tool = null, employee = null, search = null } = {}) {
  let sql = "SELECT COUNT(*) as total FROM logs WHERE type NOT IN ('login','logout')";
  const b = [];
  if (tool)     { sql += ' AND tool = ?';     b.push(tool); }
  if (employee) { sql += ' AND employee = ?'; b.push(employee); }
  if (search)   { sql += ' AND (order_name LIKE ? OR notes LIKE ?)'; b.push(`%${search}%`, `%${search}%`); }
  const row = await db.prepare(sql).bind(...b).first();
  return row?.total ?? 0;
}

async function getLogsExport(db, { tool = null, employee = null, search = null } = {}) {
  let sql = "SELECT * FROM logs WHERE type NOT IN ('login','logout')";
  const b = [];
  if (tool)     { sql += ' AND tool = ?';     b.push(tool); }
  if (employee) { sql += ' AND employee = ?'; b.push(employee); }
  if (search)   { sql += ' AND (order_name LIKE ? OR notes LIKE ?)'; b.push(`%${search}%`, `%${search}%`); }
  sql += ' ORDER BY timestamp DESC LIMIT 2000';
  return (await db.prepare(sql).bind(...b).all()).results;
}

// ══════════════════════════════════════════════════════
// §SHOPIFY
// ══════════════════════════════════════════════════════

async function getAccessToken(env) {
  const res = await fetch(`https://${env.SHOP_DOMAIN}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'client_credentials',
      client_id:     env.CLIENT_ID,
      client_secret: env.CLIENT_SECRET,
    }),
  });
  const data = await res.json();
  return data.access_token || null;
}

async function getOrderDataById(env, numericId) {
  const token = await getAccessToken(env);
  if (!token) throw new Error('Failed to get Shopify access token');

  const query = `
    query getOrderById($id: ID!) {
      order(id: $id) {
        id name canMarkAsPaid displayFinancialStatus
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

  const res = await fetch(`https://${env.SHOP_DOMAIN}/admin/api/2026-01/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables: { id: `gid://shopify/Order/${numericId}` } }),
  });

  const data = await res.json();
  const order = data?.data?.order;
  if (!order) return null;

  const outstanding    = parseFloat(order.totalOutstandingSet?.shopMoney?.amount || '0');
  const subtotal       = parseFloat(order.subtotalPriceSet?.shopMoney?.amount || '0');
  const shippingAmount = parseFloat(order.shippingLine?.originalPriceSet?.shopMoney?.amount || '0');
  const canMarkAsPaid  = order.canMarkAsPaid;
  const financialStatus = order.displayFinancialStatus;
  const courier        = order.courierMeta?.value || null;

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
  const res = await fetch(`https://${env.SHOP_DOMAIN}/admin/api/2026-01/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables: { query: `name:#${orderNumber}` } }),
  });
  const data = await res.json();
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
  const data = await res.json();
  if (res.ok && data.transaction?.id) return { success: true, transactionId: data.transaction.id };
  return { success: false, error: data.errors ? JSON.stringify(data.errors) : `HTTP ${res.status}` };
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
  const res = await fetch(`https://${env.SHOP_DOMAIN}/admin/api/2026-01/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({
      query: mutation,
      variables: {
        metafields: [{
          ownerId:   `gid://shopify/Order/${numericId}`,
          namespace: 'custom',
          key:       'pre_register_payment',
          value:     'Pre-Registered Payment',
          type:      'single_line_text_field',
        }],
      },
    }),
  });
  const data = await res.json();
  const errors = data?.data?.metafieldsSet?.userErrors;
  if (errors && errors.length > 0) throw new Error(errors[0].message);
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
        await writeLog(env.DB, { tool: TOOL_NAME, type: 'login', employee: username, notes: `دخول: ${displayName}` });
        return json({ ok: true, displayName }, 200, request);
      }

      if (action === 'log_logout') {
        const username = url.searchParams.get('username');
        if (username) {
          await writeLog(env.DB, { tool: TOOL_NAME, type: 'logout', employee: username, notes: `خروج: ${username.replace(/_/g, ' ')}` });
        }
        return json({ ok: true }, 200, request);
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

      // ── ⚠️ import_pending_kv — مؤقت، لترحيل PRE_REG_KV من ecommoda24 ──
      // بياخد { entries: [{key, value}] } زي ما هي من export_pending_kv
      // بتاعة الأداة القديمة، ويكتبها في PRE_REG_KV الجديدة حرفيًا.
      if (action === 'import_pending_kv') {
        if (request.method !== 'POST') return json({ ok: false, error: 'POST required' }, 405, request);
        const { entries } = bodyData;
        if (!Array.isArray(entries)) return json({ ok: false, error: 'entries array required' }, 400, request);
        let imported = 0;
        for (const e of entries) {
          if (!e.key || e.value === undefined) continue;
          await env.PRE_REG_KV.put(e.key, typeof e.value === 'string' ? e.value : JSON.stringify(e.value));
          imported++;
        }
        return json({ ok: true, imported }, 200, request);
      }

      if (!numericId) return json({ error: 'orderId is required' }, 400, request);

      // ── preview ───────────────────────────────────────────────────
      if (action === 'preview') {
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
          lineItems:             orderData.lineItems,
          alreadyPreRegistered:  !!existing,
          registeredAt:          existing ? JSON.parse(existing).preRegisteredAt : null,
        }, 200, request);
      }

      // ── preRegister ───────────────────────────────────────────────
      if (action === 'preRegister') {
        const { amount, orderName, subtotal, shippingAmount, courier, lineItems, employee } = bodyData;
        if (!amount) return json({ error: 'amount is required' }, 400, request);

        const parsedAmount = parseFloat(amount);
        if (isNaN(parsedAmount) || parsedAmount <= 0) {
          return json({ error: 'Invalid amount' }, 400, request);
        }

        const token = await getAccessToken(env);
        if (!token) return json({ success: false, error: 'Failed to get Shopify access token' }, 200, request);

        // 1. تسجيل الدفع على شوبيفاي
        const txResult = await createTransaction(token, env, numericId, parsedAmount.toFixed(2));
        if (!txResult.success) return json({ success: false, error: txResult.error }, 200, request);

        // 2. حفظ في KV — إشارة "معلّق للتحصيل الفعلي"
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
        await env.PRE_REG_KV.put(`preReg:${numericId}`, JSON.stringify(kvEntry));

        // 3. الميتافيلد — أثر دائم على شوبيفاي (غير حرج: فشله ميوقفش العملية)
        try {
          await setPreRegMetafield(token, env, numericId);
        } catch (e) {
          console.warn('Metafield set failed (non-critical):', e.message);
        }

        // 4. D1 — سجل دائم (غير حرج: فشله ميوقفش العملية بعد ما الفلوس اتسجلت)
        try {
          await writeLog(env.DB, {
            tool: TOOL_NAME, type: 'preregister', employee: employee || null,
            orderId: numericId, orderName: orderName || null,
            valueAfter: parsedAmount, notes: null,
            extra: { courier: courier || null, lineItems: lineItems || [], subtotal: subtotal || null, shippingAmount: shippingAmount || null },
          });
        } catch (e) {
          console.warn('D1 writeLog failed (non-critical):', e.message);
        }

        return json({ success: true, orderId: numericId, transactionId: txResult.transactionId }, 200, request);
      }

      // ─── §LOG-ENDPOINTS ─────────────────────────────────────────
      if (action === 'get_logs') {
        const entries = await getLogs(env.DB, {
          tool:     url.searchParams.get('tool')     || TOOL_NAME,
          employee: url.searchParams.get('employee') || null,
          type:     url.searchParams.get('type')     || null,
          search:   url.searchParams.get('search')   || null,
          limit:    parseInt(url.searchParams.get('limit')  || '100'),
          offset:   parseInt(url.searchParams.get('offset') || '0'),
        });
        return json({ ok: true, entries }, 200, request);
      }

      if (action === 'get_logs_count') {
        const total = await getLogsCount(env.DB, {
          tool:     url.searchParams.get('tool')     || TOOL_NAME,
          employee: url.searchParams.get('employee') || null,
          search:   url.searchParams.get('search')   || null,
        });
        return json({ ok: true, total }, 200, request);
      }

      if (action === 'get_logs_export') {
        const entries = await getLogsExport(env.DB, {
          tool:     url.searchParams.get('tool')     || TOOL_NAME,
          employee: url.searchParams.get('employee') || null,
          search:   url.searchParams.get('search')   || null,
        });
        return json({ ok: true, entries }, 200, request);
      }
      // ──────────────────────────────────────────────────────────────

      return json({ error: `Unknown action: ${action}` }, 400, request);

    } catch (err) {
      return json({ error: err.message }, 500, request);
    }
  },
};
