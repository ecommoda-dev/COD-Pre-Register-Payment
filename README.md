<div dir="rtl" style="text-align: right;">

# COD Pre-Register Payment

![version](https://img.shields.io/badge/version-v1.4.0-blue)

أداة داخلية لـ EcomModa — تسجيل الدفع المسبق لأوردرات COD على شوبيفاي قبل
التحصيل الفعلي من المندوب.

| | |
|---|---|
| الواجهة | https://ecommoda-dev.github.io/COD-Pre-Register-Payment/ |
| الـ Worker | https://cod-pre-register-payment-worker.ecommoda-dev.workers.dev |
| الإصدار | Worker `v2.8.0` · الواجهة `v2.7.0` |

## بنية الريبو

```
index.js       ← كود الـ Worker (منشور تلقائيًا عبر Cloudflare Workers Builds)
wrangler.toml  ← الاسم + الـ bindings + الـ vars
index.html     ← الواجهة (منشورة عبر GitHub Pages)
(اتشالت Index.html — 23-09-2026، قرار أحمد. الرابط الوحيد: https://ecommoda-dev.github.io/COD-Pre-Register-Payment/)
CLAUDE.md      ← قواعد الأداة وفخاخها وخط الأساس
```

## النشر

الريبو ده هو **المصدر الوحيد** للكود المنشور. أي `git push` على `main` بينشر
الـ Worker أوتوماتيك، والواجهة بتتحدّث من GitHub Pages بعدها بدقيقة–اتنين.

> ⚠️ **ممنوع لصق كود في داشبورد Cloudflare بعد الربط** — أول push جاي بيمسحه.

## الإعدادات عند الموظف

حقل واحد بس: **WORKER SECRET**. رابط الـ Worker ثابت في الكود (مش سر — الحماية
في الـ Secret + CORS allowlist).

> لو الأداة وقفت، افتح الإعدادات واضغط **🩺 افحص الأداة والاتصالات** — بيفحص
> المتغيرات وD1 وKV وOAuth وصلاحيات شوبيفاي والـ CORS ويقول أي واحد فيهم الواقع.

التفاصيل الكاملة → سكيل `ecommoda-tool-migration-playbook`.

آخر تحديث: 09-11-2026 — 21:12

</div>
