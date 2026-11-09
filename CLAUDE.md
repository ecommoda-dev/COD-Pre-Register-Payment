<div dir="rtl" style="text-align: right;">

# تسجيل الدفع المسبق — COD (`COD-Pre-Register-Payment`)

![version](https://img.shields.io/badge/version-v1.6.0-blue)

**بتعمل إيه:** الموظف بيسجّل دفع أوردر COD مسبقًا على شوبيفاي (capture transaction)
قبل التحصيل الفعلي من المندوب، وبيتحطّ مفتاح "معلّق" في KV لحد ما التحصيل يتم.
**مين بيستخدمها:** حسابات · تحصيل COD
**الإصدار:** Worker `v2.8.0` · الواجهة `v2.7.0`   ← الاتنين مستقلين، طبيعي يختلفوا

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
| `get_logs` / `get_logs_count` / `get_logs_export` / `get_logs_facets` | سجل العمليات — فلترة (`employees` · `results` (`success`/`warning`/`none`) · `orders` · `amountFrom`/`amountTo` · `search` · `dateFrom`/`dateTo` — **يوم بتوقيت القاهرة**) وترتيب (`sortKey`/`sortDir`) وصفحات، كلهم server-side. `get_logs_facets` بيرجّع عدّاد كل موظف/نتيجة مقابل الفلاتر التانية. التصدير بيرجّع `cap`/`total`/`truncated` |
| `pending_details` | تاب «المعلّقة والمحصّلة» — **GET · قراءة بس.** KV + D1 (التسجيل + التحصيل) + شوبيفاي الحية بنداء `nodes` واحد. فلترة (`statuses` · `employees` · `orders` · `amountFrom`/`amountTo` · `dateFrom`/`dateTo` · `timeFrom`/`timeTo` · `couriers` · `items` · `cAmountFrom`/`cAmountTo` · `cDateFrom`/`cDateTo` · `cTimeFrom`/`cTimeTo` (التحصيل) · `custs` · `fins` · `s1` · `s2` — القوايم الحرّة بتتفصل بـ `\|\|`) وترتيب (`sortKey`/`sortDir` — whitelist `PD_SORT`) وصفحات (≤100)، كلهم server-side. بيرجّع `facets` (عدّاد كل حالة/موظف/مندوب/SKU/حالة شوبيفاي/S1/S2 مقابل الفلاتر التانية) و`liveBlocked` لو فلتر حي اتجاوز السقف endpoint **منفصل** عن `listPending` (شكل ردّه مقفول) |
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

## تاب «المعلّقة والمحصّلة» (`pending_details`)

```
المصادر : KV (معلّق دلوقتي) · D1 cod_preregister/preregister (مين/متى/بكام)
          · D1 cod_payment/payment (لوج أداة التحصيل — بنقراه بس) · شوبيفاي nodes(ids)
الحالات : pending · collected · stale · cleared · kv_only
السقف   : ٢٠٠٠ تسجيل (PENDING_DETAILS_CAP) — لو اتجاوز: truncated + تنبيه في الواجهة
التصدير : مفيش (قرار 09-11-2026)
```

| الحالة | المعنى |
|---|---|
| `pending` | المفتاح في KV ومفيش صف تحصيل بعد وقت التسجيل |
| `collected` | المفتاح اتمسح وفيه صف `cod_payment/payment` بعد وقت التسجيل |
| `stale` | **اتحصّل فعلاً والمفتاح لسه في KV** (`clearPendingPreReg` بيبلع أي فشل في المسح) |
| `cleared` | المفتاح مش في KV ومفيش تحصيل مسجّل — اتمسح/اتحصّل بطريق مش بيكتب لوج/اتلغى. **مش «اتحصّل»** |
| `kv_only` | مفتاح KV مالوش صف تسجيل في D1 (مثلاً backlog بوسطة) — مقروء من قيمة المفتاح، بسقف ٢٠٠ |

- ⚠️ **بيعتمد على شكل لوج أداة تانية:** `tool='cod_payment' AND type='payment'` + `order_id`.
  لو `cod-payment-center-worker` غيّر القيمتين دول، `collected` بتتحوّل لـ `cleared` **من غير أي خطأ**.
- **حد D1: ١٠٠ باراميتر في الاستعلام** — أي `IN (...)` على قايمة بييجي عبر `chunkArray()` (٥٠).
  استعلام «اتحصّل ولا لأ» بيستخدم subquery مش قايمة باراميترات.
- **فشل شوبيفاي مش بيوقّع الـ endpoint:** بيرجّع `shopify: { ok:false, error }` والصفوف من KV+D1.
  (عكس `preview` اللي بيفشل كله مع `ACCESS_DENIED`.)
- **كل أعمدة الجدول (١٥) ليها فلتر** (قرار 09-11-2026، كان قبلها المندوب والمنتجات والعميل وشوبيفاي مالهمش). **التاريخ والوقت أعمدة منفصلة** للتسجيل وللتحصيل (`regDate`/`regTime`/`collDate`/`collTime`) بفلتر وترتيب لكل واحد — `datetime-format.md` § 4b، والخلايا `nowrap` فعلًا (`td.col-num`).
- **S1 / S2** = ميتافيلدز `custom.manual_status` / `custom.status_2_r_e` (من `getOrdersLiveState`) — قيم الفلتر حرفيًا من `ecommoda-order-lifecycle`، فلو اتغيّرت الـ choice list لازم `S1_VALUES`/`S2_VALUES` في الواجهة تتحدّث.
- **عمود التحصيل = مبلغ الأوردر ده بس** (`value_after` من صف `cod_payment/payment`) — مش طرق الدفع ومش إجمالي الجلسة. بيتجاب بنفس استعلام `MAX(timestamp)` (SQLite بيجيب باقي الأعمدة من نفس الصف) فمفيش استعلام تاني للصفحة.
- 🔴 **الفلاتر الحية (العميل · شوبيفاي الآن · S1 · S2) محتاجة شوبيفاي لكل الأوردرات المطابقة** قبل تقسيم الصفحات، فالـ Worker بيحدّها بـ `PD_LIVE_FILTER_CAP = 250` وبيرجّع `liveBlocked` (`too_many` / `shopify_failed`) — **مفيش فلترة صامتة على جزء من الداتا**. المجموعة `LIVE_CHUNK = 50` (تكلفة الأوردر ~٩ نقاط شوبيفاي) بالتسلسل، وكاش ٢ دقيقة في ذاكرة الـ isolate **بس** (ممنوع KV/D1 — بيانات شخصية). وقت فيه فلتر حي، عدّادات القوايم العادية بتبان «—» (مش بتتحسب على كل الصفوف).
- ⛔ **بيانات العميل في رد الـ endpoint ده بس** — ممنوع `writeLog`/`extra`/تصدير (نفس قاعدة `preview`).
- **الفلاتر في رأس العمود** (معيار `data-table-standard.md`) — القسم الموحّد: صف نتائج ← chips ← جدول بعناوين ثابتة وعرض أعمدة بالسحب. CSS الجدول مقيَّد بـ `.tbx` عشان ما يلمسش تاب السجل (لسه على الشكل القديم).
- **الترتيب server-side**، ومفاتيح `data-sort` في الواجهة (`SORTMAP`) لازم تطابق `PD_SORT` في الـ Worker حرفيًا — مفتاح مش فيها بيرجع للافتراضي في صمت. المنتجات والعميل وشوبيفاي الآن وS1 وS2 **قابلة للفلترة بس** (مشتقّة من `extra` أو من شوبيفاي الحية)؛ المندوب ومبلغ التحصيل وتاريخ/وقت التحصيل قابلين للترتيب كمان.
- **استثناءات واعية من المعيار:** فلتر رقم الأوردر بدون اقتراحات لايف (محتاجة نداء للسيرفر مع كل حرف) · فلتر المبلغ نطاق بس (قايمة القيم مالهاش معنى).
- **التاريخ والوقت بتوقيت القاهرة (Intl)**: الفلترة الدقيقة في الـ Worker في الذاكرة، والـ SQL بيوسّع التاريخ يوم من كل طرف عشان فرق UTC ما يضيّعش صفوف. (السجل `get_logs` بقى بيقارن حدود اليوم بتوقيت القاهرة كمان — `cairoMidnightUTC()`.)
- الحالة بتتحسب على **كل** الصفوف قبل الصفحات (الفلتر والعدّادات صح)، والتفاصيل والنداء لشوبيفاي على الصفحة المعروضة بس.
- نفس الأوردر مسجّل أكتر من مرة: بيتعرض الأحدث بس مع «اتسجّل N مرات».

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
- 🎨 **`.data-table tbody td` فيها `white-space:nowrap` — وسبيسيفيتها (0,1,2) أعلى
  من أي كلاس خلية لوحده (0,1,0).** عمود المنتجات كان مكتوب `.items-cell{white-space:normal}`
  فماكانش بيتطبّق، والنص كان بيخرج **برة حدود الخلية** بدل ما يلف جوه الـ `max-width`.
  اتصلّح في الواجهة v2.3.1 بكتابتها `.data-table tbody td.items-cell`.
  القاعدة: **أي خلية عايزة تلف لازم تتكتب بنفس تخصيص القاعدة العامة أو أعلى.**
- 🎨 **الفعل بيغذّي شرطه — عتبة القفل لازم تتقاس مش تتكتب.** قفل الهيدر بيقلّل
  ارتفاعه **فوق منطقة العرض**، والمتصفح (scroll anchoring) بيحافظ على المحتوى
  مكانه فبيطرح فرق الارتفاع من `scrollY` نفسه. الفرق هنا **42px** والباند القديم
  (40/12) كان **28px** — أضيق من الارتداد، فالهيدر كان يقفل ويفتح في لوب.
  اتقاس على Chromium: سكرول بطيء من أول الصفحة **٨ تبديلات `.stuck` → ١** بعد
  الإصلاح. اتصلّح في الواجهة v2.3.2 بـ `measureSticky()`.
  القاعدة: **أي حالة `on/off` بتتحدد من `scrollY` وتغييرها بيحرّك `scrollY` نفسه
  — الـ hysteresis لازم تكون أوسع من الحركة اللي بتسبّبها.** والـ
  `requestAnimationFrame` بيبطّأ اللوب مش بيمنعه.

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
| ecommoda-worker-builder | v3.7.1 |
| ecommoda-html-builder | v8.7.0 |
| ecommoda-constants | v3.1.0 |
| shopify-graphql-helper | v1.0.0 |

آخر مطابقة: 09-11-2026 · `index.js` v2.8.0 · `index.html` v2.7.0

🔴 معلّقة: — لا شيء

## السجل — جدول على المعيار الموحّد (فلاتر رأس العمود — v2.6.0)

```
الفلاتر  : في رأس العمود — التاريخ (أقسام) · الموظف (multi) · رقم الأوردر (توكنز Enter) ·
           المبلغ (نطاق) · النتيجة (multi: تم / تم جزئيًا / غير معروف)
الأعمدة  : التاريخ · الوقت · الموظف · رقم الأوردر · المبلغ · الشحن ·
           تحصيل المندوب · المندوب · المنتجات · النتيجة
الترتيب  : على ٤ مفاتيح بس (التاريخ/الوقت · الموظف · رقم الأوردر · المبلغ) — LOG_SORT_COLUMNS
الصفحات  : 100 صف/صفحة — والـ chips والعدّادات جنب القيم من get_logs_facets
```

**كل حاجة server-side — الفلترة والعدّ والترتيب.** السبب مش تفضيل: السجل مقسّم
صفحات، فالفلترة في المتصفح كانت هتخلي «النتائج» تعدّ الصفحة (100) مش القاعدة،
والصفحة التانية تيجي بلا فلترة، والتصدير ينزّل غير المعروض — كله في السكوت.
ده استثناء صريح من قاعدة «النتائج client-side» في `data-table-standard` §7،
ومنصوص عليه في نفس المعيار (Log Filter Model v2 · Standards #31).

✅ **`dateFrom`/`dateTo` = يوم بتوقيت القاهرة** (من v2.7.0): حدود اليوم بتتحسب بـ
`cairoMidnightUTC()` (Intl — +2 شتاءً و+3 صيفًا) وبتتقارن بـ `timestamp` المخزّن (UTC).
قبل كده كانت `substr(timestamp,1,10)` على UTC فعملية بعد ٩/١٠ مساءً كانت بتقع في يوم تاني.

⚠️ **فلتر النتيجة بيقرا `extra.result` بـ `json_extract` جوه SQL** (`LOG_RESULT_SQL`، محروس بـ
`json_valid`) — الصفوف الأقدم من v2.1.0 مالهاش الحقل فبتتعدّ `none` («غير معروف»، مش «تم»).
⚠️ **عمود «الوقت» بلا فلتر** عن قصد: وقت اليوم بتوقيت القاهرة مش بيتحسب جوه SQL (الإزاحة متغيّرة).
**فلتر رقم الأوردر بدون اقتراحات لايف** (محتاجة نداء مع كل حرف) · **المبلغ نطاق بس**.
الشحن وتحصيل المندوب والمندوب والمنتجات مشتقّة من `extra` — بلا فلتر ولا ترتيب.

## التابات

```
📋 تسجيل الدفع    ← الاستعلام + كارت الأوردر + زرار التسجيل + النتيجة
📜 سجل العمليات   ← القسم الموحّد (فلاتر + جدول)
⏳ المعلّقة والمحصّلة ← كل الأوردرات المسجّلة مسبقًا بحالتها (بدون تصدير)
```

`.main-tabs-bar` / `.main-tab-btn` + **Freeze on Scroll**: الهيدر بيتقفل مضغوط
وشريط التابات بيتحوّل لـ chip فيه قائمة تبديل. الـ toggle بـ **عتبتين**
(`STICK_OFF = 12` ثابتة · `STICK_ON` **مقيسة** من `measureSticky()`) +
`requestAnimationFrame` — العتبة الواحدة، وكمان العتبتين برقمين ثابتين، بيعملوا
فليكر عالق عند نقطة القفل (باج متحقَّق، `tabs-and-modals.md` §1b).

**السجل وتاب المعلّقة lazy** — `get_logs` و`pending_details` مابيتندوش غير أول ما الموظف يفتح التاب فعلاً.

## تقارير خارجة عن الأداة

| الملف | إيه ده |
|---|---|
| `docs/BUG-multi-select-menu-closes.md` | ✅ **اتقفل.** باج كان في **`ecommoda-html-builder`** نفسها (`templates/24_data-table-section.html`) — القائمة المنسدلة بتتقفل بعد أول اختيار. اتصلّح محليًا هنا في الواجهة v2.2.0، والإصلاح نزل على المهارة في **v5.1.0** (🟡 مُستحسن، والريبو ده هو الدليل المذكور في بندها). التقرير متسيب للتأريخ. |

## مسائل مفتوحة

— لا شيء.

آخر تحديث: 09-11-2026 — 21:12

</div>
