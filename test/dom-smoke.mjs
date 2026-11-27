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
  /* 真实页面里已经不补末尾空白了（用户要求去掉那块空位），
     所以这里只给滚动范围，验证「能居中就居中、够不着就贴边」。 */
  Object.defineProperty(box, 'scrollWidth', { value: 24 * 100, configurable: true });

  const center = win.cdBusCenterChipNow;
  if (typeof center !== 'function') {
    fail.push('没有导出 cdBusCenterChipNow，滚动算法没法验证');
  } else {
    const maxScroll = 24 * 100 - 400;                 // scrollWidth - clientWidth
    for (const idx of [0, 11, 21, 23]) {
      box.scrollLeft = 0;
      center(box, chips[idx]);
      const want = Math.max(0, Math.min(idx * 100 - 155, maxScroll));   // 芯片中心对准 400/2，滚不动就贴边
      if (Math.abs(box.scrollLeft - want) > 2) {
        fail.push(`第 ${idx + 1} 站居中失败：scrollLeft=${Math.round(box.scrollLeft)}，应该是 ${want}`);
      }
    }
    /* 最后一站靠右：只要不超出滚动范围，不许为了居中在末尾留空白 */
    box.scrollLeft = 0;
    center(box, chips[23]);
    if (box.scrollLeft > maxScroll + 2) fail.push('centerChipNow 把位置滚过了最大可滚距离（说明还在靠补空白撑位置）');
    // 页面还隐藏（clientWidth 为 0）时要老实返回 false，交给重试
    const hiddenBox = doc.createElement('div');
    Object.defineProperty(hiddenBox, 'clientWidth', { value: 0, configurable: true });
    if (center(hiddenBox, chips[0]) !== false) {
      fail.push('页面隐藏时（clientWidth=0）应该返回 false 让调用方重试，结果返回了 true');
    }
  }
}

/* 深色 / 浅色：整站换色，不只是换个按钮；默认必须是浅色 */
{
  const root = doc.documentElement;
  const cs = (k) => dom.window.getComputedStyle(root).getPropertyValue(k).trim();
  const sw = doc.getElementById('modeSw');
  const row = doc.getElementById('setMode');
  const lum = (hex) => {
    const v = String(hex).replace('#', '');
    const c = [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) / 255)
      .map((x) => (x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const cr = (a, b) => {
    const l1 = lum(a), l2 = lum(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  };

  /* 默认浅色：没点过任何东西就应该是浅底深字 */
  if (root.getAttribute('data-mode')) fail.push('第一次打开不是浅色（data-mode=' + root.getAttribute('data-mode') + '）');
  const initial = { bg: cs('--bg'), card: cs('--card'), text: cs('--text') };
  if (lum(initial.bg) < 0.5) fail.push('默认底色不是浅色：' + initial.bg);
  if (lum(initial.text) > 0.5) fail.push('默认文字不是深色：' + initial.text);
  if (!sw || sw.checked !== true) fail.push('默认浅色时开关不是打开状态');

  if (!sw) fail.push('设置页没有「浅色模式」开关 #modeSw');
  else if (typeof sw.onchange !== 'function') fail.push('#modeSw 没绑 onchange');
  if (!row || typeof row.onclick !== 'function') fail.push('#setMode 整行点不了');

  const snap = () => ({
    bg: cs('--bg'), card: cs('--card'), line: cs('--line'),
    text: cs('--text'), text2: cs('--text2'), muted: cs('--muted'),
  });

  /* 切到深色 */
  sw.checked = false; sw.onchange.call(sw);
  const dark = snap();
  if (root.getAttribute('data-mode') !== 'dark') fail.push('切不到深色');
  if (dom.window.localStorage.getItem('cdbus.mode') !== 'dark') fail.push('深色没写进 localStorage');
  if (lum(dark.bg) > 0.1) fail.push('深色模式的底色不够深：' + dark.bg);

  /* 切回浅色 */
  sw.checked = true; sw.onchange.call(sw);
  const light = snap();
  if (root.getAttribute('data-mode')) fail.push('切不回浅色');
  if (dom.window.localStorage.getItem('cdbus.mode') !== 'light') fail.push('浅色没写进 localStorage');

  for (const [name, p] of [['深色', dark], ['浅色', light]]) {
    for (const [k, v] of Object.entries(p)) {
      if (!/^#[0-9a-f]{6}$/i.test(v)) fail.push(name + '模式 ' + k + ' 不是颜色：' + v);
    }
    if (p.bg === p.card) fail.push(name + '模式的底色和卡片色一样，没有层次');
    const ratio = cr(p.text, p.bg);
    if (ratio < 7) fail.push(name + '模式正文对比度只有 ' + ratio.toFixed(1) + ':1');
    if (cr(p.muted, p.card) < 3) fail.push(name + '模式次要文字对比度太低');
  }

  /* 整行点击要能来回切 */
  const before = root.getAttribute('data-mode');
  row.onclick();
  if (root.getAttribute('data-mode') === before) fail.push('点整行没有切换明暗');
  row.onclick();
  if (root.getAttribute('data-mode') !== before) fail.push('点整行第二次没切回去');
}

/* 播报念法：线路号逐位读数字，716 → 七幺六 */
{
  const f = dom.window.cdBusLineSpeech;
  if (typeof f !== 'function') fail.push('没有导出 cdBusLineSpeech');
  else {
    const cases = [['716', '七幺六路'], ['16', '幺六路'], ['1', '一路'], ['39A', '三九A路']];
    for (const [inp, want] of cases) {
      const got = f(inp);
      if (got !== want) fail.push('播报念法不对：' + inp + ' → ' + got + '（应为 ' + want + '）');
    }
    if (/七百一十六/.test(f('716'))) fail.push('716 还是念成了中文数词');
  }
}

/* 设置页：语音入口已移除；「关于 ›」那行显示真实版本，不能留「v—」 */
{
  if (doc.getElementById('setVoice')) fail.push('设置页仍挂着「语音与播报」入口（#setVoice）');
  if (doc.getElementById('setPageVoice')) fail.push('语音二级页 #setPageVoice 还在');
  if (/class="setname">语音与播报/.test(html)) fail.push('页面里还残留「语音与播报」这一行');
  const sub = doc.getElementById('setVersionSub');
  if (!sub) fail.push('设置页找不到版本行 #setVersionSub');
  else if (!/^版本 v\d+\.\d+/.test(sub.textContent.trim())) {
    fail.push('「关于」下面的版本号没显示真实版本：' + JSON.stringify(sub.textContent.trim()));
  }
}

if (fail.length) {
  console.error('✗ 真 DOM 冒烟失败：');
  for (const f of fail) console.error('  - ' + f);
  process.exit(1);
}
console.log('✓ 真 DOM 冒烟通过：页面无未捕获异常，' +
  entries.map((e) => '#' + e.id).join('、') + ' 都绑上了并且点了会切页');
