#!/usr/bin/env node
/**
 * 界面冒烟测试：用最小 DOM 桩把 app/assets/index.html 里的脚本真跑一遍。
 *
 * 覆盖「启动 → 定位 → 附近站点 → 渲染」这条主链路。
 * 像 list.appendChild is not a function 这种运行时错误，会在这里当场暴露。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(here, '..', 'app', 'assets', 'index.html'), 'utf-8');
const scriptStart = html.indexOf('<script>\n(function');
const scriptEnd = html.indexOf('</script>', scriptStart);
const script = html.slice(scriptStart + '<script>'.length, scriptEnd);

// ---------------------------------------------------------------- DOM 桩

function textOf(node) {
  if (!node) return '';
  const raw = node.__rawHtml || '';                    // innerHTML 赋值的内容
  const own = node.textContent || '';
  const kids = (node.children || []).map(textOf).join('');
  return raw + own + kids;                             // 三者都要，appendChild 是追加
}

function makeElement(id = '') {
  const el = {
    id,
    textContent: '',
    className: '',
    style: {},
    dataset: {},
    checked: false,
    disabled: false,
    children: [],
    onclick: null,
    onchange: null,
    onkeydown: null,
    onerror: null,
    onplaying: null,
    onended: null,
    oncanplay: null,
    src: '',
    appendChild(node) {
      this.children.push(node);
      return node;
    },
    querySelectorAll() { return []; },
    classList: {
      add(cls) {
        const set = new Set(String(el.className || '').split(/\s+/).filter(Boolean));
        set.add(cls);
        el.className = [...set].join(' ');
      },
      remove(cls) {
        el.className = String(el.className || '').split(/\s+/).filter((x) => x && x !== cls).join(' ');
      },
      toggle(cls, force) {
        const has = String(el.className || '').split(/\s+/).includes(cls);
        const want = force === undefined ? !has : Boolean(force);
        if (want) this.add(cls); else this.remove(cls);
        return want;
      },
      contains(cls) {
        return String(el.className || '').split(/\s+/).includes(cls);
      },
    },
    addEventListener() {},
  };
  let rawHtml = '';
  Object.defineProperty(el, 'innerHTML', {
    get() {
      return rawHtml + (el.children || []).map(textOf).join('');
    },
    set(value) {
      rawHtml = String(value);
      el.__rawHtml = String(value);
      el.children = [];
    },
  });
  return el;
}

const elements = new Map();
const document = {
  getElementById(id) {
    if (!elements.has(id)) elements.set(id, makeElement(id));
    return elements.get(id);
  },
  createElement() { return makeElement(); },
  addEventListener() {},
};

const storage = new Map();
storage.set('cdbus.favorites', JSON.stringify([{
  lineId: '028-16-0', lineName: '16', endSn: '火车南站公交站',
  stationId: '028-1', stationName: '天府广场南', order: 22,
  lat: 30.6, lng: 104.0, firstTime: '00:00', lastTime: '23:59', addedAt: Date.now(),
}]));
const localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => storage.set(k, String(v)),
};

class FakeAudio {
  constructor() {
    this.paused = true;
    this.currentTime = 0;
    this.readyState = 0;
    this.duration = 0;
  }
  play() { this.paused = false; return Promise.resolve(); }
  pause() { this.paused = true; }
}

// ---------------------------------------------------------------- 接口桩

const pad2 = (n) => String(n).padStart(2, '0');
const hhmm = (offsetHours) => {
  const d = new Date(Date.now() + offsetHours * 3600 * 1000);
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
};
const ENDED_FROM = hhmm(-3);
const ENDED_TO = hhmm(-2);

const nearbyPayload = {
  stops: [
    {
      stationId: '028-1', name: '花园永泉', distanceMeters: 9, lineNames: 'P02路、716路',
      arrivals: [
        { stationId: '028-1', stationName: '花园永泉', stationOrder: 5, lineId: '028-p02-0',
          lineName: 'P02', toward: '花园公交站', stationsAway: 2, etaSeconds: 300,
          firstTime: '00:00', lastTime: '23:59', arrived: false },
        { stationId: '028-1', stationName: '花园永泉', stationOrder: 1, lineId: '028-720-0',
          lineName: '720', toward: '花园公交站', stationsAway: 0, etaSeconds: null,
          firstTime: '00:00', lastTime: '23:59', preStartTime: '09:24', arrived: false },
        { stationId: '028-1', stationName: '花园永泉', stationOrder: 5, lineId: '028-716-0',
          lineName: '716', toward: '花园公交站', stationsAway: 43, etaSeconds: null,
          firstTime: ENDED_FROM, lastTime: ENDED_TO, arrived: false },
      ],
    },
    {
      stationId: '028-2', name: '龙溪村委会', distanceMeters: 302, lineNames: 'P36路',
      arrivals: [],
    },
    {
      // 同一地点、写法差一个字（真实数据里就是这样）——应该并进上一张卡
      stationId: '028-2b', name: '龙溪村村委会', distanceMeters: 310, lineNames: 'P36路',
      arrivals: [
        { stationId: '028-2b', stationName: '龙溪村村委会', stationOrder: 3, lineId: '028-p36-0',
          lineName: 'P36', toward: '花园公交站', stationsAway: 3, etaSeconds: 700,
          firstTime: '00:00', lastTime: '23:59', arrived: false },
      ],
    },
    {
      // 附近接口没给数据，但能用线路名反查出站点的站：行里也必须有 🔊
      stationId: '028-3', name: '友爱公交站', distanceMeters: 500, lineNames: 'P49路',
      arrivals: [],
    },
    {
      // 完全没数据的站点：应显示「暂无实时车辆」，不能冒充「不在运营时段」
      stationId: '028-4', name: '无数据站', distanceMeters: 620, lineNames: 'Z99路',
      arrivals: [],
    },
  ],
  allArrivals: [],
};

const calls = [];
const speakLog = [];
const watchServiceLog = [];
const payloads = new Map();
let seq = 0;
const bridge = {
  start(method, payload) {
    calls.push(method);
    const id = 'task-' + method + '-' + (++seq);
    payloads.set(id, payload);
    return id;
  },
  poll(id) {
    const method = String(id).split('-')[1];
    let args = {};
    try { args = JSON.parse(payloads.get(id) || '{}'); } catch (e) {}
    if (method === 'lines') {
      const key = String(args.key || '').toUpperCase();
      if (/^\d/.test(key)) {
        const names = ['2', '20', '20快', '21', '201', '106', '1060', 'P106', 'T106']
          .filter((n) => n.toUpperCase().includes(key));
        return JSON.stringify({ state: 'ok', data: names.map((n) => ({
          lineId: '028-' + n + '-0', name: n, direction: 0,
          startSn: n + '起', endSn: n + '终', firstTime: '06:00', lastTime: '23:00',
        })) });
      }
      const pLines = [
        { lineId: '028-p36-0', name: 'P36', endSn: '花园公交站', startSn: '郫都区客运中心', direction: 0, firstTime: '06:00', lastTime: '22:30' },
        { lineId: '028-p36-1', name: 'P36', endSn: '郫都区客运中心', startSn: '花园公交站', direction: 1, firstTime: '06:00', lastTime: '22:30' },
        { lineId: '028-p02-0', name: 'P02', endSn: '花园公交站', startSn: '郫都区客运中心', direction: 0, firstTime: '00:00', lastTime: '23:59' },
        { lineId: '028-p02-1', name: 'P02', endSn: '郫都区客运中心', startSn: '花园公交站', direction: 1, firstTime: '00:00', lastTime: '23:59' },
        { lineId: '028-p49-0', name: 'P49', endSn: '友爱公交站', startSn: '花园永泉', direction: 0, firstTime: '00:00', lastTime: '23:59' },
      ];
      return JSON.stringify({ state: 'ok', data: pLines.filter((l) => l.name.toUpperCase().includes(key)) });
    }
    if (method === 'matrix') {
      return JSON.stringify({ state: 'ok', data: {
        line: { lineId: '028-p02-0', name: 'P02', startSn: '花园公交站', endSn: '郫都区客运中心',
                firstTime: '00:00', lastTime: '23:59',
                departLeft: Date.now() + 600000, depIntervalM: 12, preArrivalTime: '' },
        stations: [
          { order: 1, name: '花园公交站', stationId: '028-9', lat: 30.8, lng: 103.9 },
          { order: 9, name: '花园永泉', stationId: '028-1', lat: 30.7, lng: 103.95 },
          { order: 30, name: '郫都区客运中心', stationId: '028-9b', lat: 30.81, lng: 103.86 },
        ],
        buses: [
          { busId: 'b1', plate: '10001', order: 2, stationsAway: 7, stationsToEnd: 28, passedSelected: false,
            times: [{ order: 5, name: '花园永泉', passed: false, etaSeconds: 1200, arrivalAt: Date.now() + 1200000 }] },
          { busId: 'b2', plate: '10002', order: 12, stationsAway: 0, stationsToEnd: 18, passedSelected: true,
            times: [{ order: 5, name: '花园永泉', passed: true, etaSeconds: -1, arrivalAt: null }] },
          { busId: 'b3', plate: '10003', order: 19, stationsAway: 0, stationsToEnd: 11, passedSelected: true,
            times: [{ order: 5, name: '花园永泉', passed: true, etaSeconds: -1, arrivalAt: null }] },
        ],
        queriedFrom: 9, queriedTo: 30,
      } });
    }
    if (method === 'detail') {
      const lineId = String(args.lineId || '');
      if (lineId.includes('p49')) {
        return JSON.stringify({ state: 'ok', data: {
          lineId: '028-p49-0', name: 'P49', startSn: '花园永泉', endSn: '友爱公交站',
          firstTime: '00:00', lastTime: '23:59',
          departLeft: Date.now() + 900000, depIntervalM: 8, preArrivalTime: '',
          stations: [
            { stationId: '028-3', order: 3, name: '友爱公交站', lat: 30.6, lng: 103.9 },
            { stationId: '028-1', order: 1, name: '花园永泉', lat: 30.7, lng: 103.95 },
          ],
        } });
      }
      if (lineId.includes('p36')) {
        return JSON.stringify({ state: 'ok', data: {
          lineId: '028-p36-0', name: 'P36', startSn: '郫都区客运中心', endSn: '花园公交站',
          firstTime: '06:00', lastTime: '22:30',
          stations: [
            { stationId: '028-9', order: 1, name: '郫都区客运中心', lat: 30.8, lng: 103.9 },
            { stationId: '028-1', order: 5, name: '花园公交站', lat: 30.7, lng: 103.95 },
            { stationId: '028-3', order: 3, name: '友爱公交站', lat: 30.6, lng: 103.9 },
          ],
        } });
      }
      return JSON.stringify({ state: 'ok', data: {
        lineId: lineId, name: 'P02', startSn: '花园公交站', endSn: '郫都区客运中心',
        firstTime: '00:00', lastTime: '23:59',
        stations: [
          { stationId: '028-9', order: 1, name: '郫都区客运中心', lat: 30.8, lng: 103.9 },
          { stationId: '028-1', order: 8, name: '花园永泉', lat: 30.7, lng: 103.95 },
        ],
      } });
    }
    if (method === 'arrivals') {
      if (String(args.lineId || '').includes('p49')) {
        return JSON.stringify({ state: 'ok', data: [] });
      }
      const two = [
        { busId: 'b1', plate: '42516', order: 19, stationsAway: 3,
          distanceMeters: 1200, etaSeconds: 600, arrivalAt: Date.now() + 600000, arrived: false },
        { busId: 'b2', plate: '42517', order: 12, stationsAway: 10,
          distanceMeters: 5200, etaSeconds: 1500, arrivalAt: Date.now() + 1500000, arrived: false },
      ];
      return JSON.stringify({ state: 'ok', data: two });
    }
    if (method === 'location') {
      return JSON.stringify({ state: 'ok', data: { lat: 30.657, lng: 104.065, accuracy: 30, provider: 'network', stale: false } });
    }
    if (method === 'city') return JSON.stringify({ state: 'ok', data: { city: '成都' } });
    if (method === 'nearby') return JSON.stringify({ state: 'ok', data: nearbyPayload });
    return JSON.stringify({ state: 'ok', data: [] });
  },
  speak(text) { speakLog.push(String(text)); },
  startWatchService(payload) { watchServiceLog.push(['start', String(payload || '')]); },
  stopWatchService() { watchServiceLog.push(['stop', '']); },
  status() {
    return JSON.stringify({ ttsReady: true, backend: '系统语音', engines: 'com.xiaomi.tts', mediaVolume: 10, mediaMax: 29, ringerMode: 2, outputs: '扬声器', lastResult: '已交给系统 TTS' });
  },
  setView() {},
  note() {},
  backend() { return '系统语音'; },
  testTone() {}, testPcm() {}, testSysTone() {}, testSpeak() {}, setVolume() {},
  location() { return '30.657,104.065'; },
};

const window = { AndroidBus: bridge };

// ---------------------------------------------------- 静态检查：调用了但没定义的函数

const defined = new Set();
for (const m of script.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)) defined.add(m[1]);
for (const m of script.matchAll(/(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function|\()/g)) defined.add(m[1]);
for (const m of script.matchAll(/function\s*[A-Za-z_$]?[\w$]*\s*\(([^)]*)\)/g)) {
  for (const p of m[1].split(',')) {
    const name = p.trim().split(/[=\s]/)[0];
    if (name) defined.add(name);
  }
}
for (const m of script.matchAll(/\(([^)]*)\)\s*=>/g)) {
  for (const p of m[1].split(',')) {
    const name = p.trim();
    if (/^[A-Za-z_$][\w$]*$/.test(name)) defined.add(name);
  }
}

const builtins = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'new', 'function', 'await', 'async',
  'do', 'else', 'try', 'throw', 'delete', 'void', 'in', 'of', 'instanceof', 'yield',
  'JSON', 'String', 'Number', 'Boolean', 'Math', 'Date', 'Object', 'Array', 'Promise', 'Error', 'Blob', 'URL',
  'setTimeout', 'setInterval', 'clearInterval', 'clearTimeout', 'requestAnimationFrame', 'parseInt', 'parseFloat', 'isNaN',
  'encodeURIComponent', 'decodeURIComponent', 'btoa', 'atob', 'Uint8Array', 'ArrayBuffer',
  'DataView', 'Audio', 'localStorage', 'document', 'window', 'console', 'fetch', 'rpc', 'speak',
]);

// 静态检查前先去掉字符串字面量，避免 "play()" 这种文本被当成调用
const codeOnly = script
  .replace(/"(?:[^"\\]|\\.)*"/g, '""')
  .replace(/'(?:[^'\\]|\\.)*'/g, "''")
  .replace(/`(?:[^`\\]|\\.)*`/g, "``");

const used = [];
for (const m of codeOnly.matchAll(/(?<![\w.$])([A-Za-z_$][\w$]*)\s*\(/g)) used.push(m[1]);
const missingFns = [...new Set(used)].filter((n) => !defined.has(n) && !builtins.has(n));

// ---------------------------------------------------------------- 执行

const errors = [];
process.on('unhandledRejection', (err) => errors.push('unhandledRejection: ' + (err?.message ?? err)));
process.on('uncaughtException', (err) => errors.push('uncaughtException: ' + err.message));

const run = new Function(
  'window', 'document', 'localStorage', 'Audio', 'console',
  `${script}\n`,
);
try {
  run(window, document, localStorage, FakeAudio, console);
} catch (err) {
  console.error('✗ 脚本初始化就抛异常：' + err.message);
  process.exit(1);
}

await new Promise((r) => setTimeout(r, 600));

// ---------------------------------------------------------------- 断言

const list = document.getElementById('list');
const rendered = String(list.innerHTML || '');
const status = String(document.getElementById('status').textContent || '');
const failures = [];

if (errors.length) failures.push(...errors);
if (/is not a function|is not defined|undefined 的/.test(rendered)) {
  failures.push('列表渲染报错：' + rendered.slice(0, 160));
}
if (!rendered.includes('花园永泉')) failures.push('没有渲染出站点「花园永泉」');
if (!rendered.includes('龙溪村委会')) failures.push('没有渲染出站点「龙溪村委会」');
if (!rendered.includes('不在运营时段')) failures.push('收班线路没有标「不在运营时段」');
if (!rendered.includes('暂无实时车辆')) failures.push('没有到站数据的站点没有标「暂无实时车辆」');
if (!/\d+s 后自动刷新/.test(String(document.getElementById('refreshNote').textContent || ''))) {
  failures.push('没有显示自动刷新倒计时');
}

// 顶部设置按钮 → 打开设置（含语音自检）；底部不再有 🔧 和状态文字
const settingsBtn = document.getElementById('settingsBtn');
if (!settingsBtn) failures.push('顶部没有设置按钮');
else {
  settingsBtn.onclick();
  if (String(document.getElementById('diag').className).includes('hidden')) {
    failures.push('点设置没有打开面板');
  }
  document.getElementById('dClose').onclick();
}
if (html.includes('id="diagBtn"')) failures.push('底部还残留 🔧 按钮');
if (html.includes('id="speakBtn"')) failures.push('底部还残留大播报按钮');
// 底部只剩两个开关
const footerSwitches = (document.getElementById('voice') && document.getElementById('watch')) ? 2 : 0;
if (footerSwitches !== 2) failures.push('底部开关数量不对');
if (String(document.getElementById('status').className).indexOf('hidden') < 0) {
  failures.push('右下角状态文字没有隐藏');
}

// 自动播报默认关闭，并且能记住用户选择
const voiceBox = document.getElementById('voice');
if (voiceBox.checked) failures.push('首次打开时自动播报不应默认开启');
voiceBox.checked = true;
voiceBox.onchange();
if (localStorage.getItem('cdbus.voiceAuto') !== '1') failures.push('打开自动播报后没有写入设置');
voiceBox.checked = false;
voiceBox.onchange();
if (localStorage.getItem('cdbus.voiceAuto') !== '0') failures.push('关闭自动播报后没有写入设置');
if (!rendered.includes('途经')) failures.push('站点卡没有「途经」线路行');
if (/出错了/.test(rendered)) failures.push('界面进入了出错分支：' + rendered.slice(0, 160));
if (missingFns.length) failures.push('调用了未定义的函数：' + missingFns.join(', '));

const favsHtml = String(document.getElementById('favs').innerHTML || '');
if (!favsHtml.includes('16路')) failures.push('收藏区域没有渲染线路名');
if (!favsHtml.includes('天府广场南')) failures.push('收藏区域没有渲染站点名');
if (!/还有 \d+ 站/.test(favsHtml)) failures.push('收藏卡没有拉到实时到站：' + favsHtml.slice(0, 120));

// 播报文案也要过筛：收班的线路不能被念成「还有 N 站」
const spoken = typeof window.cdBusNearbyText === 'function'
  ? window.cdBusNearbyText(window.cdBusBuildGroups ? window.cdBusBuildGroups(nearbyPayload.stops) : nearbyPayload.stops)
  : '';
if (!spoken) failures.push('附近播报文案为空');
console.log('  实际播报：' + spoken);
if (/716路/.test(spoken)) failures.push('播报念了已收班的线路：' + spoken);
if (/43 站/.test(spoken)) failures.push('播报念了收班线路的陈旧站数：' + spoken);
if (!/往花园公交站/.test(spoken)) failures.push('播报没有念方向：' + spoken);
if (!/待发车 09:24/.test(spoken)) failures.push('播报没有念待发车时间：' + spoken);
if (!/暂无实时车辆/.test(spoken)) failures.push('播报没有说明无车：' + spoken);

if (failures.length) {
  console.error('✗ UI 冒烟失败：');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}

// ---------------------------------------------------- 第二阶段：搜索 → 选站 → 首页收藏

document.getElementById('line').value = 'P36';
document.getElementById('go').onclick();
await new Promise((r) => setTimeout(r, 800));

// 现在只搜线路，站名靠点芯片选择
const stationChips = findByText(document.getElementById('chips'), '花园公交站');
if (!stationChips.length) {
  console.error('✗ UI 冒烟失败：选线路后没有出现站名芯片');
  process.exit(1);
}
stationChips[0].onclick();
await new Promise((r) => setTimeout(r, 800));

// 搜索页点刷新：只刷当前站点，不能拉回首页
document.getElementById('refreshHome').onclick();
await new Promise((r) => setTimeout(r, 800));
if (!document.getElementById('chips').children.length) {
  stage2.push('刷新后站名芯片消失（被拉回首页）');
}
if (textOf(document.getElementById('list')).includes('途经')) {
  stage2.push('刷新后列表变成了附近站点');
}

const selbar = document.getElementById('selbar');
const seltext = String(document.getElementById('seltext').textContent || '');
const hfav = document.getElementById('hfav');
const stage2 = [];
if (String(selbar.className).includes('hidden')) stage2.push('选站后仍没有收藏条');
if (!seltext.includes('P36路')) stage2.push('收藏条没有显示线路：' + seltext);
if (!seltext.includes('花园公交站')) stage2.push('收藏条没有显示站点：' + seltext);
if (!String(hfav.textContent).includes('☆')) stage2.push('收藏按钮状态不对：' + hfav.textContent);

const before = JSON.parse(storage.get('cdbus.favorites') || '[]').length;
hfav.onclick();
const after = JSON.parse(storage.get('cdbus.favorites') || '[]').length;
if (after !== before + 1) stage2.push(`点收藏没写入（${before} → ${after}）`);
if (!String(document.getElementById('status').textContent).includes('已收藏')) stage2.push('状态栏没有提示已收藏');
if (!String(document.getElementById('favs').innerHTML).includes('P36路')) stage2.push('首页收藏区没有出现 P36路');

// 退出查询 → 回到附近站点
document.getElementById('exitSearch').onclick();
await new Promise((r) => setTimeout(r, 900));
const afterExit = String(document.getElementById('list').innerHTML || '');
if (String(document.getElementById('chips').innerHTML || '').length) stage2.push('退出后站名芯片没清空');
if (!afterExit.includes('花园永泉')) stage2.push('退出后没有回到附近站点：' + afterExit.slice(0, 120));
if (!String(document.getElementById('selbar').className).includes('hidden')) {
  stage2.push('退出后查询条没有收起');
}

if (stage2.length) {
  console.error('✗ UI 冒烟失败（收藏链路）：');
  for (const f of stage2) console.error('  - ' + f);
  process.exit(1);
}

// ---------------------------------------------------- 第三阶段：同一站点两个方向分开显示

// 第二阶段把列表切成了线路查询视图，先回到附近站点
document.getElementById('near').onclick();
await new Promise((r) => setTimeout(r, 1800));

const stopCards = document.getElementById('list').children;
const cardsHtml = stopCards.map((c) => textOf(c)).join('\n');
const stage3 = [];


if (/⇄/.test(cardsHtml)) stage3.push('首页还残留 ⇄ 换向按钮');
if (!cardsHtml.includes('→ 花园公交站')) stage3.push('没有显示正向：' + cardsHtml.slice(0, 200));
if (!cardsHtml.includes('→ 郫都区客运中心')) stage3.push('没有补出反方向：' + cardsHtml.slice(0, 200));
if (!/P36路 → 花园公交站[^›]*还有 3 站/.test(cardsHtml)) {
  stage3.push('近似站名没有合并/数据没带过来：' + cardsHtml.slice(0, 240));
}
if (!/下辆 \d+ 站/.test(cardsHtml)) stage3.push('同一方向多辆车时没有显示「下辆 N 站」：' + cardsHtml.slice(0, 240));
if (!cardsHtml.includes('待发车 09:24')) stage3.push('起点站没有显示待发车时间：' + cardsHtml.slice(0, 240));
if (!/720路[^›]*待发车 09:24/.test(cardsHtml.replace(/\n/g, ''))) {
  stage3.push('720路起点站那一行不是「待发车 09:24」');
}
// 同名站点应该合并成一张卡片
if (stopCards.length !== 4) stage3.push('站点卡片数不对：' + stopCards.length);
if (!cardsHtml.includes('途经')) stage3.push('站点卡缺少途经线路');
if (!/🔊/.test(cardsHtml)) stage3.push('线路行没有单独的播报按钮');
const allRows = findByClass(document.getElementById('list'), 'armeta');
const rowsWithoutSpeaker = allRows.filter((row) => !findByClass(row, 'spk').length);
if (!/P49路[^›]*待发车 \d{2}:\d{2}/.test(cardsHtml)) {
  stage3.push('没有在途车的行没有显示起点预估发车：' + cardsHtml.slice(-320));
}
if (rowsWithoutSpeaker.length) {
  stage3.push(rowsWithoutSpeaker.length + ' 行缺少小喇叭：' + textOf(rowsWithoutSpeaker[0]).slice(0, 60));
}

// 点某一行的小喇叭：应该只念这一行（方向可选）
const spkButtons = findByClass(document.getElementById('list'), 'spk');
if (!spkButtons.length) {
  stage3.push('没有找到行内播报按钮');
} else {
  spkButtons[0].onclick({ stopPropagation() {} });
  await new Promise((r) => setTimeout(r, 100));
  if (!speakLog.some((t) => /往/.test(t))) {
    stage3.push('行内播报没有念方向：' + JSON.stringify(speakLog.slice(-2)));
  }
}
if (!/flex-wrap:\s*nowrap/.test(html) || !/overflow-x:\s*auto/.test(html)) {
  stage3.push('站点芯片没有改成横向滑动');
}

if (stage3.length) {
  console.error('✗ UI 冒烟失败（双向显示）：');
  for (const f of stage3) console.error('  - ' + f);
  process.exit(1);
}

console.log('✓ UI 冒烟通过：站点渲染、收班标记、途经线路都正常');
console.log('✓ 双向显示通过：同一站点两个方向分行显示，无 ⇄ 按钮');
console.log('✓ 收藏链路通过：选站出现收藏条 → 点收藏写入并展示在首页');

// ------------------------------------------------ 第四阶段：收藏卡上的 📌 盯站

function findByClass(node, cls, out = [], seen = new Set()) {
  if (!node || seen.has(node)) return out;
  seen.add(node);
  if (String(node.className || '').split(' ').includes(cls)) out.push(node);
  for (const child of node.children || []) {
    child.parent = node;
    findByClass(child, cls, out, seen);
  }
  return out;
}

function findByText(node, text, out = []) {
  if (!node) return out;
  if (String(node.textContent || '') === text) out.push(node);
  for (const child of node.children || []) findByText(child, text, out);
  return out;
}

const stage4 = [];
const pins = findByText(document.getElementById('favs'), '📌');
if (!pins.length) stage4.push('收藏卡片没有 📌 盯站按钮');
else {
  pins[0].onclick({ stopPropagation() {} });
  await new Promise((r) => setTimeout(r, 200));
  const statusText = String(document.getElementById('status').textContent || '');
  if (!/盯站中/.test(statusText)) stage4.push('点 📌 后没有进入盯站：' + statusText);
  if (!document.getElementById('watch').checked) stage4.push('底部盯站开关没有同步');
}

if (stage4.length) {
  console.error('✗ UI 冒烟失败（盯站）：');
  for (const f of stage4) console.error('  - ' + f);
  process.exit(1);
}
console.log('✓ 盯站通过：收藏卡 📌 → 进入盯站，底部开关同步');

// 模拟退到后台：应把盯站交给前台服务
if (typeof window.cdBusStartBackgroundWatch === 'function') {
  window.cdBusStartBackgroundWatch();
  if (!watchServiceLog.some((x) => x[0] === 'start')) {
    console.error('✗ UI 冒烟失败：退到后台没有启动盯站服务');
    process.exit(1);
  }
  console.log('✓ 后台常驻通过：退到后台会启动前台服务');
}

// ------------------------------------------ 第五阶段：收藏进详情，芯片显示「距收藏站 / 已过」

const favCards = findByClass(document.getElementById('favs'), 'fav');
const stage5 = [];
if (!favCards.length) stage5.push('收藏卡为空');
else {
  favCards[0].onclick();
  await new Promise((r) => setTimeout(r, 900));
  const chipsHtml = textOf(document.getElementById('dbuses'));
  const chipEls = findByClass(document.getElementById('dbuses'), 'chip');
  if (chipEls.length < 3) stage5.push('车辆芯片未渲染完整：' + chipEls.length);
  else {
    const t0 = String(chipEls[0].textContent || '');
    const t1 = String(chipEls[1].textContent || '');
    if (!/距终点 28 站/.test(t0)) stage5.push('最左应是离起点最近的车（距终点 28 站）：' + t0);
    // 收藏站 order=22，三辆车在 2/12/19 站 → 最近的是 order=19（最右）
    const last = String(chipEls[chipEls.length - 1].textContent || '');
    if (!/最近/.test(last)) stage5.push('离我最近的车没有被标出：' + last);
    if (!String(chipEls[chipEls.length - 1].className).includes('on')) {
      stage5.push('默认没有选中离我最近的车');
    }
  }
  const dlistHtml = textOf(document.getElementById('dlist'));
  if (!dlistHtml.includes('srow')) stage5.push('详情页没有渲染站点行');
  else if (!/class="srow current/.test(dlistHtml)) stage5.push('没有标出「车当前所在站」');
  if (!chipsHtml.includes('距终点')) stage5.push('车辆芯片没有「距终点」：' + chipsHtml);
  if (!/已过收藏站|距收藏站/.test(chipsHtml)) stage5.push('车辆芯片没有「收藏站」距离：' + chipsHtml);
  if (favCards[0] && textOf(document.getElementById('dbuses')).includes('undefined')) {
    stage5.push('芯片文案出现 undefined');
  }
  // 顶部（方向 + 车辆）应保持 sticky，跳转后仍在
  if (!document.getElementById('dtop')) stage5.push('详情页缺少 sticky 顶部容器');
  if (!/position:\s*sticky/.test(html)) stage5.push('顶部没有 sticky 样式');
  if (!html.includes('startDetailAutoRefresh')) stage5.push('详情页没有 30 秒自动刷新');
  const depText = String(document.getElementById('deptext').textContent || '');
  if (!/发车预测：预计 \d{2}:\d{2} 发车/.test(depText)) stage5.push('没有显示发车预测：' + depText);
  if (!/发车间隔约 12 分钟/.test(depText)) stage5.push('没有显示发车间隔：' + depText);
  document.getElementById('back').onclick();
}

if (stage5.length) {
  console.error('✗ UI 冒烟失败（收藏进详情）：');
  for (const f of stage5) console.error('  - ' + f);
  process.exit(1);
}
console.log('✓ 收藏进详情通过：芯片显示「已过收藏站 · 距终点 N 站」');

// --------------------------------------------- 第六阶段：模糊搜索（输入 2 列出 2 开头线路）

document.getElementById('line').value = '2';
document.getElementById('stop').value = '';
document.getElementById('go').onclick();
await new Promise((r) => setTimeout(r, 900));

const stage6 = [];
const pickerHtml = textOf(document.getElementById('list'));
if (!pickerHtml.includes('匹配到')) stage6.push('输入 2 没有出现候选线路：' + pickerHtml.slice(0, 160));
for (const expect of ['20路', '20快', '21路']) {
  if (!pickerHtml.includes(expect)) stage6.push('候选里缺少 ' + expect);
}
if (typeof window.cdBusShouldAutoRefresh === 'function' && window.cdBusShouldAutoRefresh()) {
  stage6.push('搜索结果显示时，首页自动刷新没有被跳过');
}
const pickerCards = findByClass(document.getElementById('list'), 'bus');
if (pickerCards.length < 2) stage6.push('候选线路列表过少：' + pickerCards.length);

if (pickerCards.length) {
  pickerCards[0].onclick();
  await new Promise((r) => setTimeout(r, 900));
  if (String(document.getElementById('selbar').className).includes('hidden')) {
    stage6.push('点候选线路后没有进入该线路');
  }
}

if (stage6.length) {
  console.error('✗ UI 冒烟失败（模糊搜索）：');
  for (const f of stage6) console.error('  - ' + f);
  process.exit(1);
}
console.log('✓ 模糊搜索通过：输入 2 列出 20 / 20快 / 21 … 并可点选');

// 输入 106 应列出所有含 106 的线路（P106 / T106 / 1060）
document.getElementById('exitSearch').onclick();
await new Promise((r) => setTimeout(r, 700));
storage.set('cdbus.lines.106', JSON.stringify({
  at: Date.now(),
  list: [
    { lineId: '028-106-0', name: '106', direction: 0, startSn: 'A', endSn: 'B' },
    { lineId: '028-1060-0', name: '1060', direction: 0, startSn: 'C', endSn: 'D' },
  ],
}));
document.getElementById('line').value = '106';
document.getElementById('go').onclick();
await new Promise((r) => setTimeout(r, 900));
const containsHtml = textOf(document.getElementById('list'));
const stage7 = [];
for (const expect of ['P106路', 'T106路', '1060路']) {
  if (!containsHtml.includes(expect)) stage7.push('输入 106 没有列出 ' + expect + '：' + containsHtml.slice(0, 200));
}
if (stage7.length) {
  console.error('✗ UI 冒烟失败（包含匹配）：');
  for (const f of stage7) console.error('  - ' + f);
  process.exit(1);
}
console.log('✓ 包含匹配通过：输入 106 列出 P106 / T106 / 1060');

// 退出查询后，自动刷新恢复
document.getElementById('exitSearch').onclick();
await new Promise((r) => setTimeout(r, 800));
if (typeof window.cdBusShouldAutoRefresh === 'function' && !window.cdBusShouldAutoRefresh()) {
  console.log('  ⚠ 退出查询后自动刷新仍未恢复');
}

// ------------------------------------------------ 第八阶段：地铁 / 有轨电车（静态）

const metroFixture = {
  updated: '2026-08-01',
  source: 'OpenStreetMap (ODbL)',
  lines: [
    { id: '1', name: '成都地铁1号线', kind: 'metro', colour: '#0f6bb5', from: '韦家碾', to: '科学城',
      stations: [
        { name: '韦家碾', lat: 30.74, lng: 104.1 },
        { name: '天府广场', lat: 30.657, lng: 104.065 },
        { name: '科学城', lat: 30.5, lng: 104.1 },
      ] },
    { id: 'T2', name: '成都有轨电车蓉2号线', kind: 'tram', colour: '', from: '成都西站', to: '郫县西站',
      stations: [
        { name: '成都西站', lat: 30.69, lng: 103.99 },
        { name: '郫县西站', lat: 30.82, lng: 103.88 },
      ] },
  ],
  transfers: { '天府广场': ['1', '2'] },
};
document.getElementById('metroData').textContent = JSON.stringify(metroFixture);

const stage8 = [];
document.getElementById('openMetro').onclick();
await new Promise((r) => setTimeout(r, 500));
const lineChips = textOf(document.getElementById('mlines'));
if (!lineChips.includes('1号线')) stage8.push('地铁线路芯片没有 1号线：' + lineChips);
if (!lineChips.includes('蓉2号线')) stage8.push('有轨电车线路芯片没有 蓉2号线：' + lineChips);

const metroChips = findByClass(document.getElementById('mlines'), 'chip');
if (!metroChips.length) stage8.push('地铁线路芯片为空');
else {
  metroChips[0].onclick();
  await new Promise((r) => setTimeout(r, 400));
  const stationsHtml = textOf(document.getElementById('mlist'));
  if (!stationsHtml.includes('韦家碾')) stage8.push('选线路后没有列出站点：' + stationsHtml.slice(0, 120));
  if (!stationsHtml.includes('换乘 1/2')) stage8.push('换乘站没有标注');

  const stationRows = findByClass(document.getElementById('mlist'), 'srow');
  if (stationRows.length > 1) {
    stationRows[1].onclick();
    await new Promise((r) => setTimeout(r, 600));
    const panelHtml = textOf(document.getElementById('mstation'));
    if (!panelHtml) stage8.push('点站点后没有出现详情面板');
  }
}

// 原生返回键：地铁页回到首页
if (typeof window.cdBusBackView === 'function') {
  window.cdBusBackView();
  if (!String(document.getElementById('home').className).includes('hidden') &&
      !String(document.getElementById('metro').className).includes('hidden')) {
    stage8.push('返回后首页和地铁页同时可见');
  }
  if (String(document.getElementById('metro').className).indexOf('hidden') < 0) {
    stage8.push('系统返回没有离开地铁页');
  }
}

if (stage8.length) {
  console.error('✗ UI 冒烟失败（地铁）：');
  for (const f of stage8) console.error('  - ' + f);
  process.exit(1);
}
console.log('✓ 地铁/有轨通过：线路芯片、站点列表、换乘标注、站点详情');

// 首页有 30 秒自动刷新定时器，测试用完直接退出
process.exit(0);
console.log('  状态栏：' + status);