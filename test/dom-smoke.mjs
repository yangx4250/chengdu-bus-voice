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

/* 站名条居中算法（jsdom 没有布局，所以给元素喂假 rect 直接验算）：
   进详情页时「离我最近」那一站必须正好落在可视区中间，靠后的站也一样。 */
{
  const win = dom.window;
  const box = doc.createElement('div');
  Object.defineProperty(box, 'clientWidth', { value: 400, configurable: true });
  box.getBoundingClientRect = () => ({ left: 0, right: 400, width: 400, top: 0, bottom: 0 });
  box.scrollLeft = 0;
  const chips = [];
  for (let i = 0; i < 24; i++) {
    const c = doc.createElement('div');
    c.className = 'chip';
    c.getBoundingClientRect = () => ({
      left: i * 100 - box.scrollLeft, right: i * 100 + 90 - box.scrollLeft,
      width: 90, top: 0, bottom: 0,
    });
    box.appendChild(c);
    chips.push(c);
  }
  const sp = doc.createElement('div');
  sp.className = 'chipspacer';
  box.appendChild(sp);

  const center = win.cdBusCenterChipNow;
  if (typeof center !== 'function') {
    fail.push('没有导出 cdBusCenterChipNow，滚动算法没法验证');
  } else {
    for (const idx of [0, 11, 21, 23]) {
      box.scrollLeft = 0;
      center(box, chips[idx]);
      const want = Math.max(0, idx * 100 - 155);      // 芯片中心对准 400/2
      if (Math.abs(box.scrollLeft - want) > 2) {
        fail.push(`第 ${idx + 1} 站居中失败：scrollLeft=${Math.round(box.scrollLeft)}，应该是 ${want}`);
      }
    }
    // 页面还隐藏（clientWidth 为 0）时要老实返回 false，交给重试
    const hiddenBox = doc.createElement('div');
    Object.defineProperty(hiddenBox, 'clientWidth', { value: 0, configurable: true });
    if (center(hiddenBox, chips[0]) !== false) {
      fail.push('页面隐藏时（clientWidth=0）应该返回 false 让调用方重试，结果返回了 true');
    }
  }
}

/* 主题色：设置 → 主题色，9 个颜色（红橙黄绿青蓝紫 + 黑白），点了立刻生效并记住 */
{
  const root = doc.documentElement;
  const getv = (k) => root.style.getPropertyValue(k);
  const cellOf = (id) => doc.querySelector('#themeGrid .themecell[data-theme="' + id + '"]');

  const row = doc.getElementById('setTheme');
  if (!row) {
    fail.push('设置页没有「主题色」入口 #setTheme');
  } else if (typeof row.onclick !== 'function') {
    fail.push('#setTheme 没绑上 onclick');
  } else {
    row.onclick();
    const cells = doc.querySelectorAll('#themeGrid .themecell');
    if (cells.length !== 9) fail.push('主题色应该有 9 个，实际 ' + cells.length);
    const names = [...cells].map((c) => c.querySelector('.themename').textContent);
    const want = ['红', '橙', '黄', '绿', '青', '蓝', '紫', '黑', '白'];
    if (names.join('') !== want.join('')) fail.push('颜色不对：' + names.join(' '));

    const seen = new Set();
    for (const id of want.map((_, i) => cells[i].getAttribute('data-theme'))) {
      const c = cellOf(id);
      if (!c || typeof c.onclick !== 'function') { fail.push('色块 ' + id + ' 点不了'); continue; }
      c.onclick();
      const accent = getv('--accent');
      if (!/^#[0-9a-f]{6}$/.test(accent)) fail.push('主题 ' + id + ' 没写 --accent：' + accent);
      if (!getv('--on-accent')) fail.push('主题 ' + id + ' 缺 --on-accent');
      if (!getv('--accent-line')) fail.push('主题 ' + id + ' 缺 --accent-line');
      if (!getv('--accent-bg')) fail.push('主题 ' + id + ' 缺 --accent-bg');
      if (!getv('--accent-soft')) fail.push('主题 ' + id + ' 缺 --accent-soft');
      seen.add(accent);
      if (dom.window.localStorage.getItem('cdbus.theme') !== id) {
        fail.push('主题 ' + id + ' 没写进 localStorage');
      }
      if (doc.querySelectorAll('#themeGrid .themecell.on').length !== 1) {
        fail.push('主题 ' + id + ' 的选中态不是唯一一个');
      }
    }
    if (seen.size !== 9) fail.push('9 个主题只有 ' + seen.size + ' 种颜色');

    /* 关键：换主题要换整站配色，不能只换按钮。
       底色、卡片、边框、文字都必须是主题算出来的，而且互不相同。 */
    const bgs = new Set(), cards = new Set(), lines = new Set(), texts = new Set();
    const lum = (hex) => {
      const v = hex.replace('#', '');
      const c = [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) / 255)
        .map((x) => (x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)));
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    const cr = (a, b) => {
      const l1 = lum(a), l2 = lum(b);
      return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    };
    for (const id of want.map((_, i) => cells[i].getAttribute('data-theme'))) {
      cellOf(id).onclick();
      const bg = getv('--bg'), card = getv('--card'), line = getv('--line'), text = getv('--text');
      for (const [k, v] of [['--bg', bg], ['--card', card], ['--line', line], ['--text', text]]) {
        if (!/^#[0-9a-f]{6}$/i.test(v)) fail.push(id + ' 的 ' + k + ' 不是颜色：' + v);
      }
      bgs.add(bg); cards.add(card); lines.add(line); texts.add(text);
      if (bg === card) fail.push(id + ' 的底色和卡片色一样，看不出层次');
      /* 正文对比度至少 7:1，浅色主题（白）也不会糊 */
      const ratio = cr(text, bg);
      if (ratio < 7) fail.push(id + ' 正文对比度只有 ' + ratio.toFixed(1) + ':1');
    }
    if (bgs.size !== 9) fail.push('9 个主题只有 ' + bgs.size + ' 种底色（应该整站换色）');
    if (cards.size !== 9) fail.push('9 个主题只有 ' + cards.size + ' 种卡片色');
    if (lines.size !== 9) fail.push('9 个主题只有 ' + lines.size + ' 种边框色');

    /* 白主题必须是浅底深字，黑主题必须是纯黑底 */
    cellOf('white').onclick();
    if (lum(getv('--bg')) < 0.5) fail.push('白主题的底色不够浅');
    cellOf('black').onclick();
    if (getv('--bg').toLowerCase() === '#ffffff') fail.push('黑主题的底色不对');
    /* 每个主题：压在主题色实底上的字都要看得清（最低 3:1，按钮是粗体大字） */
    for (const id of want.map((_, i) => cells[i].getAttribute('data-theme'))) {
      cellOf(id).onclick();
      const c = cr(getv('--on-accent'), getv('--accent'));
      if (c < 3) fail.push(id + ' 主题按钮上的字对比度只有 ' + c.toFixed(1) + ':1');
    }
    cellOf('white').onclick();
    if (doc.getElementById('setThemeSub').textContent !== '白') fail.push('设置页小字没跟着变');
  }
}

if (fail.length) {
  console.error('✗ 真 DOM 冒烟失败：');
  for (const f of fail) console.error('  - ' + f);
  process.exit(1);
}
console.log('✓ 真 DOM 冒烟通过：页面无未捕获异常，' +
  entries.map((e) => '#' + e.id).join('、') + ' 都绑上了并且点了会切页');
