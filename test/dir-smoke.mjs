#!/usr/bin/env node
/**
 * 详情页「换向」冒烟：用真 DOM + 假 bridge 点一次方向芯片，盯住两件事。
 *
 * 为什么单独一条：西昌这类数据源的方向是**数字 routeDirId**（88 / 89），
 * 而界面沿用车来了的合成 lineId（`16|阳光路苑三期`）。芯片有两条渲染路径
 * （renderLineDirections / renderDetailDirections），两条都要把 routeDirId
 * 传下去；只要有一条忘了，点完换向下一次 matrix 又按旧方向查，
 * 用户看到的就是「点了另一条方向，一会儿自己弹回原来那条」。
 *
 * 这条测试不看源码长相，直接模拟点击，断言接口请求的方向 ID 变了、界面停住不动。
 * 没装 jsdom 就跳过。
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

let JSDOM, VirtualConsole;
try {
  ({ JSDOM, VirtualConsole } = await import('jsdom'));
} catch (e) {
  console.log('· 跳过换向冒烟（没装 jsdom，`npm i --no-save jsdom` 可启用）');
  process.exit(0);
}

const html = fs.readFileSync(path.join(root, 'app', 'assets', 'index.html'), 'utf8');

/* ---- 两个方向的假数据：站名相同、站序相反、站 ID 不同 ---- */
const names = ['建昌古城（四牌楼）', '四小', '阳光路苑三期'];
const dir = {
  88: { id: '88', start: names[0], end: names[2], stations: names.map((n, i) => ({ order: i + 1, name: n, sid: 'a' + i })) },
  89: { id: '89', start: names[2], end: names[0], stations: names.map((n, i) => ({ order: i + 1, name: n, sid: 'b' + i })).reverse() },
};
const dirChip = (d) => ({
  lineId: d.id, name: '16', fullName: '16路',
  firstTime: '06:40', lastTime: '20:40', startSn: d.start, endSn: d.end,
});

const matrixCalls = [];
let seq = 0;
const tasks = new Map();

function matrixFor(id) {
  const d = dir[id] || dir['88'];
  const other = id === '89' ? '88' : '89';
  return {
    line: { lineId: id, name: '16', startSn: d.start, endSn: d.end,
            firstTime: '06:40', lastTime: '20:40', price: '2元',
            depDesc: '', depIntervalM: -1, departLeft: 0, departRight: 0 },
    stations: d.stations.map((s) => ({ order: s.order, name: s.name, stationId: s.sid,
      lat: 27.9, lng: 102.2, suspended: false, loop: false, loopLen: 0 })),
    buses: [],
    /* 数据源自己给方向：当前方向排第一，另一方向在后 */
    directions: [dirChip(dir[id]), dirChip(dir[other])],
    queriedFrom: 1, queriedTo: d.stations.length,
  };
}
function detailFor(id) {
  const d = dir[id] || dir['88'];
  return {
    lineId: id, name: '16', startSn: d.start, endSn: d.end,
    firstTime: '06:40', lastTime: '20:40', price: '2元',
    stations: d.stations.map((s) => ({ order: s.order, name: s.name, stationId: s.sid,
      lat: 27.9, lng: 102.2, suspended: false, loop: false, loopLen: 0 })),
  };
}

function answer(method, args) {
  switch (method) {
    case 'matrix':
      matrixCalls.push(String(args.lineId));
      return matrixFor(String(args.lineId));
    case 'detail': return detailFor(String(args.lineId));
    case 'nearby': return { stops: [], allArrivals: [] };
    case 'lines': return [];
    case 'citytable': return [];
    case 'permissions': return { location: false };
    case 'location': return { lat: 27.9, lng: 102.2, source: 'test', accuracy: 10, costMs: 1 };
    default: return {};
  }
}

const errors = [];
const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  url: 'https://local/',
  virtualConsole: new VirtualConsole(),
  beforeParse(window) {
    window.addEventListener('error', (e) => errors.push(e.message));
    window.AndroidBus = {
      start(method, payload) {
        const id = 't' + (++seq);
        tasks.set(id, { method, args: JSON.parse(payload || '{}') });
        return id;
      },
      poll(id) {
        const t = tasks.get(id);
        if (!t) return '{"state":"error","error":"no task"}';
        const data = answer(t.method, t.args);
        return '{"state":"ok","data":' + (data === null ? 'null' : JSON.stringify(data)) + '}';
      },
      speak() {}, testTone() {}, status() { return '{}'; }, setView() {},
      backend() { return '{}'; }, navApps() { return '{"apps":[],"fallback":true}'; },
      watchStatus() { return '{"running":false}'; }, lockNotifyOn() { return false; },
      ignoringBatteryOptimizations() { return true; }, updatePoll() { return '[]'; },
      appInfo() { return '{"appName":"test","versionName":"test"}'; },
    };
  },
});

const win = dom.window;
const doc = win.document;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await wait(400);

const fail = [];
const chips = () => Array.from(doc.querySelectorAll('#ddirs .dirchip'));
const onIndex = () => chips().findIndex((c) => c.className.includes(' on'));
const title = () => doc.getElementById('dtitle').textContent;
const sub = () => doc.getElementById('dsub').textContent;

/* 从首页附近点进 16路（合成 lineId + 方向 ID） */
await win.cdBusOpenDetail({
  lineId: '16|阳光路苑三期', routeDirId: '88', lineName: '16',
  stationId: 'a1', stationName: '四小', fromOrder: 2, title: '16路 · 四小',
});
await wait(400);

if (chips().length !== 2) fail.push('详情页应画两颗方向芯片，实际 ' + chips().length);
if (onIndex() !== 0) fail.push('打开时应该是第一个方向高亮，实际索引 ' + onIndex());
if (!/建昌古城（四牌楼） → 阳光路苑三期/.test(sub())) fail.push('打开时方向文案不对：' + sub());

/* 点另一颗 */
const other = chips().find((c) => !c.className.includes(' on'));
if (!other) fail.push('没有可点的另一方向芯片');
else {
  if (typeof other.onclick !== 'function') fail.push('另一方向芯片没绑 onclick');
  else other.onclick();
}
await wait(600);

if (matrixCalls.length < 2) fail.push('换向后没有重新请求 matrix');
else if (matrixCalls[matrixCalls.length - 1] !== '89') {
  fail.push('换向后 matrix 仍按旧方向查（请求 lineId=' + matrixCalls[matrixCalls.length - 1] + '）—— 界面会弹回原方向');
}
if (onIndex() !== 0) fail.push('换向后应只有新方向高亮，实际索引 ' + onIndex());
if (!/阳光路苑三期 → 建昌古城（四牌楼）/.test(sub())) fail.push('换向后方向文案没变：' + sub());

/* 停一会儿：30 秒自动刷新那条路径也不能把它弹回去 */
await wait(1200);
if (!/阳光路苑三期 → 建昌古城（四牌楼）/.test(sub())) fail.push('换向 1.2 秒后又弹回原方向：' + sub());
if (matrixCalls[matrixCalls.length - 1] !== '89') fail.push('后续刷新又按旧方向查了');

if (errors.length) fail.push('页面脚本抛错：' + errors[0]);

if (fail.length) {
  console.error('✗ 换向冒烟失败：');
  for (const f of fail) console.error('  - ' + f);
  process.exit(1);
}
console.log('✓ 换向冒烟通过：点另一方向后 matrix 按新方向 ID 查，界面不再弹回原方向');
process.exit(0);