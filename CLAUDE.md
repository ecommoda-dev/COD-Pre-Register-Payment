# تسجيل الدفع المسبق — COD (`COD-Pre-Register-Payment`)

**بتعمل إيه:** الموظف بيسجّل دفع أوردر COD مسبقًا على شوبيفاي (capture transaction)
قبل التحصيل الفعلي من المندوب، وبيتحطّ مفتاح "معلّق" في KV لحد ما التحصيل يتم.
**مين بيستخدمها:** حسابات · تحصيل COD
**الإصدار:** Worker `v2.0.0` · الواجهة `v2.0.0`   ← الاتنين مستقلين، طبيعي يختلفوا

## الروابط

```
الواجهة    : https://ecommoda-dev.github.io/COD-Pre-Register-Payment/
الـ Worker : https://cod-pre-register-payment-worker.ecommoda-dev.workers.dev
اسم الـ Worker في الداشبورد: cod-pre-register-payment-worker
```

## الـ Endpoints

| `?action=` | بيعمل إيه |
|---|---|
| `resolveByName` | رقم الأوردر → numeric ID |
| `preview` | بيانات الأوردر + هل مسجَّل مسبقًا في KV |
| `preRegister` | capture على شوبيفاي + مفتاح KV + ميتافيلد + سجل D1 |
| `checkPending` / `clearPending` / `listPending` | API لـ `cod-payment-center-worker` |
| `import_pending_kv` | ⚠️ **مؤقت** — ترحيل مفاتيح KV من `ecommoda24`. راجع «مسائل مفتوحة» |
| `check_employee` / `register_pin` / `verify_employee` / `log_logout` / `get_employees` | Universal D1 Auth |
| `get_logs` / `get_logs_count` / `get_logs_export` | سجل العمليات |

## D1

```
tool  : cod_preregister
type  : preregister · login · logout
```

> مسجّلة في جدول `ecommoda-constants` §7. مفيش جداول D1 إضافية — `logs` و`employees` بس.

## KV

```
Binding : PRE_REG_KV → pre-register-payment-cod-KV (aaeff3d84e2c4e87bc7cce6bfd83ce6b)
مفتاح   : preReg:<orderId>   — حالة "معلّق" مؤقتة، مش سجل دائم
مين بيمسحه: cod-payment-center-worker عند التحصيل الفعلي
```

## المضبوط فعليًا في الداشبورد

> اللي **متظبط بالفعل** — مش اللي المفروض يكون.

```
Bindings : DB → ecommoda-dev-logs · PRE_REG_KV → pre-register-payment-cod-KV
Secrets  : WORKER_SECRET · CLIENT_ID · CLIENT_SECRET
Vars     : SHOP_DOMAIN     ← من [vars] في wrangler.toml. مفيش LOCATION_ID (الأداة مش أداة مخزون)
Build watch paths : * (الافتراضي)
```

### تصنيف الـ `env.*` (من فحص الكود — `ecommoda-tool-migration-playbook` §4-أ-٢)

| النوع | المتغيّرات | التحقق |
|---|---|---|
| **سر** | `WORKER_SECRET` · `CLIENT_ID` · `CLIENT_SECRET` | قيمتها مستحيلة القراءة — يدوي من الداشبورد + **Promote** |
| **var بيفشل لو غاب** | `SHOP_DOMAIN` | غيابه = كل نداء Shopify بيضرب `https://undefined/...` وبيرمي |
| **var ليه fallback** | **لا شيء** | ✅ الأداة دي مالهاش الصف التالت — يعني مفيش خطر «أرقام غلط بصمت» من متغيّر ضايع |

## CORS

`ALLOWED_ORIGINS` **صارمة** (مش wildcard) — لأن الأداة **مالية/كتابة**
(بتعمل capture حقيقي على شوبيفاي). القايمة الحالية فيها دومينين مهجورين —
راجع «مسائل مفتوحة».

## خط الأساس بعد النقل

> الأرقام قبل النقل مباشرةً — من D1، مرجع لأي شك بعد كده.

```
tool='cod_preregister' AND type='preregister'
  عدد الصفوف : 233
  إجمالي المبالغ : 691,877 ج
  آخر صف : 2026-09-01T08:50:38.932Z
  (اتقاس 01-09-2026 قبل النقل)
```

```sql
SELECT COUNT(*) AS total_preregister, MAX(timestamp) AS last_row, ROUND(SUM(value_after),2) AS total_value FROM logs WHERE tool = 'cod_preregister' AND type = 'preregister';
```

> ⚠️ الرقم ده **بعد** تنظيف 31-08-2026 اللي شال 175 صف `preregister` مكرر
> (`ecommoda-constants` §11 بند 13). أي مقارنة بأرقام أقدم من التاريخ ده هتغلط.

## فخاخ الأداة دي

- **الأداة مالية — التسجيل مالوش تراجع.** `preRegister` بيعمل capture حقيقي على
  شوبيفاي. أي تعديل على المسار ده يتراجع مرتين قبل النشر.
- **ترتيب العمليات في `preRegister` مقصود:** الفلوس الأول (خطوة ١)، وبعدها KV
  والميتافيلد وD1 — التلاتة دول **غير حرجة** وفشلهم متعمّد إنه ميوقفش العملية.
  عكس الترتيب معناه فلوس متسجّلة من غير أثر، أو أثر من غير فلوس.
- **مفاتيح بوسطة في `PRE_REG_KV` مش بقايا — دي backlog.** ❌ ممنوع حذفها.
  القرار كامل في `ecommoda-constants` §11 بند 14.
- `listPending` بيعمل `KV.list()` + `get()` لكل مفتاح في **كل** نداء — كل ما
  الـ backlog يكبر، `getCourierOrders` في أداة التحصيل يبطأ.

## استرجاع النسخ القديمة

> ده بديل الـ tags — دفع الـ tags ممنوع من جلسات Claude Code السحابية.

```
النسخة القديمة من الواجهة (Index.html بحرف كبير) محفوظة في commit: c26378c
git show c26378c:Index.html
```

## بصمة المهارات

| المهارة | الإصدار وقت آخر تعديل |
|---|---|
| ecommoda-worker-builder | v2.0.0 |
| ecommoda-html-builder | v5.0.0 |
| ecommoda-constants | v1.4.3 |
| shopify-graphql-helper | v1.0.0 |

آخر مطابقة: 01-09-2026 · `index.js` v2.0.0 · `index.html` v2.0.0
🔴 معلّقة: تنظيف الدومينات المهجورة من `ALLOWED_ORIGINS` (`ecommoda-constants`
§11 بندي 10 و11) — **مؤجَّل بوعي**: النقل لازم يخرج بـ `index.js` مطابق
بايت ببايت للنسخة المنشورة، فأي تعديل كود بيبطّل الدليل ده. يتعمل في PR منفصل
بعد ما البناء يبقى أخضر.

## مسائل مفتوحة

- **`ALLOWED_ORIGINS` فيها دومينين مهجورين:** `ecommoda24.github.io` (وهو كمان
  **قيمة الـ fallback** `ALLOWED_ORIGINS[0]`) و`ahmedibraheemsb.github.io`.
  القرار اتحسم في `ecommoda-constants` §11 بند 11 — التنفيذ لسه.
  ⚠️ ولاحظ ترتيب المصفوفة مش وجود القيمة بس: أي origin غير معروف حاليًا بياخد
  ترويسة CORS بدومين مهجور.
- **`import_pending_kv` endpoint مؤقت لسه منشور.** معلَّم في الكود إنه لترحيل
  KV من `ecommoda24`، ومفيهوش أي idempotency. نفس شكل `import_logs` اللي كتب
  925 صف مكرر في أداة تانية (`ecommoda-constants` §11 بند 13). **مرشّح للحذف
  فور تأكيد إن الترحيل خلص.**
- **Build watch paths لسه `*` (الافتراضي)** — يعني أي تعديل واجهة بينشر الـ
  Worker تاني بنفس الكود. التضييق على `index.js` + `wrangler.toml` اختياري
  (`ecommoda-tool-migration-playbook` §13-ب) ولسه ما اتعملش.
