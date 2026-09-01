<div dir="rtl" style="text-align: right;">

# تسجيل الدفع المسبق — COD (`COD-Pre-Register-Payment`)

![version](https://img.shields.io/badge/version-v1.4.0-blue)

**بتعمل إيه:** الموظف بيسجّل دفع أوردر COD مسبقًا على شوبيفاي (capture transaction)
قبل التحصيل الفعلي من المندوب، وبيتحطّ مفتاح "معلّق" في KV لحد ما التحصيل يتم.
**مين بيستخدمها:** حسابات · تحصيل COD
**الإصدار:** Worker `v2.4.0` · الواجهة `v2.3.0`   ← الاتنين مستقلين، طبيعي يختلفوا

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
| `check_employee` / `register_pin` / `verify_employee` / `log_logout` / `get_employees` | Universal D1 Auth |
| `get_logs` / `get_logs_count` / `get_logs_export` | سجل العمليات — فلترة (`employees` · `search` · `dateFrom`/`dateTo`) وترتيب (`sortKey`/`sortDir`) وصفحات، كلهم server-side. التصدير بيرجّع `cap`/`total`/`truncated` |
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
Build watch paths : index.js + wrangler.toml   ← chip منفصل لكل واحد (مضيّقة 01-09-2026)
```

### الترتيب في `get_logs` — whitelist إجباري

```
LOG_SORT_COLUMNS = timestamp · employee · order_name · value_after
```

الترتيب بيتحقن في نص الـ SQL، فأي قيمة جاية من المستخدم **لازم** تعدّي على الـ
whitelist. الأعمدة المشتقّة من `extra` JSON (المندوب · الشحن · المنتجات) مش
موجودة في الجدول، فمش قابلة للترتيب server-side — وعشان كده مالهاش `sortable-th`
في الواجهة أصلاً.

### تصنيف الـ `env.*`

| النوع | المتغيّرات | التحقق |
|---|---|---|
| **سر** | `WORKER_SECRET` · `CLIENT_ID` · `CLIENT_SECRET` | قيمتها مستحيلة القراءة — يدوي من الداشبورد + **Promote** |
| **var بيفشل لو غاب** | `SHOP_DOMAIN` | من v2.1.0 `assertEnv()` بيوقف العملية برسالة باسمه بدل `https://undefined/...` |
| **var ليه fallback** | **لا شيء** | ✅ مفيش خطر «أرقام غلط بصمت» من متغيّر ضايع |

> `?action=diag` بيفحص التلاتة + D1 + KV + OAuth + صلاحيات شوبيفاي + الـ Origin،
> وبيرجّع **أسماء وأطوال** الأسرار بس — ممنوع أي قيمة.

## بيانات العميل — عرض فقط

`preview` بيرجّع `customerName` و`customerPhone` (من `customer.displayName` /
`shippingAddress` مع fallback على `order.phone`). محتاجة صلاحية **`read_customers`**
على تطبيق شوبيفاي — `?action=diag` بيفحصها ضمن الصلاحيات المطلوبة.

> ⛔ **ممنوع تدخل `writeLog` أو `extra` أو التصدير.** السجل بيتصدّر XLSX وبيتقرا
> من أدوات تانية، والبيانات دي شخصية. القرار ده قديم ومقصود — لو اتغيّر يومًا،
> يتكتب هنا الأول.
> ⚠️ ولو الصلاحية اتشالت من التطبيق، الاستعلام **كله** هيفشل بـ `ACCESS_DENIED`
> ويكسر `preview` — مش هيرجّع بيانات ناقصة بصمت.

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

## ⚠️ Build watch paths مضيّقة — بند صيانة دائم

```
Include paths : index.js  ·  wrangler.toml     ← صندوقين منفصلين، كل واحد ليه ×
Exclude paths : (فاضي)
```

معناها إن تعديل `index.html` لوحده **مش** بينشر الـ Worker — وده المطلوب
(الواجهة بتنشر من GitHub Pages). بس ده بيجيب معاه فخ دائم:

> 🔴 **أي ملف جديد يعتمد عليه الـ Worker لازم يتضاف للـ paths.**
> `package.json` · فولدر `src/` · أي ملف config — لو اتضاف من غير ما يتحط هنا،
> الـ Worker هيفضل على نسخة قديمة **من غير أي رسالة ولا build فاشل**.
> نفس شكل الفخ الخامس في `ecommoda-tool-migration-playbook` §13-ب بالظبط.

⚠️ والحقل ده **chips مش نص**: `index.js wrangler.toml` بمسافة = chip واحد
بالاسم ده حرفيًا = **مفيش أي push هيبني تاني، للأبد، في صمت**.

## فخاخ الأداة دي

- 🔴 **حارس عام في نص الـ handler بيبلع كل اللي بعده.** سطر
  `if (!numericId) return 400 'orderId is required'` كان مكتوب **قبل**
  `§LOG-ENDPOINTS`، وendpoints السجل كلها GET (يعني `bodyData = {}` و
  `numericId = null`) — فالتلاتة كانوا بيرجعوا 400 من v2.0.0 ومحدش لاحظ، لأن
  الواجهة القديمة كانت بتبلع الخطأ في توست. **اتصلّح في v2.4.0** بنقل الحارس
  جوه `preview` و`preRegister` بس. القاعدة: **الحارس مكانه جوه الـ endpoint
  اللي محتاجه**، مش سطر عام في نص الـ handler.
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
نسخة ما قبل جدول السجل     (Worker v2.1.0 · الواجهة v2.1.0): commit 31302a2
git show 31302a2:index.html
آخر نسخة فيها endpoint الترحيل import_pending_kv: commit b3f7906
git show b3f7906:index.js
```

## بصمة المهارات

| المهارة | الإصدار وقت آخر تعديل |
|---|---|
| ecommoda-worker-builder | v2.0.0 |
| ecommoda-html-builder | v5.0.0 |
| ecommoda-constants | v1.4.3 |
| shopify-graphql-helper | v1.0.0 |

آخر مطابقة: 01-09-2026 · `index.js` v2.1.0 · `index.html` v2.1.0

🔴 معلّقة: — لا شيء

## السجل — جدول على المعيار الموحّد (v2.2.0)

```
الفلاتر  : بحث (order_name/notes) · فترة سريعة + من/إلى · الموظف (multi-select)
الأعمدة  : التاريخ · الوقت · الموظف · رقم الأوردر · المبلغ · الشحن ·
           تحصيل المندوب · المندوب · المنتجات · النتيجة
الترتيب  : على ٤ أعمدة بس (التاريخ/الوقت · الموظف · رقم الأوردر · المبلغ)
الصفحات  : 100 صف/صفحة
```

**كل حاجة server-side — الفلترة والعدّ والترتيب.** السبب مش تفضيل: السجل مقسّم
صفحات، فالفلترة في المتصفح كانت هتخلي «النتائج» تعدّ الصفحة (100) مش القاعدة،
والصفحة التانية تيجي بلا فلترة، والتصدير ينزّل غير المعروض — كله في السكوت.
ده استثناء صريح من قاعدة «النتائج client-side» في `data-table-standard` §7،
ومنصوص عليه في نفس المعيار (Log Filter Model v2 · Standards #31).

⚠️ **`dateFrom`/`dateTo` بيتقارنوا بـ `timestamp` المخزّن (UTC)، والعرض بتوقيت
القاهرة (+3).** عملية بعد ٩ مساءً بتوقيت القاهرة ممكن تقع في يوم UTC اللي بعده.
مقبول لفلتر بالأيام — بس **مكتوب** عشان مايتكتشفش كباج بعدين.

## التابات

```
📋 تسجيل الدفع    ← الاستعلام + كارت الأوردر + زرار التسجيل + النتيجة
📜 سجل العمليات   ← القسم الموحّد (فلاتر + جدول)
```

`.main-tabs-bar` / `.main-tab-btn` + **Freeze on Scroll**: الهيدر بيتقفل مضغوط
وشريط التابات بيتحوّل لـ chip فيه قائمة تبديل. الـ toggle بـ **عتبتين**
(`STICK_ON = 40` / `STICK_OFF = 12`) + `requestAnimationFrame` — العتبة الواحدة
بتعمل فليكر عالق عند نقطة القفل (باج متحقَّق، `tabs-and-modals.md` §1b).

**السجل lazy** — `get_logs` مابيتنداش غير أول ما الموظف يفتح تاب السجل فعلاً.

## تقارير خارجة عن الأداة

| الملف | إيه ده |
|---|---|
| `docs/BUG-multi-select-menu-closes.md` | 🐞 باج في **`ecommoda-html-builder`** نفسها (`templates/24_data-table-section.html`) — القائمة المنسدلة بتتقفل بعد أول اختيار. اتصلّح محليًا هنا في الواجهة v2.2.0، ومستنّي ينزل على المهارة في جلسة منفصلة. |

## مسائل مفتوحة

— لا شيء.

آخر تحديث: 01-09-2026 — 18:20

</div>
