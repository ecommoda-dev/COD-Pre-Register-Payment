# COD Pre-Register Payment

أداة داخلية لـ EcomModa — تسجيل الدفع المسبق لأوردرات COD على شوبيفاي قبل
التحصيل الفعلي من المندوب.

| | |
|---|---|
| الواجهة | https://ecommoda-dev.github.io/COD-Pre-Register-Payment/ |
| الـ Worker | https://cod-pre-register-payment-worker.ecommoda-dev.workers.dev |

## بنية الريبو

```
index.js       ← كود الـ Worker (منشور تلقائيًا عبر Cloudflare Workers Builds)
wrangler.toml  ← الاسم + الـ bindings + الـ vars
index.html     ← الواجهة (منشورة عبر GitHub Pages)
Index.html     ← صفحة تحويل للرابط القديم — مفيش منطق فيها
CLAUDE.md      ← قواعد الأداة وفخاخها وخط الأساس
```

## النشر

الريبو ده هو **المصدر الوحيد** للكود المنشور. أي `git push` على `main` بينشر
الـ Worker أوتوماتيك، والواجهة بتتحدّث من GitHub Pages بعدها بدقيقة–اتنين.

> ⚠️ **ممنوع لصق كود في داشبورد Cloudflare بعد الربط** — أول push جاي بيمسحه.

التفاصيل الكاملة → سكيل `ecommoda-tool-migration-playbook`.
