#!/usr/bin/env node
/**
 * check-log-values.mjs — تحقق من قيم اللوج بتاعة أداة واحدة
 *
 * بيقرا log-values.json بتاع الأداة، وبيمشي على كودها، وبيقارن.
 * مالوش أي dependency — node بس.
 *
 * الطريقة: anchoring على نداء الكتابة (writeLog / safeWriteLog / writeLogsBatch / …)
 * مع brace-matching على الأقواس، واستخراج type: من جوّه بس.
 * مش بيعتمد على tool: كنص ثابت — لأن ريبو = أداة واحدة.
 *
 * الاستخدام:  node check-log-values.mjs [--dir .] [--registry log-values.json] [--json]
 * الخروج:     0 = تمام · 1 = فيه قيمة مش مسجّلة أو مفردة غلط
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, extname, relative } from 'node:path';

// ── المفردات المقفولة (§12) ────────────────────────────────────────────────
const RESULTS = ['success', 'rejected', 'already', 'warning', 'error'];
const STAGES  = ['lookup', 'write', 'preflight'];

// ── أسماء نداءات الكتابة اللي بنتعلّق بيها ─────────────────────────────────
// أي شكل تاني يتزوّد هنا (أو في logAnchors جوه log-values.json).
const DEFAULT_ANCHORS = [
  'writeLog', 'safeWriteLog', 'safeLog', 'writeLogsBatch',
  'logWhere', 'logCycleBlocks', 'insertLog', 'addLog', 'logSafe',
];

// ── الإعدادات ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const opt  = (k, d) => { const i = args.indexOf(k); return i > -1 ? args[i + 1] : d; };
const ROOT     = opt('--dir', '.');
const REGPATH  = opt('--registry', join(ROOT, 'log-values.json'));
const AS_JSON  = args.includes('--json');
const SKIP_DIR = new Set(['node_modules', '.git', '.wrangler', 'dist', 'build', 'coverage']);
const EXTS     = new Set(['.js', '.mjs', '.cjs']);

const isScannable = (p) =>
  EXTS.has(extname(p)) && !/\.min\.js$/.test(p) && !p.includes('check-log-values');

// ── قراءة السجل ────────────────────────────────────────────────────────────
if (!existsSync(REGPATH)) {
  console.error(`✗ مفيش سجل: ${REGPATH}\n  اعمل log-values.json جنب كود الأداة الأول.`);
  process.exit(1);
}
const reg = JSON.parse(readFileSync(REGPATH, 'utf8'));
const TOOL = reg.tool;
const registered = new Set(Object.keys(reg.types || {}));
const ANCHORS = new Set([...DEFAULT_ANCHORS, ...(reg.logAnchors || [])]);

// ── المشي على الملفات ──────────────────────────────────────────────────────
function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP_DIR.has(e.name)) walk(join(dir, e.name), out); }
    else if (isScannable(e.name)) out.push(join(dir, e.name));
  }
  return out;
}

// ── ماسح يعرف يعدّي على النصوص والتعليقات ─────────────────────────────────
// بيرجّع فهرس القفلة المقابلة للفتحة اللي في `open`، أو -1.
const PAIR = { '(': ')', '{': '}', '[': ']' };
const REGEX_PREV = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '\n', '+', '-', '*', '%', '<', '>', '~', '^']);

function matchSpan(src, open) {
  const stack = [];
  let i = open;
  while (i < src.length) {
    const c = src[i];
    // تعليقات
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i < 0) return -1; continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); if (e < 0) return -1; i = e + 2; continue; }
    // نصوص
    if (c === "'" || c === '"') { i = skipQuoted(src, i, c); continue; }
    if (c === '`') { i = skipTemplate(src, i); continue; }
    // regex literal
    if (c === '/') {
      let j = i - 1;
      while (j >= 0 && /\s/.test(src[j])) j--;
      if (j < 0 || REGEX_PREV.has(src[j])) { i = skipRegex(src, i); continue; }
    }
    if (PAIR[c]) { stack.push(PAIR[c]); i++; continue; }
    if (c === ')' || c === '}' || c === ']') {
      if (!stack.length) return -1;
      const want = stack.pop();
      if (want !== c) return -1;
      if (!stack.length) return i;
      i++; continue;
    }
    i++;
  }
  return -1;
}
function skipQuoted(src, i, q) {
  i++;
  while (i < src.length) {
    if (src[i] === '\\') { i += 2; continue; }
    if (src[i] === q) return i + 1;
    if (src[i] === '\n') return i + 1;   // نص مكسور — بلاش نلف للأبد
    i++;
  }
  return i;
}
function skipTemplate(src, i) {
  i++;
  while (i < src.length) {
    if (src[i] === '\\') { i += 2; continue; }
    if (src[i] === '`') return i + 1;
    if (src[i] === '$' && src[i + 1] === '{') {
      const end = matchSpan(src, i + 1);
      if (end < 0) return src.length;
      i = end + 1; continue;
    }
    i++;
  }
  return i;
}
function skipRegex(src, i) {
  i++;
  let inClass = false;
  while (i < src.length) {
    if (src[i] === '\\') { i += 2; continue; }
    if (src[i] === '[') inClass = true;
    else if (src[i] === ']') inClass = false;
    else if (src[i] === '/' && !inClass) { i++; while (/[a-z]/i.test(src[i] || '')) i++; return i; }
    else if (src[i] === '\n') return i;
    i++;
  }
  return i;
}

// يرجّع نسخة بنفس الطول من الكود، محتوى النصوص والتعليقات فيها مسح مسافات.
// كده أي بحث بالـ regex مابيماتشش جوه نص (زي notes: `... type:${x}`) — بس الفهارس تفضل هي هي.
function maskLiterals(src) {
  const out = src.split('');
  const blank = (a, b) => { for (let k = a; k < b && k < out.length; k++) if (out[k] !== '\n') out[k] = ' '; };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { let e = src.indexOf('\n', i); if (e < 0) e = src.length; blank(i, e); i = e; continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); const end = e < 0 ? src.length : e + 2; blank(i, end); i = end; continue; }
    if (c === "'" || c === '"') { const e = skipQuoted(src, i, c); blank(i + 1, e - 1); i = e; continue; }
    if (c === '`') {
      // امسح نص القالب بس، وسيب اللي جوه ${...} كود
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '\\') { blank(j, j + 2); j += 2; continue; }
        if (src[j] === '`') { j++; break; }
        if (src[j] === '$' && src[j + 1] === '{') { const e = matchSpan(src, j + 1); if (e < 0) { j = src.length; break; } j = e + 1; continue; }
        blank(j, j + 1); j++;
      }
      i = j; continue;
    }
    if (c === '/') {
      let j = i - 1;
      while (j >= 0 && /\s/.test(src[j])) j--;
      if (j < 0 || REGEX_PREV.has(src[j])) { const e = skipRegex(src, i); blank(i + 1, e - 1); i = e; continue; }
    }
    i++;
  }
  return out.join('');
}

// ── الاستخراج ──────────────────────────────────────────────────────────────
const NB       = "(?<![A-Za-z0-9_$])";                       // يمنع contentType / otype
const RE_TYPEK = new RegExp(`${NB}type\\s*:`, 'g');
const RE_TOOL  = new RegExp(`${NB}tool\\s*:\\s*(['"\`])([^'"\`]*)\\1`, 'g');
const RE_ANCHOR = new RegExp(`${NB}([A-Za-z_$][A-Za-z0-9_$]*)\\s*\\(`, 'g');
const RE_IDENT_ARG = /(?:^|[(,\s])([A-Za-z_$][A-Za-z0-9_$]*)\s*(?=[,)])/g;
const RE_CONST = /(?:const|let|var)\s+([A-Z_$][A-Z0-9_$]*|[A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(['"])((?:\\.|(?!\2)[^\\])*)\2\s*;/g;

const used = new Map();   // type -> Set(مواضع)
const dynamic = new Map();
const otherTools = new Set();
const noAnchorFiles = [];
const add = (map, key, at) => (map.get(key) ?? map.set(key, new Set()).get(key)).add(at);

// يقرا قيمة الحقل من بعد `type:` لحد الفاصلة/القفلة على نفس المستوى (بيعدّي على النصوص والأسطر)
function readValue(src, i) {
  while (i < src.length && /\s/.test(src[i])) i++;
  const start = i;
  let depth = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i < 0) { i = src.length; break; } continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; continue; }
    if (c === "'" || c === '"') { i = skipQuoted(src, i, c); continue; }
    if (c === '`') { i = skipTemplate(src, i); continue; }
    if (PAIR[c]) { depth++; i++; continue; }
    if (c === ')' || c === '}' || c === ']') { if (depth === 0) break; depth--; i++; continue; }
    if (depth === 0 && c === ',') break;
    i++;
  }
  return src.slice(start, i).trim();
}

// يقسّم تعبير على `?` و `:` في المستوى الأعلى — عشان الترناري
function topSplitTernary(expr) {
  let depth = 0, qi = -1;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (c === "'" || c === '"') { i = skipQuoted(expr, i, c) - 1; continue; }
    if (c === '`') { i = skipTemplate(expr, i) - 1; continue; }
    if (PAIR[c]) { depth++; continue; }
    if (c === ')' || c === '}' || c === ']') { depth--; continue; }
    if (depth === 0 && c === '?' && expr[i + 1] !== '.' && expr[i + 1] !== '?') { qi = i; break; }
  }
  if (qi < 0) return null;
  let depth2 = 0;
  for (let i = qi + 1; i < expr.length; i++) {
    const c = expr[i];
    if (c === "'" || c === '"') { i = skipQuoted(expr, i, c) - 1; continue; }
    if (c === '`') { i = skipTemplate(expr, i) - 1; continue; }
    if (PAIR[c]) { depth2++; continue; }
    if (c === ')' || c === '}' || c === ']') { depth2--; continue; }
    if (depth2 === 0 && c === '?' && expr[i + 1] !== '.' && expr[i + 1] !== '?') return null; // ترناري متداخل — سيبه ديناميكي
    if (depth2 === 0 && c === ':') return [expr.slice(qi + 1, i).trim(), expr.slice(i + 1).trim()];
  }
  return null;
}

// بيرجّع نص ثابت لو التعبير ينحل، أو null
function asLiteral(expr, consts) {
  const q = expr[0];
  if ((q === "'" || q === '"') && expr.lastIndexOf(q) === expr.length - 1 && expr.length >= 2)
    return expr.slice(1, -1);
  if (q === '`' && expr.endsWith('`') && !expr.includes('${') && expr.length >= 2)
    return expr.slice(1, -1);
  if (/^[A-Za-z_$][A-Za-z0-9_$]*(\.[A-Za-z_$][A-Za-z0-9_$]*)?$/.test(expr) && consts.has(expr)) return consts.get(expr);
  return null;
}

// بيحلّ التعبير لقيمة/قيم ثابتة — أو بيرجّع null لو فيه جزء ديناميكي
function resolve(expr, consts, depth = 0) {
  if (depth > 4) return null;
  const lit = asLiteral(expr, consts);
  if (lit !== null) return [lit];
  const t = topSplitTernary(expr);
  if (t) {
    const a = resolve(t[0], consts, depth + 1);
    const b = resolve(t[1], consts, depth + 1);
    if (a && b) return [...a, ...b];
  }
  return null;
}


// ثوابت الأوبجكت: const LOG_TYPES = { FAILED: 'failed', … }  →  LOG_TYPES.FAILED
const RE_OBJCONST = /(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:Object\.freeze\s*\(\s*)?\{/g;
function collectObjConsts(src, mask, into){
  for (const m of mask.matchAll(RE_OBJCONST)) {
    const open = m.index + m[0].length - 1;
    const end = matchSpan(src, open);
    if (end < 0) continue;
    const body = src.slice(open + 1, end);
    const bmask = maskLiterals(body);
    let depth = 0;
    for (let i = 0; i < bmask.length; i++) {
      const c = bmask[i];
      if (PAIR[c]) { depth++; continue; }
      if (c === ')' || c === '}' || c === ']') { depth--; continue; }
      if (depth !== 0) continue;
      const k = /^([A-Za-z_$][A-Za-z0-9_$]*|'[^']*'|"[^"]*")\s*:/.exec(bmask.slice(i));
      if (!k) continue;
      let j = i + k[0].length;
      while (j < body.length && /\s/.test(body[j])) j++;
      const q = body[j];
      if (q === "'" || q === '"') {
        const e = skipQuoted(body, j, q);
        const key = k[1].replace(/^['"]|['"]$/g, '');
        const full = m[1] + '.' + key;
        if (!into.has(full)) into.set(full, body.slice(j + 1, e - 1));
      }
      i = j;
    }
  }
}

const files = walk(ROOT);

// ثوابت على مستوى المشروع — عشان LOG_TYPE_X = 'x' اللي بتتستخدم في type:
const CONSTS = new Map();
for (const file of files) {
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(RE_CONST)) if (!CONSTS.has(m[1])) CONSTS.set(m[1], m[3]);
  collectObjConsts(src, maskLiterals(src), CONSTS);
}

for (const file of files) {
  const src = readFileSync(file, 'utf8');
  const mask = maskLiterals(src);          // للبحث · القراءة بتفضل من src
  const rel = relative(ROOT, file) || file;
  const lineAt = (i) => src.slice(0, i).split('\n').length;

  for (const m of src.matchAll(RE_TOOL)) if (m[2] !== TOOL) otherTools.add(m[2]);

  // ١) كل نداء لأنكور: خُد مدى الأقواس بتاعه
  const spans = [];
  const identArgs = new Set();
  for (const m of mask.matchAll(RE_ANCHOR)) {
    if (!ANCHORS.has(m[1])) continue;
    const open = m.index + m[0].length - 1;
    const end = matchSpan(src, open);
    if (end < 0) continue;
    const before = src.slice(Math.max(0, m.index - 20), m.index);
    if (/\b(function|class)\s*$/.test(before)) continue;   // تعريف الدالة نفسها مش نداء
    spans.push([open, end]);
    for (const a of mask.slice(open, end + 1).matchAll(RE_IDENT_ARG)) identArgs.add(a[1]);
  }

  // ٢) المتغيّرات اللي اتمرّرت للأنكور: ضُم مدى التعريف بتاعها كمان (logRows / mfChangeRows …)
  for (const name of identArgs) {
    const re = new RegExp(`(?:const|let|var)\\s+${name}\\s*=`, 'g');
    for (const d of mask.matchAll(re)) {
      let probe = d.index + d[0].length, guard = 0;
      while (probe < src.length && guard++ < 400 && !PAIR[src[probe]] && src[probe] !== ';') probe++;
      if (PAIR[src[probe]]) { const end = matchSpan(src, probe); if (end > 0) spans.push([probe, end]); }
    }
  }

  if (!spans.length) { if (/\btype\s*:/.test(mask)) noAnchorFiles.push(rel); continue; }

  // ٣) استخرج type: من جوّه المديات بس
  const seen = new Set();
  for (const [s, e] of spans) {
    const chunk = mask.slice(s, e + 1);
    for (const k of chunk.matchAll(RE_TYPEK)) {
      const abs = s + k.index + k[0].length;
      if (seen.has(abs)) continue;
      seen.add(abs);
      const raw = readValue(src, abs);
      if (!raw) continue;
      const at  = `${rel}:${lineAt(abs)}`;
      const vals = resolve(raw, CONSTS);
      if (vals) for (const v of vals) add(used, v, at);
      else add(dynamic, raw.replace(/\s+/g, ' ').slice(0, 120), at);
    }
  }
}

// ── المقارنة ───────────────────────────────────────────────────────────────
const unregistered = [...used.keys()].filter((t) => !registered.has(t));
const orphans      = [...registered].filter((t) => !used.has(t));

// result/stage ممكن يكونوا: قيمة واحدة · null (الأداة لسه ماكتبتهاش) · أو مصفوفة
// لو الـ type بيوصف أكتر من نتيجة حسب الفرع (زي status_event).
const badVocab = [];
const checkVocab = (type, key, val, allowed) => {
  for (const v of (Array.isArray(val) ? val : [val])) {
    if (v === null || v === undefined) continue;
    if (!allowed.includes(v)) badVocab.push(`${type}: ${key}='${v}' — المسموح: ${allowed.join(' · ')}`);
  }
};
for (const [type, meta] of Object.entries(reg.types || {})) {
  checkVocab(type, 'result', meta?.result, RESULTS);
  checkVocab(type, 'stage',  meta?.stage,  STAGES);
}

const fail = unregistered.length > 0 || badVocab.length > 0;

// ── التقرير ────────────────────────────────────────────────────────────────
if (AS_JSON) {
  console.log(JSON.stringify({
    tool: TOOL, unregistered, orphans,
    dynamic: [...dynamic].map(([expr, ats]) => ({ expr, at: [...ats] })),
    otherTools: [...otherTools], noAnchorFiles, badVocab, ok: !fail,
  }, null, 2));
  process.exit(fail ? 1 : 0);
}

console.log(`\n■ ${TOOL}  —  ${registered.size} قيمة مسجّلة · ${used.size} مستخدمة في الكود\n`);

if (unregistered.length) {
  console.log('🔴 قيم مستخدمة ومش مسجّلة — سجّلها في log-values.json:');
  for (const t of unregistered) console.log(`   '${t}'  ←  ${[...used.get(t)].join(' · ')}`);
  console.log('');
}
if (badVocab.length) {
  console.log('🔴 مفردة غلط في السجل:');
  for (const b of badVocab) console.log(`   ${b}`);
  console.log('');
}
if (dynamic.size) {
  console.log('⚠️  قيم مش نص ثابت — التحقق الساكن مش شايفها، راجعها بنفسك:');
  for (const [expr, ats] of dynamic) console.log(`   ${[...ats].join(' · ')}  →  ${expr}`);
  console.log('');
}
if (orphans.length) {
  console.log('ℹ️  مسجّلة ومش مستخدمة في الكود (يتيمة؟ أو بتتكتب من أداة تانية):');
  console.log(`   ${orphans.map((t) => `'${t}'`).join(' · ')}\n`);
}
if (otherTools.size) {
  console.log(`ℹ️  قيم tool تانية ظهرت في الكود: ${[...otherTools].map((t) => `'${t}'`).join(' · ')}\n`);
}
if (noAnchorFiles.length) {
  console.log(`ℹ️  ملفات فيها type: من غير أي نداء لوج معروف — زوّد الاسم في logAnchors لو لازم:\n   ${noAnchorFiles.join(' · ')}\n`);
}
console.log(fail ? '✗ فيه حاجة محتاجة تتصلّح\n' : '✓ تمام\n');
process.exit(fail ? 1 : 0);
