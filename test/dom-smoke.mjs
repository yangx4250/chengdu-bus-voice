/**
 * 真 DOM 冒烟：用 jsdom 把 app/assets/index.html 完整跑一遍。
 *
 * 为什么需要它：ui-smoke.mjs 用的是手写 DOM 桩，`$("xxx")` 永远返回一个对象，
 * 所以「脚本执行时某个节点还不存在」这类错误在桩里永远复现不出来 ——
 * v1.5.1 就是这么发出去的：把 #dnavpick 挪到 </script> 后面，
 * 脚本执行到 $("dnavpickCancel").onclick 时拿到 null，抛 TypeError，
 * 后面所有按钮（规划、查看……）的绑定全被打断，用户看到的就是「点了没反应」。
 *
 * 这里跑真实 HTML 解析 + 真实脚本，检查：
 *   ① 没有未捕获异常；
 *   ② 首页每个入口按钮都绑上了 onclick，并且点了真的会切页。
 *
 * 没有安装 jsdom 时直接跳过（`npm i --no-save jsdom` 装上才会真正跑）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const htmlPath = path.join(root, 'app', 'assets', 'index.html');

let JSDOM, VirtualConsole;
try {
  ({ JSDOM, VirtualConsole } = await import('jsdom'));
} catch (e) {
  console.log('· 跳过真 DOM 冒烟（没装 jsdom，`npm i --no-save jsdom` 可启用）');
  process.exit(0);
}

const html = fs.readFileSync(htmlPath, 'utf8');
const errors = [];
const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  url: 'https://local/',
  virtualConsole: new VirtualConsole(),
  beforeParse(window) {
    window.addEventListener('error', (ev) => {
      errors.push((ev.error && ev.error.stack) || String(ev.message));
    });
    window.addEventListener('unhandledrejection', (ev) => {
      errors.push('unhandledrejection: ' + String(ev.reason));
    });
  },
});

await new Promise((r) => setTimeout(r, 500));
const doc = dom.window.document;
const fail = [];

if (errors.length) {
  fail.push('页面脚本抛异常（后面的绑定都会断）：\n    ' + errors[0].split('\n').slice(0, 3).join('\n    '));
}

/* 首页 / 各页的入口按钮：绑定必须是函数，点下去要真的切页面 */
const entries = [
  { id: 'openMetro', view: 'metro', label: '地铁查看' },
  { id: 'openRoute', view: 'route', label: '去哪儿规划' },
];
for (const e of entries) {
  const el = doc.getElementById(e.id);
  if (!el) { fail.push(`找不到按钮 #${e.id}`); continue; }
  if (typeof el.onclick !== 'function') {
    fail.push(`#${e.id}（${e.label}）没绑上 onclick —— 脚本在上面某处抛出异常了`);
    continue;
  }
  const before = doc.getElementById(e.view).className;
  try {
    el.onclick();
  } catch (err) {
    fail.push(`点 #${e.id}（${e.label}）抛错：${err.message}`);
    continue;
  }
  const after = doc.getElementById(e.view).className;
  const visible = !/\bhidden\b/.test(after);
  if (!visible) fail.push(`点 #${e.id}（${e.label}）没有切到 #${e.view}（class：${before} → ${after}）`);
}

if (fail.length) {
  console.error('✗ 真 DOM 冒烟失败：');
  for (const f of fail) console.error('  - ' + f);
  process.exit(1);
}
console.log('✓ 真 DOM 冒烟通过：页面无未捕获异常，' +
  entries.map((e) => '#' + e.id).join('、') + ' 都绑上了并且点了会切页');
