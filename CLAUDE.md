<div dir="rtl" style="text-align: right;">

# تسجيل الدفع المسبق — COD (`COD-Pre-Register-Payment`)

![version](https://img.shields.io/badge/version-v1.1.0-blue)

**بتعمل إيه:** الموظف بيسجّل دفع أوردر COD مسبقًا على شوبيفاي (capture transaction)
قبل التحصيل الفعلي من المندوب، وبيتحطّ مفتاح "معلّق" في KV لحد ما التحصيل يتم.
**مين بيستخدمها:** حسابات · تحصيل COD
**الإصدار:** Worker `v2.1.0` · الواجهة `v2.1.0`   ← الاتنين مستقلين، طبيعي يختلفوا

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
| `checkPending` / `clearPending` / `listPending` | **API داخلي لـ `cod-payment-center-worker` — شكل الرد مقفول، ممنوع تغييره** |
| `import_pending_kv` | ⚠️ **مؤقت** — ترحيل مفاتيح KV من `ecommoda24`. راجع «مسائل مفتوحة» |
| `check_employee` / `register_pin` / `verify_employee` / `log_logout` / `get_employees` | Universal D1 Auth |
| `get_logs` / `get_logs_count` / `get_logs_export` | سجل العمليات (التصدير بيرجّع `cap`/`total`/`truncated`) |
| `diag` / `get_config` | فحص ذاتي + نسخة الـ Worker |

## D1

```
tool  : cod_preregister
type  : preregister · login · logout
```

> مسجّلة في جدول `ecommoda-constants` §7. مفيش جداول D1 إضافية — `logs` و`employees` بس.
> `extra.result` في صفوف `preregister` بياخد `success` أو `warning` (من v2.1.0).
> **الصفوف الأقدم من v2.1.0 مالهاش الحقل ده** — بتتعرض «—» مش «✓»، لأننا فعليًا
> مش عارفين إن كانت كل الخطوات تمّت وقتها.

## KV

```
Binding : PRE_REG_KV → pre-register-payment-cod-KV (aaeff3d84e2c4e87bc7cce6bfd83ce6b)
مفتاح   : preReg:<orderId>   — حالة "معلّق" مؤقتة، مش سجل دائم
مين بيمسحه: cod-payment-center-worker عند التحصيل الفعلي
```

## المضبوط فعليًا في الداشبورد

```
Bindings : DB → ecommoda-dev-logs · PRE_REG_KV → pre-register-payment-cod-KV
Secrets  : WORKER_SECRET · CLIENT_ID · CLIENT_SECRET
Vars     : SHOP_DOMAIN     ← من [vars] في wrangler.toml. مفيش LOCATION_ID (الأداة مش أداة مخزون)
Build watch paths : * (الافتراضي)
```

### تصنيف الـ `env.*`

| النوع | المتغيّرات | التحقق |
|---|---|---|
| **سر** | `WORKER_SECRET` · `CLIENT_ID` · `CLIENT_SECRET` | قيمتها مستحيلة القراءة — يدوي من الداشبورد + **Promote** |
| **var بيفشل لو غاب** | `SHOP_DOMAIN` | من v2.1.0 `assertEnv()` بيوقف العملية برسالة باسمه بدل `https://undefined/...` |
| **var ليه fallback** | **لا شيء** | ✅ مفيش خطر «أرقام غلط بصمت» من متغيّر ضايع |

> `?action=diag` بيفحص التلاتة + D1 + KV + OAuth + صلاحيات شوبيفاي + الـ Origin،
> وبيرجّع **أسماء وأطوال** الأسرار بس — ممنوع أي قيمة.

## CORS

`ALLOWED_ORIGINS` = `['https://ecommoda-dev.github.io']` **بس** — الأداة مالية/كتابة.

> ✅ **اتنضّف 01-09-2026:** `ecommoda24.github.io` (اللي كان كمان قيمة الـ fallback
> `ALLOWED_ORIGINS[0]`) و`ahmedibraheemsb.github.io` اتشالوا —
> `ecommoda-constants` §11 بندي 10 و11 يتقفلوا لهذه الأداة.

## خط الأساس

```
tool='cod_preregister' AND type='preregister'
  عدد الصفوف : 233 · إجمالي المبالغ : 691,877 ج
  آخر صف : 2026-09-01T08:50:38.932Z     (اتقاس 01-09-2026 قبل النقل)
```

```sql
SELECT COUNT(*) AS total_preregister, MAX(timestamp) AS last_row, ROUND(SUM(value_after),2) AS total_value FROM logs WHERE tool = 'cod_preregister' AND type = 'preregister';
```

> ⚠️ الرقم ده **بعد** تنظيف 31-08-2026 اللي شال 175 صف `preregister` مكرر
> (`ecommoda-constants` §11 بند 13). أي مقارنة بأرقام أقدم من التاريخ ده هتغلط.

## فخاخ الأداة دي

- **الأداة مالية — التسجيل مالوش تراجع.** `preRegister` بيعمل capture حقيقي.
  أي تعديل على المسار ده يتراجع مرتين قبل النشر.
- **ترتيب العمليات في `preRegister` مقصود:** الفلوس الأول (خطوة ①)، وبعدها KV
  والميتافيلد وD1. التلاتة دول فشلهم بيدّي **`status: 'warning'`** — مش نجاح ومش
  فشل كامل. عكس الترتيب معناه فلوس متسجّلة من غير أثر، أو أثر من غير فلوس.
- **`checkPending`/`clearPending`/`listPending` عقد مع أداة تانية.** أي تغيير في
  شكل الرد بيكسر `cod-payment-center-worker` من غير أي رسالة.
- **مفاتيح بوسطة في `PRE_REG_KV` مش بقايا — دي backlog.** ❌ ممنوع حذفها.
  القرار كامل في `ecommoda-constants` §11 بند 14.
- `listPending` بيعمل `KV.list()` + `get()` لكل مفتاح في **كل** نداء — كل ما
  الـ backlog يكبر، `getCourierOrders` في أداة التحصيل يبطأ.

## استرجاع النسخ القديمة

```
النسخة القديمة من الواجهة (Index.html بحرف كبير) محفوظة في commit: c26378c
git show c26378c:Index.html
نسخة ما قبل المراجعة الشاملة (Worker v2.0.0 · الواجهة v2.0.0): commit 872332a
git show 872332a:index.js   ·   git show 872332a:index.html
```

## بصمة المهارات

| المهارة | الإصدار وقت آخر تعديل |
|---|---|
| ecommoda-worker-builder | v2.0.0 |
| ecommoda-html-builder | v5.0.0 |
| ecommoda-constants | v1.4.3 |
| shopify-graphql-helper | v1.0.0 |

آخر مطابقة: 01-09-2026 · `index.js` v2.1.0 · `index.html` v2.1.0

🔴 معلّقة:
- **معيار الجداول الموحّد (`data-table-standard`) مش متطبّق على السجل.** السجل
  لسه بطاقات (`.log-entry`) مش جدول — يعني بند ٢٦ في Standards Changelog، و
  **نتيجته**: `--container-max` لسه `700px` (خارج التلات Tiers، والحد الأدنى
  لأداة فيها سجل هو M = `1200px`). ده **redesign بصري** مش إصلاح، ومؤجَّل بقرار
  لحد ما يتراجع مع صاحب الأداة — تغيير عرض الأداة من 700 لـ 1200 بيقلب شكلها
  بالكامل وهي أداة كارت واحد ضيّق بطبيعتها.
- **فلاتر السجل مش موجودة أصلًا** (مفيش موظف/نوع/تاريخ). الـ Worker بقى بيدعمها
  بالكامل (`buildLogFilterSQL` + `logParamsFrom` + CSV)، والواجهة فيها
  `logParams()` كمصدر واحد جاهز — فإضافتها بقت وصل أسلاك، مش بناء.

## مسائل مفتوحة

- **`import_pending_kv` endpoint مؤقت لسه منشور.** معلَّم في الكود إنه لترحيل KV
  من `ecommoda24`. **ملحوظة:** هو `KV.put` بمفتاح معلوم، يعني idempotent بطبيعته
  — مش نفس خطورة `import_logs` اللي كتب 925 صف مكرر. برضه مرشّح للحذف فور تأكيد
  إن الترحيل خلص (`ecommoda-constants` §11 بند 13).
- **بيانات العميل (الاسم/التليفون).** الواجهة جاهزة لعرضها من زمان
  (`customerBox` + سطور في نافذة التأكيد)، لكن `preview` في الـ Worker
  **مش بيرجّعها** — فالصندوق بيفضل مخفي دايمًا. إضافتها محتاجة صلاحية
  `read_customers` على تطبيق شوبيفاي (ولو مش موجودة، الاستعلام كله هيفشل بـ
  ACCESS_DENIED ويكسر `preview`)، **وقرار صريح** لأنها بيانات شخصية. متضافش من
  غير ما تتأكد من الصلاحية الأول بـ `?action=diag`.
- **Build watch paths لسه `*` (الافتراضي)** — أي تعديل واجهة بينشر الـ Worker
  تاني بنفس الكود. التضييق على `index.js` + `wrangler.toml`
  (`ecommoda-tool-migration-playbook` §13-ب) اختياري ولسه ما اتعملش.

آخر تحديث: 01-09-2026 — 14:30

</div>
