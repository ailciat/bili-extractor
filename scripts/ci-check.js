#!/usr/bin/env node
'use strict';

/**
 * 静态自检：不联网、不装依赖，几秒钟跑完。
 *
 * 检查的都是「改坏了但看不太出来」的问题：
 *   1. JS 语法错误
 *   2. app.js 里 $('xxx') 引用的 id 在 index.html 里不存在
 *      —— 这一条能抓住「删了 DOM 忘了删绑定」，那会让 bind() 中途抛错、
 *         后面的按钮全部失灵，表现得像「页面没反应」
 *   3. CSS 里 var(--x) 引用了 tokens.css 没定义的变量
 *   4. index.html 里有没有内联 <script>（会被严格 CSP 拦掉）
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let failed = 0;

function ok(msg) {
  console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
}

function bad(msg, details = []) {
  failed++;
  console.log(`  \x1b[31m✗\x1b[0m ${msg}`);
  for (const d of details) console.log(`      ${d}`);
}

/* ---------------- 1. 语法检查 ---------------- */

const JS_FILES = [
  'server.js',
  'electron/main.js',
  'public/app.js',
  'public/theme-init.js',
  'public/sea-bubbles.js',
];

console.log('\n[1/4] JS 语法');
for (const file of JS_FILES) {
  if (!fs.existsSync(path.join(ROOT, file))) {
    bad(`${file} 不存在`);
    continue;
  }
  try {
    execFileSync(process.execPath, ['--check', path.join(ROOT, file)], { stdio: 'pipe' });
    ok(file);
  } catch (e) {
    bad(`${file} 语法错误`, [String(e.stderr || e.message).split('\n')[0]]);
  }
}

/* ---------------- 2. DOM id 引用 ---------------- */

console.log('\n[2/4] DOM id 引用');

const html = read('public/index.html');
const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

const FRONTEND = ['public/app.js', 'public/sea-bubbles.js'];
const referenced = new Map(); // id -> 首次出现的文件

for (const file of FRONTEND) {
  const src = read(file);
  for (const m of src.matchAll(/\$\('([^']+)'\)/g)) {
    if (!referenced.has(m[1])) referenced.set(m[1], file);
  }
}

const missingIds = [...referenced].filter(([id]) => !htmlIds.has(id));
if (missingIds.length) {
  bad(
    `有 ${missingIds.length} 个 id 在 index.html 里找不到`,
    missingIds.map(([id, file]) => `$('${id}')  ← ${file}`)
  );
} else {
  ok(`${referenced.size} 个 id 引用全部命中`);
}

/* ---------------- 3. CSS 变量 ---------------- */

console.log('\n[3/4] CSS 变量');

// --cover-wash 由 app.js 在运行时用 style.setProperty 写入，没有静态定义
const RUNTIME_VARS = new Set(['--cover-wash']);

const tokens = read('public/styles/tokens.css');
const defined = new Set([...tokens.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((m) => m[1]));

const cssFiles = fs
  .readdirSync(path.join(ROOT, 'public/styles'))
  .filter((f) => f.endsWith('.css'));

const usedVars = new Map();
for (const file of cssFiles) {
  const css = fs.readFileSync(path.join(ROOT, 'public/styles', file), 'utf8');
  for (const m of css.matchAll(/var\((--[a-z0-9-]+)/g)) {
    if (!usedVars.has(m[1])) usedVars.set(m[1], file);
  }
}

const missingVars = [...usedVars].filter(
  ([name]) => !defined.has(name) && !RUNTIME_VARS.has(name)
);

if (missingVars.length) {
  bad(
    `有 ${missingVars.length} 个 CSS 变量没有定义`,
    missingVars.map(([name, file]) => `${name}  ← ${file}`)
  );
} else {
  ok(`${defined.size} 个变量定义，${usedVars.size} 处引用，无缺失`);
}

/* ---------------- 4. 内联脚本 ---------------- */

console.log('\n[4/4] 页面内联脚本（CSP 会拦）');

const inlineScripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].filter(
  (m) => m[1].trim().length > 0
);

if (inlineScripts.length) {
  bad(
    `发现 ${inlineScripts.length} 段内联脚本，严格 CSP 下不会执行`,
    inlineScripts.map((m) => m[1].trim().split('\n')[0].slice(0, 60))
  );
} else {
  ok('没有内联脚本');
}

/* ---------------- 结果 ---------------- */

if (failed) {
  console.log(`\n\x1b[31m检查未通过：${failed} 项有问题\x1b[0m\n`);
  process.exit(1);
}

console.log('\n\x1b[32m全部通过\x1b[0m\n');
