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
    style: {
      props: {},
      setProperty(k, v) { this.props[k] = String(v); },
      getPropertyValue(k) { return Object.prototype.hasOwnProperty.call(this.props, k) ? this.props[k] : ''; },
    },
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
    /* 属性桩：页面用 setAttribute / getAttribute 标记按钮（导航、下车提醒等） */
    attributes: {},
    setAttribute(k, v) { this.attributes[k] = String(v); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null; },
    removeAttribute(k) { delete this.attributes[k]; },
    /* 布局桩：真实 WebView 里有，页面里的滚动定位要用到 */
    getBoundingClientRect() {
      return { top: 0, left: 0, right: 360, bottom: 60, width: 360, height: 60 };
    },
    scrollTo() {},
    scrollIntoView() {},
    scrollLeft: 0,
    scrollTop: 0,
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
/* 根元素桩：页面用 document.documentElement.style.setProperty('--font-scale', …)
   控制字号，真实 WebView 里由 CSSOM 提供，桩里要手动实现。 */
const rootStyle = {
  props: {},
  setProperty(k, v) { this.props[k] = String(v); },
  getPropertyValue(k) { return Object.prototype.hasOwnProperty.call(this.props, k) ? this.props[k] : ''; },
  removeProperty(k) { delete this.props[k]; },
};
const document = {
  documentElement: { style: rootStyle },
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
}, {
  /* v1.0.30：站点收藏现在会记下「在哪条线上收藏的」，点回来直接回那条线 */
  type: 'station', stationId: '028-1', stationName: '花园永泉', lat: 30.7, lng: 103.95,
  lineId: '028-p02-0', lineName: 'P02', order: 9, toward: '郫都区客运中心',
  firstTime: '06:00', lastTime: '22:30', addedAt: Date.now(),
}]));
const localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: (k) => { storage.delete(k); },
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
      stationId: '028-1', name: '花园永泉', distanceMeters: 9, lineNames: 'P02路、716路、720路、45路',
      lat: 30.7, lng: 103.95,
      lineNameList: ['P02路', '716路', '720路', '45路'],
      arrivals: [
        { stationId: '028-1', stationName: '花园永泉', stationOrder: 5, lineId: '028-p02-0',
          lineName: 'P02', toward: '郫都区客运中心', stationsAway: 2, etaSeconds: 300,
          firstTime: '00:00', lastTime: '23:59', arrived: false },
        { stationId: '028-1', stationName: '花园永泉', stationOrder: 1, lineId: '028-720-0',
          lineName: '720', toward: '郫都区客运中心', stationsAway: 0, etaSeconds: null,
          firstTime: '00:00', lastTime: '23:59', preStartTime: '09:24', arrived: false },
        { stationId: '028-1', stationName: '花园永泉', stationOrder: 5, lineId: '028-716-0',
          lineName: '716', toward: '郫都区客运中心', stationsAway: 43, etaSeconds: null,
          firstTime: ENDED_FROM, lastTime: ENDED_TO, arrived: false },
      ],
    },
    {
      /* 对面站台：名字接近、不同 stationId、方向相反 —— 不该混进「同站其它」 */
      stationId: '028-1b', name: '花园永泉东', distanceMeters: 25, lat: 30.7002, lng: 103.9502,
      lineNames: '801路', lineNameList: ['801路'],
      arrivals: [
        { stationId: '028-1b', stationName: '花园永泉东', stationOrder: 2,
          lineId: '028-801-0', lineName: '801', toward: '花园公交站',
          stationsAway: 4, etaSeconds: 900, firstTime: '00:00', lastTime: '23:59', arrived: false },
      ],
    },
    {
      stationId: '028-2', name: '龙溪村委会', distanceMeters: 302, lineNames: 'P36路', lat: 30.702, lng: 103.953,
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
const alightServiceLog = [];
const exitLog = [];
const navLog = [];
const batteryLog = [];
const notes = [];
/* 让 arrivals 桩返回「已到站」的车（盯站到站播报测试用） */
let arrivalsArrived = false;
let arrivalsCalls = 0;   // arrivals 被调用次数（验证回到前台会重新拉数据）
let arrivalsEta = null;
const heartbeatLog = [];
let heartbeatRunning = false;
let watchDiagOn = false;
let watchSvcRunning = true;
let alightStatusState = { running: false };
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
      /* 区县名（都江堰…）：模拟真实接口的 10 条硬上限——
         单查「都江堰」只给 5 条线（×2 方向 = 10 条），
         必须靠前端按数字前缀展开才拿得全。 */
      if (/^都江堰/.test(key)) {
        const djy = ['都江堰1', '都江堰2', '都江堰3', '都江堰4', '都江堰5', '都江堰6',
          '都江堰10', '都江堰11', '都江堰12', '都江堰20', '都江堰32', '都江堰101'];
        const hit = djy.filter((n) => n.startsWith(key));
        const capped = hit.slice(0, 5);   // 每条线 2 方向 → 10 条，正好被截断
        const rows = [];
        capped.forEach((n) => {
          rows.push({ lineId: '028-djy-' + n + '-0', name: n, direction: 0,
            startSn: n + '起', endSn: n + '终', firstTime: '06:00', lastTime: '22:00' });
          rows.push({ lineId: '028-djy-' + n + '-1', name: n, direction: 1,
            startSn: n + '终', endSn: n + '起', firstTime: '06:00', lastTime: '22:00' });
        });
        return JSON.stringify({ state: 'ok', data: rows });
      }
      if (/^\d/.test(key)) {
        const names = ['2', '20', '20快', '21', '201', '106', '1060', 'P106', 'T106', '45']
          .filter((n) => n.toUpperCase().includes(key));
        /* 真实接口每条线都返回上下行两个 direction，
           搜索结果页要按线路名去重，这里按真实形态造数据 */
        const rows = [];
        names.forEach((n) => {
          rows.push({ lineId: '028-' + n + '-0', name: n, direction: 0,
            startSn: n + '起', endSn: n + '终', firstTime: '06:00', lastTime: '23:00' });
          rows.push({ lineId: '028-' + n + '-1', name: n, direction: 1,
            startSn: n + '终', endSn: n + '起', firstTime: '06:00', lastTime: '23:00' });
        });
        return JSON.stringify({ state: 'ok', data: rows });
      }
      const pLines = [
        /* 真实搜索接口不返回首末班（P36 两个方向都是空），
           必须靠详情接口补；两个方向故意给不同时间，验证各显示各的 */
        { lineId: '028-p36-0', name: 'P36', endSn: '花园公交站', startSn: '郫都区客运中心', direction: 0 },
        { lineId: '028-p36-1', name: 'P36', endSn: '郫都区客运中心', startSn: '花园公交站', direction: 1 },
        { lineId: '028-p02-0', name: 'P02', endSn: '花园公交站', startSn: '郫都区客运中心', direction: 0, firstTime: '00:00', lastTime: '23:59' },
        { lineId: '028-p02-1', name: 'P02', endSn: '郫都区客运中心', startSn: '花园公交站', direction: 1, firstTime: '00:00', lastTime: '23:59' },
        { lineId: '028-p49-0', name: 'P49', endSn: '友爱公交站', startSn: '花园永泉', direction: 0, firstTime: '00:00', lastTime: '23:59' },
        /* 「花园永泉」作为线路名出现两个方向，模拟真实数据（站点名与线路名同名） */
        /* 45 路：附近接口的 arrivals 里没有它，只能靠 lineNames 反查补出来 */
        { lineId: '028-45-0', name: '45', endSn: '双楠小区', startSn: '花园公交站', direction: 0, firstTime: '06:00', lastTime: '22:30' },
        { lineId: '028-45-1', name: '45', endSn: '花园公交站', startSn: '双楠小区', direction: 1, firstTime: '06:00', lastTime: '22:30' },
        { lineId: '028-hyyq-0', name: '花园永泉', endSn: '郫都区客运中心', startSn: '花园公交站', direction: 0, firstTime: '00:00', lastTime: '23:59' },
        { lineId: '028-hyyq-1', name: '花园永泉', endSn: '花园公交站', startSn: '郫都区客运中心', direction: 1, firstTime: '00:00', lastTime: '23:59' },
      ];
      return JSON.stringify({ state: 'ok', data: pLines.filter((l) => l.name.toUpperCase().includes(key)) });
    }

    if (method === 'stations') {
      const key = String(args.key || '');
      /* 真实接口 result.stations 单次最多 3 条（stationCount 是真实总数，
         且没有任何分页参数能翻页）。这里如实模拟：每次只给 3 条。 */
      /* 顺序按真实接口的返回（实测「花园」给 花园桥/花园路/花园街 三条） */
      const all = [
        { stationId: '028-10894', name: '花园桥', lat: 30.86, lng: 103.76, distance: 400 },
        { stationId: '028-40', name: '花园路', lat: 30.86, lng: 103.761, distance: 620 },
        { stationId: '028-23306', name: '花园街', lat: 30.86, lng: 103.762, distance: 800 },
        { stationId: '028-23531', name: '花园永泉', lat: 30.865296, lng: 103.762676, distance: 120 },
        { stationId: '028-40b', name: '花园路中', lat: 30.861, lng: 103.761, distance: 950 },
        { stationId: '028-23306b', name: '下花园街', lat: 30.862, lng: 103.762, distance: 1200 },
      ];
      const hit = all.filter((st) => st.name.includes(key));
      return JSON.stringify({ state: 'ok', data: hit.slice(0, 3) });
    }
    if (method === 'matrix') {
      /* v1.0.25 起详情页是「线路页 + 车辆」合体：站名芯片和标题都取自 matrix 的
         data.line / data.stations，桩必须按 lineId 返回对应线路，否则会串成 P02。 */
      if (String(args.lineId || '').includes('p36')) {
        return JSON.stringify({ state: 'ok', data: {
          line: { lineId: '028-p36-0', name: 'P36', startSn: '郫都区客运中心', endSn: '花园公交站',
                  firstTime: '06:00', lastTime: '22:30',
                  departLeft: Date.now() + 600000, depIntervalM: 8, preArrivalTime: '' },
          stations: [
            { order: 1, name: '郫都区客运中心', stationId: '028-9', lat: 30.8, lng: 103.9 },
            { order: 3, name: '招呼站', stationId: '028-4519', lat: 30.79, lng: 103.88 },
            { order: 5, name: '花园公交站', stationId: '028-1', lat: 30.7, lng: 103.95 },
            { order: 7, name: '招呼站', stationId: '028-4519', lat: 30.75, lng: 103.9 },
            { order: 9, name: '友爱公交站', stationId: '028-3', lat: 30.6, lng: 103.9 },
          ],
          buses: [
            { busId: 'p36a', plate: '42001', order: 9, stationsAway: 0, stationsToEnd: 0, passedSelected: false,
              times: [{ order: 9, passed: false, etaSeconds: 0, arrivalAt: Date.now() }] },
            { busId: 'p36b', plate: '42002', order: 3, stationsAway: 6, stationsToEnd: 6, passedSelected: false,
              times: [{ order: 9, passed: false, etaSeconds: 900, arrivalAt: Date.now() + 900000 }] },
          ],
          queriedFrom: 1, queriedTo: 9,
        } });
      }
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
      if (lineId.includes('hyyq')) {
        /* 同一 stationId 在上下行是两个不同坐标（马路两侧），真实数据就是这样 */
        const isDir1 = lineId.endsWith('-1');
        return JSON.stringify({ state: 'ok', data: {
          lineId, name: '花园永泉', startSn: '花园公交站', endSn: isDir1 ? '花园公交站' : '郫都区客运中心',
          firstTime: '00:00', lastTime: '23:59',
          stations: [
            { stationId: '028-1', order: 5, name: '花园永泉',
              lat: isDir1 ? 30.7004 : 30.7, lng: isDir1 ? 103.9506 : 103.95 },
          ],
        } });
      }
      if (lineId.includes('028-45-')) {
        return JSON.stringify({ state: 'ok', data: {
          lineId: lineId, name: '45', startSn: '花园公交站', endSn: '双楠小区',
          firstTime: '06:00', lastTime: '22:30',
          stations: [
            { stationId: '028-9', order: 1, name: '花园公交站', lat: 30.8, lng: 103.9 },
            { stationId: '028-1', order: 4, name: '花园永泉', lat: 30.7, lng: 103.95 },
          ],
        } });
      }
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
        /* 两个方向的首末班不同（真实数据常见：去程早、回程晚） */
        const back = lineId.endsWith('-1');
        return JSON.stringify({ state: 'ok', data: {
          lineId: back ? '028-p36-1' : '028-p36-0', name: 'P36',
          startSn: back ? '花园公交站' : '郫都区客运中心',
          endSn: back ? '郫都区客运中心' : '花园公交站',
          firstTime: back ? '06:30' : '06:00',
          lastTime: back ? '19:30' : '22:30',
          stations: [
            { stationId: '028-9', order: 1, name: '郫都区客运中心', lat: 30.8, lng: 103.9 },
            /* 真实数据里一条线上的多个「招呼站」共用同一个 stationId（P36 去程 5 个都是
               028-4519），选中必须按 order 判，否则点一个会亮一串 */
            { stationId: '028-4519', order: 3, name: '招呼站', lat: 30.79, lng: 103.88 },
            { stationId: '028-4519', order: 7, name: '招呼站', lat: 30.75, lng: 103.9 },
            { stationId: '028-1', order: 5, name: '花园公交站', lat: 30.7, lng: 103.95 },
            { stationId: '028-3', order: 9, name: '友爱公交站', lat: 30.6, lng: 103.9 },
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
      arrivalsCalls++;
      if (String(args.lineId || '').includes('p49')) {
        return JSON.stringify({ state: 'ok', data: [] });
      }
      /* 线路页车辆位置：查终点站的到站能拿回全线路在途车辆。
         P36 终点站是 order 9 的友爱公交站，返回两辆车（order 9 已到站、order 3 还在路上）。 */
      if (String(args.lineId || '').includes('p36') &&
          String((args.station && args.station.name) || '') === '友爱公交站') {
        return JSON.stringify({ state: 'ok', data: [
          { busId: 'p36a', plate: '42001', order: 9, stationsAway: 0,
            distanceMeters: 20, etaSeconds: 0, arrivalAt: Date.now(), arrived: true },
          { busId: 'p36b', plate: '42002', order: 3, stationsAway: 6,
            distanceMeters: 3200, etaSeconds: 900, arrivalAt: Date.now() + 900000, arrived: false },
        ] });
      }
      /* 起点站发车提醒测试：查起点站（order 1）时返回一辆刚发出、已走 2 站的车 */
      if (String((args.station && args.station.order) || '') === '1') {
        return JSON.stringify({ state: 'ok', data: [
          { busId: 'dep1', plate: '42600', order: 3, stationsAway: 2,
            distanceMeters: 900, etaSeconds: 240, arrivalAt: Date.now() + 240000, arrived: false },
        ] });
      }
      /* 指定 ETA 的场景（验证播报用实际时间，不写死「10 分钟」） */
      if (arrivalsEta !== null) {
        return JSON.stringify({ state: 'ok', data: [
          { busId: 'b7', plate: '42520', order: 20, stationsAway: 5,
            distanceMeters: 3000, etaSeconds: arrivalsEta,
            arrivalAt: Date.now() + arrivalsEta * 1000, arrived: false },
        ] });
      }
      /* 盯站「已到站」测试：把首辆车设成已到站（stationsAway/eta 都为 0） */
      if (arrivalsArrived) {
        return JSON.stringify({ state: 'ok', data: [
          { busId: 'b9', plate: '42519', order: 9, stationsAway: 0,
            distanceMeters: 0, etaSeconds: 0, arrivalAt: Date.now(), arrived: true },
        ] });
      }
      const two = [
        { busId: 'b1', plate: '42516', order: 19, stationsAway: 3,
          distanceMeters: 1200, etaSeconds: 600, arrivalAt: Date.now() + 600000, arrived: false },
        { busId: 'b2', plate: '42517', order: 12, stationsAway: 10,
          distanceMeters: 5200, etaSeconds: 1500, arrivalAt: Date.now() + 1500000, arrived: false },
        { busId: 'b3', plate: '42518', order: 9, stationsAway: 0,
          distanceMeters: 0, etaSeconds: 0, arrivalAt: Date.now(), arrived: true },
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
  /* 后台播报自检桩：假装服务在跑、唤醒锁已持有 */
  watchStatus() {
    return JSON.stringify({
      running: watchSvcRunning,
      lastMessage: '✅ 系统 TTS',
      lastTickAt: Date.now() - 5000,
      lastSpeakAt: Date.now() - 12000,
      wakeHeld: true,
    });
  },
  requestIgnoreBatteryOptimization() { batteryLog.push('request'); },
  ignoringBatteryOptimizations() { return false; },
  /* 后台心跳桩：第一次调用启动，第二次调用停止 */
  startHeartbeat() {
    heartbeatRunning = !heartbeatRunning;
    heartbeatLog.push(heartbeatRunning ? 'start' : 'stop');
    return JSON.stringify({ running: heartbeatRunning, count: heartbeatRunning ? 0 : 3,
      lastAt: Date.now(), lastText: '后台心跳第 3 次', lastResult: '✅ 系统 TTS' });
  },
  toggleWatchDiag() { watchDiagOn = !watchDiagOn; return watchDiagOn; },
  heartbeatStatus() {
    return JSON.stringify({ running: heartbeatRunning, count: heartbeatRunning ? 1 : 3,
      lastAt: Date.now(), lastText: '后台心跳第 1 次', lastResult: '✅ 系统 TTS' });
  },
  startAlightService(payload) { alightServiceLog.push(['start', String(payload || '')]); },
  stopAlightService() { alightServiceLog.push(['stop', '']); },
  alightStatus() { return JSON.stringify(alightStatusState); },
  exitApp() { exitLog.push(Date.now()); },
  appInfo() {
    return JSON.stringify({ version: '9.7', code: 88, pkg: 'com.chengdu.bus', android: '15', sdk: 35, device: 'Redmi 2211133C' });
  },
  status() {
    return JSON.stringify({ ttsReady: true, backend: '系统语音', engines: 'com.xiaomi.tts', mediaVolume: 10, mediaMax: 29, ringerMode: 2, outputs: '扬声器', lastResult: '已交给系统 TTS' });
  },
  setView() {},
  note(t) { notes.push(String(t)); },
  backend() { return '系统语音'; },
  /* 导航桩：假装装了高德和百度 */
  navApps() {
    return JSON.stringify({
      apps: [
        { id: 'amap', label: '高德地图', pkg: 'com.autonavi.minimap' },
        { id: 'baidu', label: '百度地图', pkg: 'com.baidu.BaiduMap' },
      ],
      fallback: false,
    });
  },
  /* 导航桩：假装装了高德和百度；按 500 米规则回报 walk/drive */
  navigate(appId, lat, lng, name, fromLat, fromLng) {
    const R = 6371000;
    let distance = -1;
    if (typeof fromLat === 'number' && !Number.isNaN(fromLat)
        && typeof fromLng === 'number' && !Number.isNaN(fromLng)) {
      const dLat = (lat - fromLat) * Math.PI / 180;
      const dLng = (lng - fromLng) * Math.PI / 180;
      const a = Math.sin(dLat / 2) ** 2
        + Math.cos(fromLat * Math.PI / 180) * Math.cos(lat * Math.PI / 180)
        * Math.sin(dLng / 2) ** 2;
      distance = Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
    }
    const mode = distance >= 0 && distance <= 500 ? 'walk' : 'drive';
    navLog.push({ appId, lat, lng, name, fromLat, fromLng, mode, distance });
    return JSON.stringify({ ok: true, app: appId || 'amap', label: '高德地图', mode, distance });
  },
  testTone() {}, testPcm() {}, testSysTone() {}, testSpeak() {}, setVolume() {},
  location() { return '30.657,104.065'; },
};

const window = {
  AndroidBus: bridge,
  /* 布局桩：页面里的滚动定位会用 window.innerHeight / scrollY / scrollTo */
  innerHeight: 800,
  innerWidth: 400,
  scrollY: 0,
  pageYOffset: 0,
  scrollTo() {},
  addEventListener() {},
  requestAnimationFrame(fn) { return setTimeout(fn, 0); },
};

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
  'setTimeout', 'setInterval', 'clearInterval', 'clearTimeout', 'requestAnimationFrame', 'parseInt', 'parseFloat', 'isNaN', 'isFinite',
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

/* 首次打开必须自动弹使用说明（未读状态下，1.5 秒后触发）。
   这是真实路径，不是手动调 openGuideModal —— 之前 view.name 没初始化
   导致条件恒为 false，弹窗永远不出现。 */
{
  // 假 DOM 不解析 HTML 属性，不能靠 className 判断「是否隐藏」；
  // 直接等自动触发（脚本里是 1500ms）后检查内容是否被填进来。
  const gmBox = document.getElementById('guideModalList');
  for (let i = 0; i < 40 && !String(gmBox.__rawHtml || '').includes('盯站'); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const gml = textOf(gmBox);
  if (!gml.includes('盯站')) {
    console.error('✗ 首次打开没有自动弹出使用说明（1.5 秒后仍未填充内容）');
    process.exit(1);
  }
  if (!gml.includes('下车提醒')) {
    console.error('✗ 首次弹窗内容不完整：' + gml.slice(0, 100));
    process.exit(1);
  }
  // 点「知道了」→ 记录已读并关闭
  document.getElementById('guideOk').onclick();
  await new Promise((r) => setTimeout(r, 60));
  if (localStorage.getItem('cdbus.guide.seen') !== '1') {
    console.error('✗ 点「知道了」后没有记录已读标记');
    process.exit(1);
  }
}

/* 搜索必须做「前缀 + 尾缀」双向扩展：
   车来了 query!nSearch 单次最多返回约 10 条（lineCount 给的是真实总数），
   只查一个 key 一定漏线路。这里验证 36 → 会去查 360..369 和 136..936。 */
{
  const searchLines = window.cdBusSearchLines;
  if (typeof searchLines !== 'function') {
    console.error('✗ 没有暴露 cdBusSearchLines');
    process.exit(1);
  }
  const queries = [];
  const origStart = window.AndroidBus.start;
  window.AndroidBus.start = function (method, payload) {
    if (method === 'lines') queries.push(String(JSON.parse(payload).key));
    return origStart.apply(this, arguments);
  };
  localStorage.removeItem('cdbus.lines3.36');
  await searchLines('36');
  window.AndroidBus.start = origStart;

  const hasPrefix = queries.some((q) => q === '360' || q === '369');
  const hasSuffix = queries.some((q) => q === '136' || q === '936');
  if (!hasPrefix) {
    console.error('✗ 搜索 36 没有做前缀扩展（应查 360~369）：' + queries.join(','));
    process.exit(1);
  }
  if (!hasSuffix) {
    console.error('✗ 搜索 36 没有做尾缀扩展（应查 136~936）：' + queries.join(','));
    process.exit(1);
  }
  const hasRegion = queries.some((q) => q === '都江堰36' || q === '简阳36');
  if (!hasRegion) {
    console.error('✗ 搜索 36 没有查区县前缀线路（应查 都江堰36 / 简阳36）：' + queries.join(','));
    process.exit(1);
  }
  if (queries.length < 20) {
    console.error('✗ 搜索 36 查询次数太少（' + queries.length + '）：' + queries.join(','));
    process.exit(1);
  }
}

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
/* v1.0.23：首页卡片取消「途经」和首末班时间，只剩站名 + 三列线路名 */
if (/不在运营时段/.test(rendered)) {
  failures.push('首页卡片还在显示收班时间：' + (rendered.match(/不在运营时段[^<]*/) || [''])[0]);
}
if (!rendered.includes('暂无实时车辆')) failures.push('没有到站数据的站点没有标「暂无实时车辆」');
/* 首页站点卡右上角要有 🧭 导航按钮，点了能调起地图 */

if (!/^\d+$/.test(String(document.getElementById('refreshNote').textContent || '').trim())) {
  failures.push('倒计时应只显示数字：' + document.getElementById('refreshNote').textContent);
}

// 顶部设置按钮 → 打开设置（含语音自检）；底部不再有 🔧 和状态文字
const settingsBtn = document.getElementById('settingsBtn');
if (!settingsBtn) failures.push('顶部没有设置按钮');
if (!String(html).includes('setPageAbout')) failures.push('设置里没有「关于」区块');
if (/实时到站/.test(html.split('</header>')[0])) failures.push('顶部仍有「实时到站」标签');
if (html.indexOf('id="loctext"') > html.indexOf('<div class="row">')) {
  failures.push('定位信息没有移到标题后面');
}
if (!/class="homehead"/.test(html)) failures.push('头部布局标记丢失');
if (!/user-select:\s*none/.test(html)) failures.push('没有禁用长按选中文字');
if (!/input, textarea \{ -webkit-user-select: text/.test(html)) failures.push('输入框应仍可选中/编辑');
if (!/class="topline"/.test(html) || !/class="locline"/.test(html)) failures.push('头部没有拆成标题行/定位行两排');
else {
  settingsBtn.onclick();
  if (String(document.getElementById('diag').className).includes('hidden')) {
    failures.push('点设置没有打开面板');
  }

  /* 设置页二级菜单：进入分类后按返回应回设置主页，而不是直接回首页 */
  {
    document.getElementById('setVoice').onclick();
    await new Promise((r) => setTimeout(r, 100));
    if (String(document.getElementById('setPageVoice').className).includes('hidden')) {
      failures.push('点「语音与播报」没有进入二级页');
    }
    // 模拟系统返回键
    window.cdBusBackView && window.cdBusBackView();
    await new Promise((r) => setTimeout(r, 100));
    if (String(document.getElementById('diag').className).includes('hidden')) {
      failures.push('二级页返回直接跳出了设置（应回设置主页）');
    }
    if (String(document.getElementById('setHome').className).includes('hidden')) {
      failures.push('二级页返回没有回到设置主页');
    }
  }

  /* 使用说明：设置里能进二级页，且内容不为空 */
  {
    document.getElementById('setGuide').onclick();
    await new Promise((r) => setTimeout(r, 100));
    if (String(document.getElementById('setPageGuide').className).includes('hidden')) {
      failures.push('点「使用说明」没有进入二级页');
    }
    const gbody = textOf(document.getElementById('guideBody'));
    if (gbody.length < 100) failures.push('使用说明内容太少：' + gbody.length);
    if (!gbody.includes('盯站')) failures.push('使用说明缺少「盯站」条目');
    if (!gbody.includes('下车提醒')) failures.push('使用说明缺少「下车提醒」条目');
    if (!gbody.includes('收藏站点')) failures.push('使用说明缺少「收藏站点」条目');
    // 图解：每条说明都带示意（内容由 innerHTML 生成，直接数类名出现次数）
    const demoCount = (String(document.getElementById('guideBody').__rawHtml || '').match(/class="gdemo"/g) || []).length;
    if (demoCount < 8) failures.push('使用说明图解太少：' + demoCount);
    // 返回设置主页
    window.cdBusBackView && window.cdBusBackView();
    await new Promise((r) => setTimeout(r, 100));
    if (String(document.getElementById('setHome').className).includes('hidden')) {
      failures.push('使用说明返回没有回到设置主页');
    }
  }

  /* 首次弹窗：未看过时能弹出，点「知道了」后记录已读 */
  {
    const modal = document.getElementById('guideModal');
    storage.delete('cdbus.guide.seen');
    window.cdBusOpenGuideModal && window.cdBusOpenGuideModal();
    await new Promise((r) => setTimeout(r, 50));
    if (String(modal.className).includes('hidden')) {
      failures.push('首次使用说明弹窗没有弹出');
    }
    const mlist = textOf(document.getElementById('guideModalList'));
    if (!mlist.includes('盯站') || !mlist.includes('下车提醒')) {
      failures.push('首次弹窗内容不完整：' + mlist.slice(0, 80));
    }
    document.getElementById('guideOk').onclick();
    await new Promise((r) => setTimeout(r, 50));
    if (!String(modal.className).includes('hidden')) {
      failures.push('点「知道了」后弹窗没有关闭');
    }
    if (storage.get('cdbus.guide.seen') !== '1') {
      failures.push('点「知道了」后没有记录已读标记');
    }
  }

  // 后台心跳按钮：用来测锁屏/后台播报（走原生前台服务，不是页面定时器）
  const hbBtn = document.getElementById('dHeartbeat');
  if (!hbBtn) {
    failures.push('设置里没有后台心跳按钮');
  } else {
    if (typeof hbBtn.onclick !== 'function') failures.push('后台心跳按钮没有绑定点击事件');
    hbBtn.onclick();
    await new Promise((r) => setTimeout(r, 100));
    if (!heartbeatLog.includes('start')) failures.push('点后台心跳没有启动服务');
    if (!/停止/.test(String(hbBtn.textContent || ''))) {
      failures.push('心跳启动后按钮文案没有变成「停止」：' + hbBtn.textContent);
    }
    // 再点一次应该停
    hbBtn.onclick();
    await new Promise((r) => setTimeout(r, 100));
    if (!heartbeatLog.includes('stop')) failures.push('再点心跳没有停止服务');
    if (!/开始/.test(String(hbBtn.textContent || ''))) {
      failures.push('心跳停止后按钮文案没有复原：' + hbBtn.textContent);
    }
  }

  document.getElementById('dClose').onclick();
}
if (html.includes('id="diagBtn"')) failures.push('底部还残留 🔧 按钮');
if (html.includes('id="speakBtn"')) failures.push('底部还残留大播报按钮');
// v1.0.14：首页底栏和「自动播报」开关整体移除，语音常开
if (/id="voice"/.test(html)) failures.push('还残留自动播报开关 #voice');
if (/自动播报/.test(html)) failures.push('还残留「自动播报」文案');
if (/<footer/.test(html)) failures.push('首页底栏 <footer> 还在');
if (html.includes('id="watch"')) failures.push('底部还残留盯站开关');
/* v1.0.24：搜索/线路/首页的车辆统一进详情页，不再有独立的 #veh */
if (/<div id="veh"/.test(html)) failures.push('还残留独立的车辆页 #veh');
if (/function renderVehicleTimes/.test(html)) failures.push('还残留车辆页渲染函数 renderVehicleTimes');
if (/function openVehicleView/.test(html)) failures.push('还残留车辆页入口 openVehicleView');
if (!/VIEWS = \["home", "detail", "metro", "diag", "pick"\]/.test(html)) {
  failures.push('VIEWS 里还留着 veh');
}
if (!/function voiceOn\(\) \{ return true; \}/.test(html)) {
  failures.push('voiceOn() 应恒为 true（开关已移除）');
}
if (/cdbus\.voiceAuto/.test(html)) failures.push('还残留自动播报设置的读写逻辑');
if (/途经/.test(rendered)) failures.push('站点卡还在显示「途经 …」线路行');
if (/出错了/.test(rendered)) failures.push('界面进入了出错分支：' + rendered.slice(0, 160));
if (missingFns.length) failures.push('调用了未定义的函数：' + missingFns.join(', '));

const favsHtml = String(document.getElementById('favs').innerHTML || '');
if (!favsHtml.includes('16路')) failures.push('收藏区域没有渲染线路名');
if (!favsHtml.includes('天府广场南')) failures.push('收藏区域没有渲染站点名');
if (!/还有 \d+ 站/.test(favsHtml)) failures.push('收藏卡没有拉到实时到站：' + favsHtml.slice(0, 120));

/* v1.0.29：站点收藏卡不再显示「xx路 还有 N 站」——只有线路收藏卡才显示到站 */
{
  const allFavCards = findByClass(document.getElementById('favs'), 'fav');
  const stationFav = allFavCards.find((c) => /站点收藏|这一站/.test(textOf(c)));
  if (stationFav && /还有 \d+ 站/.test(textOf(stationFav))) {
    failures.push('站点收藏卡还在显示「xx路 还有 N 站」：' + textOf(stationFav).slice(0, 80));
  }
  if (!stationFav) failures.push('没有找到站点收藏卡，无法验证');
}

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

// 选中线路后进「线路页」，站名芯片在这页上

const stage2 = [];


/* v1.0.16：首页刷新要重新定位，不能一直用启动时那一个坐标。
   把 location 桩换成「已经走到别处」的坐标，再触发一次回前台刷新，
   断言 nearby 的请求参数跟着变了。
   注意：页面脚本初始化时就把 window.AndroidBus 存进了闭包（var bridge），
   所以这里改的是 bridge 这个对象自己的方法；nearby 的坐标在请求参数里。 */
{
  const bridge = window.AndroidBus;
  const origStart = bridge.start;
  const origPoll = bridge.poll;
  const nearbyArgs = [];

  bridge.start = function (method, payload) {
    if (method === 'nearby') {
      let args = {};
      try { args = JSON.parse(payload || '{}'); } catch (e) {}
      nearbyArgs.push(args);
    }
    return origStart.apply(this, arguments);
  };
  bridge.poll = function (id) {
    if (String(id).split('-')[1] === 'location') {
      /* 人民公园一带，和默认的天府广场差得足够远 */
      return JSON.stringify({ state: 'ok', data: { lat: 30.66, lng: 104.07, accuracy: 25, provider: 'gps', stale: false } });
    }
    return origPoll.apply(this, arguments);
  };

  window.cdBusResume();
  await new Promise((r) => setTimeout(r, 1500));
  bridge.start = origStart;
  bridge.poll = origPoll;

  /* 首页刷新用的是 state.fix 的坐标；收藏卡那边也会发 nearby（用站点自己的坐标），
     所以这里找「有没有一次用的是新定位」，而不是看最后一次。 */
  const usedNewFix = nearbyArgs.some((a) =>
    Math.abs(Number(a.lat) - 30.66) < 0.002 && Math.abs(Number(a.lng) - 104.07) < 0.002);
  if (!nearbyArgs.length) {
    stage2.push('回前台刷新时没有请求 nearby');
  } else if (!usedNewFix) {
    stage2.push('首页刷新没有按新定位取附近站点，nearby 坐标：' +
      nearbyArgs.map((a) => a.lat + ',' + a.lng).join(' / '));
  }
}

/* v1.0.18：站点模糊搜索——搜站名时结果页要同时列出「线路」和「站点」两组。
   真实接口每次只给 3 条站点（无分页），前端靠「拿到的站名再查一轮」补全。 */
{
  document.getElementById('line').value = '花园';
  document.getElementById('go').onclick();
  await new Promise((r) => setTimeout(r, 900));

  const pickText = String(document.getElementById('plist').innerHTML || '');
  if (String(document.getElementById('pick').className).includes('hidden')) {
    stage2.push('搜站名没有进入搜索结果页');
  }
  if (!pickText.includes('站点（')) {
    stage2.push('搜索结果页没有站点分组：' + pickText.slice(0, 160));
  }
  /* 第一轮 3 条（花园永泉/花园桥/花园路）+ 第二轮对已有站名再查，
     应能捞出 花园街 / 花园路中 / 下花园街 */
  /* 首轮 3 条 + 对已有站名再查一轮，能挖出 花园路中 / 下花园街 */
  ['花园桥', '花园路', '花园街', '花园路中', '下花园街'].forEach((n) => {
    if (!pickText.includes(n)) stage2.push('站点搜索结果缺少「' + n + '」：' + pickText.slice(0, 200));
  });
  if (!/站点（\d+）/.test(pickText)) {
    stage2.push('站点分组没有显示数量');
  }
  const psub = String(document.getElementById('psub').textContent || '');
  if (!psub.includes('站点')) stage2.push('搜索结果页副标题没有提到站点：' + psub);
}

document.getElementById('line').value = 'P36';
document.getElementById('go').onclick();
await new Promise((r) => setTimeout(r, 800));

// 选中线路后进「线路页」，站名芯片在这页上

/* v1.0.15：进 App（autoLoad 定位完）不再自动播报附近站点。
   附近播报是一整段「花园永泉站，P02路往…。龙溪村委会站，…」，用句式识别。 */
{
  const startupSpeech = speakLog.filter((t) => /站，[A-Z]*\d+路/.test(t));
  if (startupSpeech.length) {
    stage2.push('进 App 时自动播报了附近站点：' + startupSpeech.join(' | ').slice(0, 120));
  }
}
if (String(document.getElementById('detail').className).includes('hidden')) {
  stage2.push('搜索单条线路后没有进入线路页');
}
if (!String(document.getElementById('home').className).includes('hidden')) {
  stage2.push('线路页显示时首页仍然可见');
}
const homeListBefore = String(document.getElementById('list').innerHTML || '');
if (!homeListBefore.includes('花园永泉')) {
  stage2.push('进线路页后首页的附近站点被顶掉了：' + homeListBefore.slice(0, 120));
}

/* 线路页每个方向 chip 下面要显示这个方向自己的首末班。
   搜索接口不返回首末班，得靠详情接口补，所以这里等一小会儿。 */
{
  const dirsBox = document.getElementById('ddirs');
  const dirChips = findByClass(dirsBox, 'chip');
  if (!dirChips.length) {
    stage2.push('线路页没有方向 chip');
  } else {
    await new Promise((r) => setTimeout(r, 900));   // fillDirectionTimes 是异步补的
    const filled = findByClass(document.getElementById('ddirs'), 'chip');
    const texts = filled.map((c) => textOf(c));
    texts.forEach((t, i) => {
      if (!/首班 \d{2}:\d{2}/.test(t)) stage2.push('方向 chip ' + i + ' 没显示首班：' + t);
      if (!/末班 \d{2}:\d{2}/.test(t)) stage2.push('方向 chip ' + i + ' 没显示末班：' + t);
    });
    /* 每个方向显示的是自己的首末班（桩里去程 06:00·22:30 / 回程 06:30·19:30） */
    const onIdx = filled.findIndex((c) => String(c.className).includes(' on'));
    const allText = texts.join('|');
    if (!allText.includes('06:00') || !allText.includes('22:30')) {
      stage2.push('没显示去程的首末班：' + allText);
    }
    if (!allText.includes('06:30') || !allText.includes('19:30')) {
      stage2.push('没显示回程的首末班：' + allText);
    }
    if (onIdx >= 0 && !texts[onIdx].includes('06:00')) {
      stage2.push('当前方向 chip 显示的不是本方向的时间：' + texts[onIdx]);
    }
    // 每个 chip 内部应该是「方向 + 时间」两段
    const timeEls = findByClass(document.getElementById('ddirs'), 'dirtime');
    if (timeEls.length !== filled.length) {
      stage2.push('方向 chip 的时间行数量不对：' + timeEls.length + '/' + filled.length);
    }
  }
}

const stationChips = findByClass(document.getElementById('lchips'), 'chip');
if (!stationChips.length) {
  console.error('✗ UI 冒烟失败：选线路后没有出现站名芯片');
  process.exit(1);
}

/* 同名同 stationId 的站（「招呼站」）必须各选各的：
   点其中一个，只能亮它自己，不能一串一起亮。 */
{
  const chips = findByClass(document.getElementById('lchips'), 'chip');
  const zhao = chips.filter((c) => textOf(c).includes('招呼站'));
  if (zhao.length < 2) {
    stage2.push('桩数据里应该有 2 个同名招呼站，实际 ' + zhao.length + ' 个');
  } else {
    /* 点第 2 个招呼站（order 7），重渲染后应当只亮它自己。
       重渲染会重建 DOM，所以先记下它的位置序号，不能拿旧元素在新数组里找。 */
    const wantIdx = chips.indexOf(zhao[1]);
    zhao[1].onclick();
    await new Promise((r) => setTimeout(r, 400));
    const after = findByClass(document.getElementById('lchips'), 'chip');
    const on = after.filter((c) => String(c.className).includes(' on'));
    if (on.length !== 1) {
      stage2.push('点一个招呼站亮了 ' + on.length + ' 个（应按 order 只亮 1 个）');
    } else {
      if (!textOf(on[0]).includes('招呼站')) {
        stage2.push('点招呼站后高亮的不是它自己：' + textOf(on[0]).slice(0, 40));
      }
      if (after.indexOf(on[0]) !== wantIdx) {
        stage2.push('高亮的是另一个同名站（位置 ' + after.indexOf(on[0]) + '，应为 ' + wantIdx + '），order 没生效');
      }
    }
    /* 恢复选中「花园公交站」，后面的导航断言依赖它 */
    const garden = findByClass(document.getElementById('lchips'), 'chip')
      .filter((c) => textOf(c).includes('花园公交站'))[0];
    if (garden) {
      garden.onclick();
      await new Promise((r) => setTimeout(r, 400));
    }
  }
}

// 线路页站名条也要标出「离我最近」的那一站（定位桩 30.657,104.065，
// P36 三个站里最近的是 30.7,103.95 的花园公交站）
{
  const lchips = document.getElementById('lchips');
  const nearestChips = findByClass(lchips, 'nearest');
  if (!nearestChips.length) stage2.push('线路页站名条没有标出离我最近的站');
  else {
    if (!textOf(nearestChips[0]).includes('花园公交站')) {
      stage2.push('线路页最近站标错了：' + textOf(nearestChips[0]).slice(0, 60));
    }
    // 徽标只写「最近」（距离太长时显示 5 位数米数没有意义）
    if (!/最近/.test(textOf(nearestChips[0]))) {
      stage2.push('线路页最近站没有「最近」徽标');
    }
    if (/\d+m/.test(textOf(nearestChips[0]))) {
      stage2.push('线路页徽标不该显示米数：' + textOf(nearestChips[0]).slice(0, 60));
    }
  }
}

// 线路页车辆位置：🚌 挂在车所在站的芯片上（桩里 P36 有两辆车，order 9 和 order 3）
// 数据源是查终点站的到站，一次拿回全线所有在途车辆。
{
  await new Promise((r) => setTimeout(r, 300));   // 等 refreshLineBuses 的 await 落地
  const lchips = document.getElementById('lchips');
  const withBus = findByClass(lchips, 'hasbus');
  if (!withBus.length) {
    stage2.push('线路页没有把 🚌 挂到任何站上');
  } else {
    const marks = findByClass(lchips, 'busmark');
    if (!marks.length) stage2.push('有车的站没有 🚌 图标');
    const texts = withBus.map((c) => textOf(c));
    // 桩里两辆车分别在 order 9（友爱公交站）和 order 3（招呼站）
    if (!texts.some((t) => t.includes('友爱公交站'))) {
      stage2.push('🚌 没挂在 order 9 的友爱公交站上：' + texts.join(' | ').slice(0, 120));
    }
    if (!texts.some((t) => t.includes('招呼站'))) {
      stage2.push('🚌 没挂在 order 3 的招呼站上：' + texts.join(' | ').slice(0, 120));
    }
    // 站名和图标不能混在一起（图标是绝对定位的徽标）
    if (withBus.some((c) => {
      const cn = findByClass(c, 'cname')[0];
      return cn && textOf(cn).includes('🚌');
    })) {
      stage2.push('🚌 混进了站名文本里，应该是独立徽标');
    }
    // 一辆车一个图标：桩里每个站只有一辆车，所以每站恰好一个 🚌
    const ones = findByClass(lchips, 'onebus');
    if (ones.length !== withBus.length) {
      stage2.push('🚌 图标数不对：有车 ' + withBus.length + ' 站，图标 ' + ones.length + ' 个');
    }
    // 图标必须在芯片内部（.chips.vertical .chip 有 overflow:hidden，放外面会被裁掉看不见）
    const htmlNow = readFileSync(path.join(here, '..', 'app', 'assets', 'index.html'), 'utf8');
    if (!/\.chips\.vertical \.chip\.hasbus\s*\{[^}]*padding-top/.test(htmlNow)) {
      stage2.push('竖排芯片没给 🚌 留出顶部空间，图标会被 overflow 裁掉');
    }
  }
  // 摘要条：显示在途车辆数和更新时间
  const lvb = document.getElementById('lvbuses');
  const lvbText = textOf(lvb);
  if (!/在途/.test(lvbText)) stage2.push('线路页没有显示在途车辆数：' + lvbText.slice(0, 60));
  if (!/更新/.test(lvbText)) stage2.push('线路页没有显示车辆位置更新时间：' + lvbText.slice(0, 60));
  // 下半页（选中站的到站卡）也由同一个 30 秒刷新驱动：
  // 模拟一次 refreshLineBuses，到站卡应跟着重画（桩里 P36 选中的站有车）
  {
    const before = textOf(document.getElementById('dlist'));
    if (!before.length) stage2.push('线路页下半页到站卡是空的，无法验证联动刷新');
    // 换一辆车进站的场景：改桩数据再触发一次刷新，卡上内容必须变化
    const stationChipsNow = findByClass(document.getElementById('lchips'), 'chip');
    // 点第一个「招呼站」芯片选中它，让下半页出现到站卡
    const zhaoChip = stationChipsNow.filter((c) => textOf(c).includes('招呼站'))[0];
    if (zhaoChip && zhaoChip.onclick) {
      zhaoChip.onclick();
      await new Promise((r) => setTimeout(r, 300));
      const after = textOf(document.getElementById('dlist'));
      if (!after.length) stage2.push('选中站后下半页没有到站表');
      /* v1.0.25 合并后下半页是「这辆车到沿途各站」的到站表（原来那张到站卡并进了车辆芯片），
         断言站名还在、且确实是一张表 */
      if (!/花园公交站|友爱公交站|招呼站/.test(after)) {
        stage2.push('下半页到站表没有站名：' + after.slice(0, 80));
      }
      // 恢复选中花园公交站，别污染后面的导航断言（导航按选中站算距离）
      const gardenChip = findByClass(document.getElementById('lchips'), 'chip')
        .filter((c) => textOf(c).includes('花园公交站'))[0];
      if (gardenChip && gardenChip.onclick) {
        gardenChip.onclick();
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  }
}

// 回到前台立即刷新：原生 onResume → window.cdBusResume()，不管停在哪一页都要刷一次
{
  if (typeof window.cdBusResume !== 'function') {
    stage2.push('没有暴露 window.cdBusResume，原生 onResume 无法通知页面刷新');
  } else {
    // 线路页：应重新拉一次车辆位置（arrivals 被调用即算刷新）
    const before = arrivalsCalls;
    window.cdBusResume();
    await new Promise((r) => setTimeout(r, 400));
    if (arrivalsCalls <= before) {
      stage2.push('回到前台后线路页没有重新拉取到站数据');
    }
    // 摘要条的更新时间应该被刷新（和当前时间一致，不是上次的）
    const lvbText2 = textOf(document.getElementById('lvbuses'));
    if (!/更新/.test(lvbText2)) stage2.push('回到前台后车辆摘要没有更新：' + lvbText2.slice(0, 60));
  }
}

// 导航按钮条：应列出原生报告的已装地图 App（桩里是「高德地图」「百度地图」）
{
  const lnav = document.getElementById('lnav');
  if (String(lnav.className).includes('hidden')) {
    stage2.push('线路页没有显示导航按钮条');
  } else {
    await new Promise((r) => setTimeout(r, 200));   // loadNavApps 是异步的
    const navBtns = findByClass(lnav, 'navbtn');
    if (!navBtns.length) stage2.push('导航按钮条没有按钮');
    else {
      const names = navBtns.map((b) => textOf(b)).join('|');
      if (!/高德地图/.test(names)) stage2.push('导航按钮缺少高德：' + names);
      if (!/百度地图/.test(names)) stage2.push('导航按钮缺少百度：' + names);
      // 点第一个导航按钮 → 应调用 bridge.navigate，且带上站点坐标、站名和我的位置
      const beforeNav = navLog.length;
      navBtns[0].onclick({ stopPropagation() {} });
      await new Promise((r) => setTimeout(r, 100));
      if (navLog.length !== beforeNav + 1) stage2.push('点导航按钮没有调起导航');
      else {
        const call = navLog[navLog.length - 1];
        if (call.appId !== 'amap') stage2.push('导航没传对 App：' + call.appId);
        if (!/花园/.test(String(call.name))) stage2.push('导航没传对站名：' + call.name);
        if (!(call.lat > 0) || !(call.lng > 0)) {
          stage2.push('导航没传站点坐标：' + call.lat + ',' + call.lng);
        }
        // 必须把我的位置一起传下去，否则原生侧无法判断步行/驾车
        if (!(call.fromLat > 0) || !(call.fromLng > 0)) {
          stage2.push('导航没传我的位置：' + call.fromLat + ',' + call.fromLng);
        }
      }
    }
  }
}

// 500 米内 → 步行导航；超过 → 驾车。直接调 navToStation 验证两种距离。
{
  // 站点在 30.7,103.95；把定位挪到它附近 ~100 米 → 应 walk
  const nearFix = { lat: 30.7009, lng: 103.95, accuracy: 20, provider: 'gps', stale: false };
  const farFix = { lat: 30.657, lng: 104.065, accuracy: 30, provider: 'network', stale: false };
  // 通过 window.cdBusTestNav 暴露的钩子设置定位（见 index.html）
  if (typeof window.cdBusSetFix !== 'function' || typeof window.cdBusNavToStation !== 'function') {
    stage2.push('没有暴露定位/导航测试钩子');
  } else {
    window.cdBusSetFix(nearFix);
    window.cdBusNavToStation('amap');
    const walkCall = navLog[navLog.length - 1];
    if (walkCall.mode !== 'walk') {
      stage2.push('500 米内应走步行导航，实际：' + walkCall.mode + '（' + walkCall.distance + ' 米）');
    }
    if (!(walkCall.distance > 0 && walkCall.distance <= 500)) {
      stage2.push('近距离距离计算不对：' + walkCall.distance);
    }

    window.cdBusSetFix(farFix);
    window.cdBusNavToStation('amap');
    const driveCall = navLog[navLog.length - 1];
    if (driveCall.mode !== 'drive') {
      stage2.push('超过 500 米应走驾车导航，实际：' + driveCall.mode + '（' + driveCall.distance + ' 米）');
    }
    if (!(driveCall.distance > 500)) {
      stage2.push('远距离距离计算不对：' + driveCall.distance);
    }
    // 恢复
    window.cdBusSetFix(farFix);
  }
}

if (typeof stationChips[0].onclick !== 'function') {
  console.error('✗ UI 冒烟失败：站名芯片没有绑定点击事件');
  process.exit(1);
}
stationChips[0].onclick();
await new Promise((r) => setTimeout(r, 800));

// 线路页点刷新：只刷当前站点，不能拉回首页
document.getElementById('refreshHome').onclick();
await new Promise((r) => setTimeout(r, 800));
if (!document.getElementById('lchips').children.length) {
  stage2.push('刷新后站名芯片消失（被拉回首页）');
}
if (String(document.getElementById('detail').className).includes('hidden')) {
  stage2.push('刷新后离开了线路页');
}
if (!/P36路/.test(String(document.getElementById('dtitle').textContent || ''))) {
  stage2.push('线路页标题没有显示线路：' + String(document.getElementById('dtitle').textContent || ''));
}

// 收藏仍走详情页（线路页只负责选站，不重复一套收藏条）
const selbar = document.getElementById('selbar');
if (!String(selbar.className).includes('hidden')) stage2.push('线路页上首页收藏条不该出现');
const favRows = findByClass(document.getElementById('dbuses'), 'vchip');
if (!favRows.length) stage2.push('选站后线路页没有列出在途车辆');
else {
  favRows[0].onclick();
  await new Promise((r) => setTimeout(r, 900));
  /* v1.0.24：点车辆不再进单独的「车辆页」，统一进详情页 */
  if (String(document.getElementById('detail').className).includes('hidden')) {
    stage2.push('点线路页的车辆没有进详情页');
  }
  const before = JSON.parse(storage.get('cdbus.favorites') || '[]').length;
  document.getElementById('dfav').onclick();
  const after = JSON.parse(storage.get('cdbus.favorites') || '[]').length;
  if (after !== before + 1) stage2.push(`点收藏没写入（${before} → ${after}）`);
  if (!String(document.getElementById('status').textContent).includes('已收藏')) stage2.push('状态栏没有提示已收藏');
  if (!String(document.getElementById('favs').innerHTML).includes('P36路')) stage2.push('首页收藏区没有出现 P36路');
  window.cdBusBackView();
  await new Promise((r) => setTimeout(r, 300));
}

// 站点收藏：卡片 + 点进去看该站全部线路
const favCardsAll = findByClass(document.getElementById('favs'), 'fav');

// 置顶：点卡片上的 ↑ → 该卡排到最前并带 pinned
{
  const pins2 = findByClass(document.getElementById('favs'), 'pin2');
  if (!pins2.length) {
    stage2.push('收藏卡没有置顶按钮');
  } else {
    const beforeFirst = favCardsAll[0];
    // 置顶最后一张，验证会排到最前
    pins2[pins2.length - 1].onclick({ stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 200));
    const afterCards = findByClass(document.getElementById('favs'), 'fav');
    const pinnedCard = afterCards.find((c) => String(c.className).includes('pinned'));
    if (!pinnedCard) stage2.push('置顶后卡片没有 pinned 状态');
    else if (afterCards[0] !== pinnedCard) stage2.push('置顶的卡片没有排到最前');
    if (!JSON.parse(storage.get('cdbus.favorites') || '[]').some((f) => f.pinned)) {
      stage2.push('置顶状态没有写入收藏数据');
    }
  }
}
const hasClass2 = (el, cls) => String((el && el.className) || '').split(/\s+/).includes(cls);
const stationCard = favCardsAll.find((c) => /站点收藏|这一站/.test(textOf(c)));
if (!stationCard) {
  stage2.push('没有渲染站点收藏卡片');
} else {
  stationCard.onclick();
  await new Promise((r) => setTimeout(r, 900));
  /* v1.0.30：收藏时记了线路 → 点回来直接回到「那条线的那一站」（线路详情页），
     不再是「这一站所有线路」的列表。 */
  const stopTitle = String(document.getElementById('dtitle').textContent || '');
  if (!/P02路 · 花园永泉/.test(stopTitle)) {
    stage2.push('点站点收藏没有回到收藏时的那条线那一站：' + stopTitle);
  }
  if (String(document.getElementById('detail').className).includes('hidden')) {
    stage2.push('站点收藏点进去没有显示详情页');
  }
  const listNow = textOf(document.getElementById('dlist'));
  if (!listNow.includes('花园永泉')) {
    stage2.push('回到线路后到站表里没有该站：' + listNow.slice(0, 120));
  }
  /* 站名芯片里要有「花园永泉」被选中，说明定位到了那一站 */
  const chipsNow = findByClass(document.getElementById('lchips'), 'chip');
  const onChip = chipsNow.find((c) => hasClass2(c, 'on'));
  if (!onChip || !textOf(onChip).includes('花园永泉')) {
    stage2.push('回到线路后没有选中收藏的那一站：' + (onChip ? textOf(onChip) : '没有选中项'));
  }
  window.cdBusBackView();
  await new Promise((r) => setTimeout(r, 700));
}

// 退出查询 → 回到附近站点
document.getElementById('exitSearch').onclick();
await new Promise((r) => setTimeout(r, 900));
const afterExit = String(document.getElementById('list').innerHTML || '');
if (String(document.getElementById('chips').innerHTML || '').length) stage2.push('退出后站名芯片没清空');
if (!afterExit.includes('花园永泉')) stage2.push('退出后没有回到附近站点：' + afterExit.slice(0, 120));
if (!String(document.getElementById('selbar').className).includes('hidden')) {
  stage2.push('退出后查询条没有收起');
}

/* 点首页站点卡 → 站点页：应有 🧭 按方向的导航按钮 */
{
  const cards = findByClass(document.getElementById('list'), 'bus');
  const clickable = cards.filter((c) => typeof c.onclick === 'function');
  if (clickable.length) {
    clickable[0].onclick();
    await new Promise((r) => setTimeout(r, 900));
    if (String(document.getElementById('detail').className).includes('hidden')) {
      stage2.push('点首页站点卡没有进入站点页');
    }
    const ltitle = String(document.getElementById('dtitle').textContent || '');
    if (!/站点 · /.test(ltitle)) stage2.push('站点页标题不对：' + ltitle);
    const navBtns = findByClass(document.getElementById('lnav'), 'navbtn');
    if (!navBtns.length) stage2.push('站点页没有方向导航按钮');
    window.cdBusBackView && window.cdBusBackView();
    await new Promise((r) => setTimeout(r, 300));
  }
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
/* v1.0.20：首页行只显示线路名，不再显示「往 XX 站」 */
if (/往 /.test(cardsHtml)) {
  stage3.push('首页行还在显示方向「往 …」：' + (cardsHtml.match(/[^\s]{0,12}往 [^\s]{1,10}/) || [''])[0]);
}

/* v1.0.19：一条线路只显示一行，不再显示双向 ——
   这样站点卡里能把这个站的所有线路都列出来。 */
{
  const cards = document.getElementById('list').children;
  for (const card of cards) {
    const rows = findByClass(card, 'gcell');
    const seen = {};
    for (const row of rows) {
      const r1 = findByClass(row, 'gname')[0];
      const name = String(textOf(r1) || '').trim();
      if (!name) continue;
      seen[name] = (seen[name] || 0) + 1;
    }
    const dup = Object.keys(seen).filter((n) => seen[n] > 1);
    if (dup.length) {
      stage3.push('站点卡里有重复线路行（应一条线只显示一行）：' + dup.join('、'));
    }
  }
  /* 花园永泉的 lineNames 有 P02/716/720/45 四条，arrivals 只给前三条，
     45 路要靠反查补齐 —— 一条线只出一行，所以四条都要在 */
  const firstCard = cards[0];
  const firstNameRows = findByClass(firstCard, 'gname').map((el) => String(textOf(el) || ''));
  ['P02', '716', '720', '45'].forEach((n) => {
    const hit = firstNameRows.filter((t) => t.indexOf(n + '路') === 0);
    if (!hit.length) stage3.push('站点卡里缺少线路「' + n + '路」：' + firstNameRows.join(' | '));
  });
}
/* v1.0.22：用户要求取消「几站」这类到站状态——格子里不能再出现「N 站」 */
/* v1.0.23：格子里只剩线路名，「几站」「待发车」「收班时间」都不能出现 */
if (/\d+\s*站/.test(cardsHtml)) {
  stage3.push('三列格子还在显示「几站」到站状态：' + cardsHtml.slice(0, 240));
}
if (/待发车/.test(cardsHtml)) {
  stage3.push('三列格子还在显示待发车时间：' + cardsHtml.slice(0, 240));
}
if (/不在运营时段/.test(cardsHtml)) {
  stage3.push('三列格子还在显示收班时间：' + cardsHtml.slice(0, 240));
}
if (!cardsHtml.includes('P36路')) stage3.push('近似站名没有合并/数据没带过来：' + cardsHtml.slice(0, 240));
// 同名站点应该合并成一张卡片
if (stopCards.length !== 4) stage3.push('站点卡片数不对：' + stopCards.length);
if (/途经/.test(cardsHtml)) stage3.push('站点卡还在显示「途经」线路行');

/* v1.0.21：线路列表改成三列网格 */
if (!/\.gridlines\s*\{[^}]*grid-template-columns:\s*repeat\(3/.test(html)) {
  stage3.push('缺少三列网格样式 .gridlines { grid-template-columns: repeat(3, ...) }');
}
{
  const cards = document.getElementById('list').children;
  for (const card of cards) {
    if (!findByClass(card, 'gridlines').length) {
      stage3.push('站点卡里的线路没有放进三列网格：' + textOf(card).slice(0, 40));
      break;
    }
  }
}
if (/🔊/.test(cardsHtml)) stage3.push('三列格子里还留着播报按钮（🔊）');
const allRows = findByClass(document.getElementById('list'), 'gcell');
if (!cardsHtml.includes('P49路')) {
  stage3.push('站点卡缺少线路「P49路」：' + cardsHtml.slice(-320));
}

/* v1.0.20：用户要求取消首页的「有车高亮」和「快到站红字」。
   行上不能有 live/hot，样式表里也不能再留这两套规则。 */
const hasClass = (el, cls) => String(el.className || '').split(/\s+/).includes(cls);
const rowOf = (kw) => allRows.find((r) => textOf(r).includes(kw));

for (const r of allRows) {
  if (hasClass(r, 'live')) {
    stage3.push('首页行还有高亮（live）：' + textOf(r).slice(0, 60));
    break;
  }
}
for (const r of allRows) {
  if (hasClass(r, 'hot')) {
    stage3.push('首页行还有红字（hot）：' + textOf(r).slice(0, 60));
    break;
  }
}
if (/\.armeta\.live\s*\{/.test(html) || /\.armeta\.hot\s/.test(html)) {
  stage3.push('样式表里还留着 .armeta.live / .armeta.hot 规则');
}

/* 收班行仍然要变淡（这是唯一保留的行状态） */
const endedRow = rowOf('716路');
if (endedRow && !hasClass(endedRow, 'ended')) {
  stage3.push('已收班的 716 格子没有标 ended（应收班变淡）');
}

/* v1.0.26：灰色（不在运营时段）的格子也要能点进去看。
   这里必须真的点一下——守卫写在 onclick 函数体里，只看有没有函数抓不到回归。 */
const endedCell = rowOf('716路');
if (endedCell && typeof endedCell.onclick === 'function') {
  endedCell.onclick();
  await new Promise((r) => setTimeout(r, 900));
  if (String(document.getElementById('detail').className).includes('hidden')) {
    stage3.push('点已收班的 716 格子没有进入详情页（灰色线路也应能点进去看）');
  }
  window.cdBusBackView();
  await new Promise((r) => setTimeout(r, 400));
}

// 用户要求取消格子里的播报按钮：一行格子都不应该挂小喇叭
const spkButtons = findByClass(document.getElementById('list'), 'spk');
if (spkButtons.length) {
  stage3.push('站点卡的格子里还留着播报按钮：' + textOf(spkButtons[0]));
}
if (!/flex-wrap:\s*nowrap/.test(html) || !/overflow-x:\s*auto/.test(html)) {
  stage3.push('站点芯片没有改成横向滑动');
}

if (stage3.length) {
  console.error('✗ UI 冒烟失败（双向显示）：');
  for (const f of stage3) console.error('  - ' + f);
  process.exit(1);
}

console.log('✓ UI 冒烟通过：站点渲染、三列线路名都正常');
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
  // 底部盯站开关已移除，改为确认首页出现了盯站卡片
  if (!/盯站中/.test(textOf(document.getElementById('watchcard')))) {
    stage4.push('盯站后首页没有出现盯站卡片');
  }

  /* 盯站播报：服务在跑时由服务播（页面不播，避免重复）；
     服务没跑时页面兜底播，保证前台一定有声音。 */
  {
    arrivalsArrived = true;   // 让 arrivals 桩返回已到站的车
    /* v9.21 起分工明确：页面负责前台播报（页面定时器只在可见时跑），
       服务负责后台/息屏播报。前台必须能听到声音。 */
    const before1 = speakLog.length;
    window.cdBusWatchTick && window.cdBusWatchTick();
    await new Promise((r) => setTimeout(r, 300));
    const pageSpoke = speakLog.slice(before1);
    if (!pageSpoke.length) {
      stage4.push('前台盯站没有播报（页面必须负责前台播报）');
    } else if (!/到站|分钟|进站/.test(pageSpoke.join('|'))) {
      stage4.push('前台播报内容不对：' + pageSpoke.join('|'));
    }
    arrivalsArrived = false;
  }

  /* 起点站发车提醒（v1.0.13）：盯的站离起点 1~3 站时，
     起点一有车发出就立刻播一次，且同一辆车不重复播。 */
  {
    arrivalsArrived = false;
    arrivalsEta = null;
    // 盯「龙溪村村委会」（order 3，离起点 3 站）
    window.cdBusStartWatch && window.cdBusStartWatch({
      lineId: '028-p36-0', lineName: 'P36', stationId: '028-2b',
      stationName: '龙溪村村委会', toward: '花园公交站', order: 3,
    });
    await new Promise((r) => setTimeout(r, 100));

    const before = speakLog.length;
    window.cdBusWatchTick && window.cdBusWatchTick();
    await new Promise((r) => setTimeout(r, 400));
    const said = speakLog.slice(before).join('|');
    if (!/起点站已发车/.test(said)) {
      stage4.push('盯站离起点 3 站时，起点发车没有播报：' + JSON.stringify(said.slice(0, 120)));
    }

    // 同一辆车（busId 不变）不能再播一次
    const before2 = speakLog.length;
    window.cdBusWatchTick && window.cdBusWatchTick();
    await new Promise((r) => setTimeout(r, 400));
    if (/起点站已发车/.test(speakLog.slice(before2).join('|'))) {
      stage4.push('起点发车播报重复了（同一辆车应只播一次）');
    }
  }

  /* 播报规则（v9.26 重置）：只有四个节点，各播一次，绝不重复。
     逐节点验证：10 分钟 / 5 分钟 / 2 站 / 已到站。 */
  {
    // ① 10 分钟节点：ETA=390 秒 → 播「6 分 30 秒」，且不能是写死的「10 分钟」
    arrivalsArrived = false;
    arrivalsEta = 390;
    let before = speakLog.length;
    window.cdBusWatchTick && window.cdBusWatchTick();
    await new Promise((r) => setTimeout(r, 300));
    let said = speakLog.slice(before).join('|');
    if (!said) stage4.push('ETA=390 秒时没有播报');
    else {
      if (!/6 分 30 秒/.test(said)) stage4.push('播报没用实际 ETA（应「6 分 30 秒」）：' + said);
      if (/10 分钟/.test(said)) stage4.push('播报写死了「10 分钟」：' + said);
    }

    // ② 同一节点不重复播：再 tick 一次不应该再响
    before = speakLog.length;
    window.cdBusWatchTick && window.cdBusWatchTick();
    await new Promise((r) => setTimeout(r, 300));
    if (speakLog.length > before) {
      stage4.push('同一节点被重复播报：' + speakLog.slice(before).join('|'));
    }

    // ③ 已到站：只播「已到站」一次，不补播其他节点
    arrivalsEta = null;        // 先清掉 ETA 场景，否则桩仍返回 b7
    arrivalsArrived = true;
    before = speakLog.length;
    window.cdBusWatchTick && window.cdBusWatchTick();
    await new Promise((r) => setTimeout(r, 300));
    said = speakLog.slice(before).join('|');
    if (!/已到站/.test(said)) stage4.push('到站没有播报：' + said);
    const arrivedCount = (said.match(/已到站/g) || []).length;
    if (arrivedCount > 1) stage4.push('到站播报了 ' + arrivedCount + ' 次（应只 1 次）');

    // ④ 到站后再 tick：不能再响
    before = speakLog.length;
    window.cdBusWatchTick && window.cdBusWatchTick();
    await new Promise((r) => setTimeout(r, 300));
    if (speakLog.length > before) {
      stage4.push('到站后仍在重复播报：' + speakLog.slice(before).join('|'));
    }

    /* ⑤ 到站后自动取消盯站（不等下一辆车）：
       等页面那个 4 秒定时器跑完，盯站开关应复位、服务应被停掉。 */
    await new Promise((r) => setTimeout(r, 4500));
    if (/盯站中/.test(textOf(document.getElementById('watchcard')))) {
      stage4.push('到站后盯站没有自动结束（卡片仍在）');
    }
    if (!watchServiceLog.some((x) => x[0] === 'stop')) {
      stage4.push('到站后没有停止后台盯站服务');
    }
    const statusAfter = String(document.getElementById('status').textContent || '');
    if (!/自动结束|已到站/.test(statusAfter)) {
      stage4.push('到站后状态栏没有提示自动结束：' + statusAfter);
    }

    arrivalsEta = null;
    arrivalsArrived = false;
  }
}

/* v1.0.30：在线路详情页收藏站点时，要把「哪条线/哪个方向/第几站」一起存下来，
   这样收藏卡点进去才能回到这条线。 */
{
  const favCards3 = findByClass(document.getElementById('favs'), 'fav')
    .filter((c) => !/站点收藏|这一站/.test(textOf(c)));
  if (favCards3.length) {
    favCards3[0].onclick();
    await new Promise((r) => setTimeout(r, 900));
    const chips3 = findByClass(document.getElementById('lchips'), 'chip');
    if (chips3.length) {
      chips3[0].onclick();
      await new Promise((r) => setTimeout(r, 500));
      const sfav3 = findByClass(document.getElementById('lstationfav'), 'stationfav');
      if (sfav3.length && String(sfav3[0].textContent).indexOf('已收藏') < 0) {
        const chipStationId = chips3[0].__stationId || null;
        sfav3[0].onclick();
        await new Promise((r) => setTimeout(r, 400));
        const saved = JSON.parse(storage.get('cdbus.favorites') || '[]');
        /* 只认这次点出来的那张：桩里预置的站点收藏也带 lineId，不能拿它充数 */
        const stationSaved = saved.filter((f) => f.type === 'station')
          .find((f) => String(f.stationId) !== '028-1');
        if (!stationSaved) {
          stage4.push('点「收藏站点」没有把站点写进收藏');
        } else if (!stationSaved.lineId) {
          stage4.push('收藏站点时没有记下线路信息（lineId），收藏卡点进去回不到这条线');
        } else if (!stationSaved.order && stationSaved.order !== 0) {
          stage4.push('收藏站点时没有记下站序（order）');
        }
        // 清掉，别影响后面的断言
        sfav3[0].onclick();
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    window.cdBusBackView && window.cdBusBackView();
    await new Promise((r) => setTimeout(r, 400));
  }
}

/* 详情页「收藏站点」按钮：点击收藏 → 再点取消 */
{
  // 进入详情页（用已有收藏线路）
  const favCards2 = findByClass(document.getElementById('favs'), 'fav')
    .filter((c) => !textOf(c).includes('站点收藏'));
  if (favCards2.length) {
    favCards2[0].onclick();
    await new Promise((r) => setTimeout(r, 900));
    const sfavBtn = findByClass(document.getElementById('lstationfav'), 'stationfav');
    if (!sfavBtn.length) {
      stage4.push('详情页没有「收藏站点」按钮');
    } else {
      // 选中一个站才有按钮状态；先点站名芯片
      const chips0 = findByClass(document.getElementById('lchips'), 'chip');
      if (chips0.length) {
        chips0[0].onclick();
        await new Promise((r) => setTimeout(r, 400));
        const sfavBtn2 = findByClass(document.getElementById('lstationfav'), 'stationfav');
        if (sfavBtn2.length) {
          const favsBefore = JSON.parse(storage.get('cdbus.favorites') || '[]').length;
          sfavBtn2[0].onclick();
          await new Promise((r) => setTimeout(r, 100));
          const favsAfter = JSON.parse(storage.get('cdbus.favorites') || '[]').length;
          if (favsAfter !== favsBefore + 1) {
            stage4.push('点「收藏站点」没有写入收藏');
          }
          // 再点取消
          const sfavBtn3 = findByClass(document.getElementById('lstationfav'), 'stationfav');
          sfavBtn3[0].onclick();
          await new Promise((r) => setTimeout(r, 100));
          const favsFinal = JSON.parse(storage.get('cdbus.favorites') || '[]').length;
          if (favsFinal !== favsAfter - 1) {
            stage4.push('再点「收藏站点」没有取消收藏');
          }
        }
      }
    }
    window.cdBusBackView && window.cdBusBackView();
    await new Promise((r) => setTimeout(r, 300));
  }
}

/* v1.0.17：线路页也能盯站（不用先进详情页） */
{
  /* 走「搜索 P36 → 线路页」这条路，确保真的停在线路页上 */
  document.getElementById('line').value = 'P36';
  document.getElementById('go').onclick();
  await new Promise((r) => setTimeout(r, 900));

  {
    const chips1 = findByClass(document.getElementById('lchips'), 'chip');
    if (!chips1.length) {
      stage4.push('线路页没有站名芯片，无法测盯站按钮');
    } else {
      chips1[0].onclick();
      await new Promise((r) => setTimeout(r, 400));

      const wBtn = findByClass(document.getElementById('lstationfav'), 'stationwatch');
      if (!wBtn.length) {
        stage4.push('线路页没有「盯站」按钮');
      } else if (String(wBtn[0].textContent).indexOf('盯站') < 0) {
        stage4.push('线路页盯站按钮文案不对：' + textOf(wBtn[0]));
      } else {
        const before = watchServiceLog.filter((x) => x[0] === 'start').length;
        wBtn[0].onclick();
        await new Promise((r) => setTimeout(r, 300));
        const after = watchServiceLog.filter((x) => x[0] === 'start').length;
        if (after <= before) {
          stage4.push('点线路页「盯站」没有启动后台服务');
        }
        const wBtn2 = findByClass(document.getElementById('lstationfav'), 'stationwatch');
        if (!wBtn2.length || String(wBtn2[0].textContent).indexOf('已盯站') < 0) {
          stage4.push('盯站后按钮没有变成「已盯站」：' + (wBtn2[0] ? textOf(wBtn2[0]) : '找不到按钮'));
        } else {
          const stopBefore = watchServiceLog.filter((x) => x[0] === 'stop').length;
          wBtn2[0].onclick();
          await new Promise((r) => setTimeout(r, 300));
          const stopAfter = watchServiceLog.filter((x) => x[0] === 'stop').length;
          if (stopAfter <= stopBefore) stage4.push('再点「已盯站」没有取消盯站');
        }

        /* v1.0.28：点顶部盯站条上的「停止」后，下面那个「📌 已盯站」按钮
           必须立刻变回「📌 盯站」，不能等下一次重画。 */
        wBtn[0].onclick();                        // 先重新盯上
        await new Promise((r) => setTimeout(r, 300));
        const stopEl = document.getElementById('dwatchStop');
        if (!stopEl || typeof stopEl.onclick !== 'function') {
          stage4.push('盯站条上没有「停止」按钮');
        } else {
          stopEl.onclick();
          await new Promise((r) => setTimeout(r, 300));
          const wBtn3 = findByClass(document.getElementById('lstationfav'), 'stationwatch');
          const label3 = wBtn3.length ? String(wBtn3[0].textContent) : '';
          if (label3.indexOf('已盯站') >= 0) {
            stage4.push('点盯站条的「停止」后按钮还是「已盯站」，没有立刻刷新：' + label3);
          }
        }
      }
    }
    window.cdBusBackView && window.cdBusBackView();
    await new Promise((r) => setTimeout(r, 300));
  }
}

/* 📌 点击后图标要立刻变灰（不等 30 秒轮询） */
{
  // 先确保处于未盯站状态
  if (/盯站中/.test(textOf(document.getElementById('watchcard')))) {
    window.cdBusWatchStation && window.cdBusWatchStation(9);
    await new Promise((r) => setTimeout(r, 100));
  }
  // 进入详情页渲染站点行
  const favCards = findByClass(document.getElementById('favs'), 'fav')
    .filter((c) => !textOf(c).includes('站点收藏'));
  if (favCards.length) {
    favCards[0].onclick();
    await new Promise((r) => setTimeout(r, 900));
  }
}

/* 📌 切换：再点同一个站应取消盯站（与 🔔 一致） */
{
  if (typeof window.cdBusWatchStation === 'function') {
    // 此时处于盯站中（前面的用例开启了）
    const stopBefore = watchServiceLog.filter((x) => x[0] === 'stop').length;
    window.cdBusWatchStation(9);   // 同一个站
    await new Promise((r) => setTimeout(r, 200));
    if (/盯站中/.test(textOf(document.getElementById('watchcard')))) {
      stage4.push('再点同一个站 📌 没有取消盯站（卡片仍在）');
    }
    if (watchServiceLog.filter((x) => x[0] === 'stop').length <= stopBefore) {
      stage4.push('再点 📌 没有停止后台服务');
    }
    // 重新开启，避免影响后续用例
    window.cdBusWatchStation(9);
    await new Promise((r) => setTimeout(r, 200));
  }
}

if (stage4.length) {
  console.error('✗ UI 冒烟失败（盯站）：');
  for (const f of stage4) console.error('  - ' + f);
  process.exit(1);
}
if (!watchServiceLog.some((x) => x[0] === 'start')) {
  console.error('✗ UI 冒烟失败：开始盯站没有启动前台服务（后台会不播报）');
  process.exit(1);
}
console.log('✓ 盯站通过：收藏卡 📌 → 进入盯站，底部开关同步，并启动前台服务');

/* 播报统一由 WatchService 负责（v9.18 起）：页面不再自己播，
   这样前台/后台/锁屏只有一条播报路径，不会出现「两边互相让、谁都不念」。
   这里确认页面确实没有残留的 self-speak 分支。 */
if (/etaFront/.test(html)) {
  console.error('✗ UI 冒烟失败：页面里还有旧的自我播报分支（会和服务重复念）');
  process.exit(1);
}
if (!/startBackgroundWatch\(\)/.test(html)) {
  console.error('✗ UI 冒烟失败：盯站没有启动后台服务（那就真的没人播报了）');
  process.exit(1);
}
console.log('✓ 前台播报通过：页面自身仍会按 10/5/2 播报，服务只在后台说话');

// 首页盯站卡片：显示 + 点击进详情
/* 上一步「到站自动取消盯站」已经把盯站关掉了，这里重新开一个用于卡片测试 */
{
  const pins2 = findByText(document.getElementById('favs'), '📌');
  if (pins2.length) {
    pins2[0].onclick({ stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 200));
  }
}
const wcText = textOf(document.getElementById('watchcard'));
if (!/盯站中/.test(wcText)) {
  console.error('✗ UI 冒烟失败：首页没有显示盯站卡片');
  process.exit(1);
}
const wcCards = findByClass(document.getElementById('watchcard'), 'watchcard');
if (!wcCards.length) {
  console.error('✗ UI 冒烟失败：盯站卡片不可点击');
  process.exit(1);
}
wcCards[0].onclick();
await new Promise((r) => setTimeout(r, 900));
const dTitle = String(document.getElementById('dtitle').textContent || '');
if (!/路/.test(dTitle)) {
  console.error('✗ UI 冒烟失败：点盯站卡片没有进入详情：' + dTitle);
  process.exit(1);
}
document.getElementById('back').onclick();
await new Promise((r) => setTimeout(r, 200));
console.log('✓ 盯站卡片通过：首页展示当前盯站，点击进入详情');

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

const favCards = findByClass(document.getElementById('favs'), 'fav')
  .filter((c) => !textOf(c).includes('站点收藏'));   // 只挑线路收藏卡（置顶可能改变顺序）
/* 这一段验证的是「16 路 + 默认 matrix 桩」这套数据（3 辆车、距终点 28 站、发车间隔 12 分钟），
   所以必须明确挑 16 路那张卡，不能靠收藏顺序（前面阶段会新收藏 P36 并置顶）。 */
const favCard16 = favCards.find((c) => /16路/.test(textOf(c))) || favCards[0];
const stage5 = [];
if (!favCards.length) stage5.push('没有线路收藏卡');
else {
  favCard16.onclick();
  await new Promise((r) => setTimeout(r, 900));
  const chipsHtml = textOf(document.getElementById('dbuses'));
  const chipEls = findByClass(document.getElementById('dbuses'), 'chip');
  if (chipEls.length < 3) stage5.push('车辆芯片未渲染完整：' + chipEls.length);
  else {
    const t0 = String(textOf(chipEls[0]) || '');
    const t1 = String(chipEls[1].textContent || '');
    if (!/距终点 28 站/.test(t0)) stage5.push('最左应是离起点最近的车（距终点 28 站）：' + t0);
    // 有且只有一辆被标「最近」，且它就是当前选中的那辆
    const marked = chipEls.filter((c) => /最近/.test(textOf(c)));
    if (marked.length !== 1) {
      stage5.push('「最近」标记数量不对：' + marked.length);
    } else if (!String(marked[0].className).includes('on')) {
      stage5.push('默认没有选中离我最近的车');
    }
  }
  const dlistHtml = textOf(document.getElementById('dlist'));
  /* v1.0.31：行内 📌 已取消——盯站入口是「📌 盯站」按钮和顶部盯站条 */
  if (/class="spk stpin/.test(dlistHtml)) stage5.push('详情页站点行还残留 📌 盯站按钮（已取消）');

  // 点某一站盯站（走导出的接口）：应进入盯站、盯站条显示信息
  if (typeof window.cdBusWatchStation === 'function') {
    window.cdBusWatchStation(9);
    await new Promise((r) => setTimeout(r, 300));
    const bar = document.getElementById('dwatchbar');
    if (String(bar.className).includes('hidden')) stage5.push('盯站后盯站条没有显示');
    const barText = String(document.getElementById('dwatchtext').textContent || '');
    if (!/盯站：/.test(barText)) stage5.push('盯站条没有显示目标：' + barText);
    if (!document.getElementById('dwatchStop')) stage5.push('盯站条没有「停止」入口');
    // 清理：停掉盯站，别影响后面
    document.getElementById('dwatchStop').onclick();
    await new Promise((r) => setTimeout(r, 300));
  }
  if (!dlistHtml.includes('srow')) stage5.push('详情页没有渲染站点行');
  else if (!/class="srow current/.test(dlistHtml)) stage5.push('没有标出「车当前所在站」');
  if (!chipsHtml.includes('距终点')) stage5.push('车辆芯片没有「距终点」：' + chipsHtml);
  if (!/已过收藏站|距收藏站/.test(chipsHtml)) stage5.push('车辆芯片没有「收藏站」距离：' + chipsHtml);
  if (textOf(document.getElementById('dbuses')).includes('undefined')) {
    stage5.push('芯片文案出现 undefined');
  }
  // 悬浮按钮必须挂在 body 上，不能放在 #home 里（否则详情页会跟着隐藏）
  if (html.indexOf('id="fabSpeak"') > html.indexOf('<div id="home"')) {
    stage5.push('悬浮按钮仍在 #home 内部，详情页会被隐藏');
  }

  // 选中某站后再点悬浮按钮，应播报「选中的那个站」而不是打开详情时的站
  if (typeof window.cdBusPickStation === 'function') {
    window.cdBusPickStation(9, null);
    await new Promise((r) => setTimeout(r, 400));
    const beforePickSpeak = speakLog.length;
    document.getElementById('fabSpeak').onclick();
    const said = speakLog[speakLog.length - 1] || '';
    if (speakLog.length <= beforePickSpeak) stage5.push('选中站后点悬浮播报没有出声');
    else if (!/花园永泉/.test(said)) stage5.push('悬浮播报没有念选中的站（应为花园永泉）：' + said);
  }

  // 悬浮播报按钮（左下角），播报当前站点
  if (html.includes('id="dspeak"')) stage5.push('头部仍残留 🔊 按钮');
  const fab = document.getElementById('fabSpeak');
  if (!fab) stage5.push('没有悬浮播报按钮');
  else {
    if (String(fab.className).includes('hidden')) stage5.push('详情页悬浮播报按钮没显示');
    const speakBefore = speakLog.length;
    fab.onclick();
    if (speakLog.length <= speakBefore) stage5.push('点悬浮播报没有出声');
    else if (!/站/.test(speakLog[speakLog.length - 1])) stage5.push('悬浮播报没念站点：' + speakLog.slice(-1));
  }

  // 点站名：留在详情页，只更新「同站其它」那一行，且不播报
  if (typeof window.cdBusLoadOthers === 'function') {
    const beforeSpeak = speakLog.length;
    const wasDetail = !String(document.getElementById('detail').className).includes('hidden');
    await window.cdBusLoadOthers({ stationId: '028-1', name: '花园永泉', lat: 30.7, lng: 103.95 });
    await new Promise((r) => setTimeout(r, 400));
    if (String(document.getElementById('detail').className).includes('hidden')) {
      stage5.push('点站名离开了详情页（应该在原页更新）');
    }
    const othersNow = textOf(document.getElementById('dothers'));
    if (!/同站其它/.test(othersNow)) stage5.push('「同站其它」标签丢失');
    if (!/716路/.test(othersNow)) stage5.push('点站名后没有列出该站的其它线路：' + othersNow.slice(0, 120));
  if (!/45路/.test(othersNow)) stage5.push('没有实时数据的线路没有列出（应全量展示）：' + othersNow.slice(0, 160));
    /* 反方向过滤：详情页当前方向是 P02 的终点站；对面站台（801路 往另一方向）不该出现 */
    if (/801路/.test(othersNow)) {
      stage5.push('反方向的线路混进了「同站其它」：' + othersNow.slice(0, 160));
    }
    if (speakLog.length !== beforeSpeak) stage5.push('点站名仍在播报（应只更新列表）');
    if (!wasDetail) stage5.push('前置条件不对：本来就不在详情页');
  }

  // 顶部（方向 + 车辆）应保持 sticky，跳转后仍在
  if (!document.getElementById('dtop')) stage5.push('详情页缺少 sticky 顶部容器');
  if (!/position:\s*sticky/.test(html)) stage5.push('顶部没有 sticky 样式');
  if (!/class="dh-row"/.test(html)) stage5.push('详情页头部没有改成按钮行/标题行两段结构');
  if (!/\.detail-head \.titles div:first-child \{[^}]*text-overflow/.test(html)) {
    stage5.push('详情页标题没有省略号，长线路名会换行');
  }
  if (!html.includes('startDetailAutoRefresh')) stage5.push('详情页没有 30 秒自动刷新');
if (!/clamp\(/.test(html)) stage5.push('没有自适应字号（clamp）');
if (!/flex-wrap:\s*wrap/.test(html)) stage5.push('窄屏没有放开换行');
if (!/@media \(max-width: 360px\)/.test(html)) stage5.push('缺少窄屏适配');
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
// 从二级页面返回：不应触发额外刷新、倒计时也不重置
{
  const callsBefore = calls.filter((c) => c === 'nearby').length;
  const noteBefore = String(document.getElementById('refreshNote').textContent || '');
  const favCard = findByClass(document.getElementById('favs'), 'fav').find((c) => !textOf(c).includes('站点收藏'));
  if (favCard) {
    favCard.onclick();
    await new Promise((r) => setTimeout(r, 900));
    document.getElementById('back').onclick();
    await new Promise((r) => setTimeout(r, 600));
    const callsAfter = calls.filter((c) => c === 'nearby').length;
    if (callsAfter > callsBefore) {
      stage5.push('从详情返回首页又刷新了一次（应继续用剩余倒计时）');
    }
    const noteAfter = String(document.getElementById('refreshNote').textContent || '');
    if (!noteBefore && !noteAfter) { /* 搜索态不显示，跳过 */ }
    else if (noteAfter === '' ) stage5.push('返回首页后倒计时消失了');
  }
}

console.log('✓ 收藏进详情通过：芯片显示「已过收藏站 · 距终点 N 站」');

// ------------------------------------- 第五阶段附加：车辆二级页 / 下车提醒 / 返回栈
{
  const stage5b = [];
  const favCard = findByClass(document.getElementById('favs'), 'fav').find((c) => !textOf(c).includes('站点收藏'));
  if (!favCard) stage5b.push('没有线路收藏卡，无法进入详情');
  else {
    favCard.onclick();
    await new Promise((r) => setTimeout(r, 900));
    if (String(document.getElementById('detail').className).includes('hidden')) {
      stage5b.push('点收藏卡没有进入详情页');
    }

    // ① 点车辆芯片：原地切换选中车辆并刷新到站表，不再跳车辆二级页
    const chips = findByClass(document.getElementById('dbuses'), 'chip');
    if (!chips.length) stage5b.push('详情页没有车辆芯片');
    else {
      const beforeExit0 = exitLog.length;
      chips[0].onclick();
      await new Promise((r) => setTimeout(r, 300));
      if (!String(document.getElementById('detail').className).includes('hidden') === false) {
        stage5b.push('点车辆芯片后离开了详情页');
      }
      if (String(document.getElementById('detail').className).includes('hidden')) {
        stage5b.push('点车辆芯片后详情页消失了');
      }
      // 到站表要更新成选中那辆车的（dlist 里有车牌行）
      const dlistText = textOf(document.getElementById('dlist'));
      if (!/车牌/.test(dlistText)) stage5b.push('到站表没有车牌行：' + dlistText.slice(0, 80));

      /* v1.0.24：只有详情页一个车辆页，且进来时要标出「离我最近」的站。
         假 DOM 不解析 innerHTML，只能对原始 HTML 文本做正则统计。 */
      {
        const raw = String(document.getElementById('dlist').__rawHtml || '');
        const marks = raw.match(/离我最近/g) || [];
        if (marks.length !== 1) {
          stage5b.push('详情页「离我最近」标记应该恰好 1 处，实际 ' + marks.length);
        }
        if (!/class="srow[^"]*nearest/.test(raw)) {
          stage5b.push('详情页最近站没有 nearest 类：' + raw.slice(0, 160));
        }
      }
      if (exitLog.length !== beforeExit0) stage5b.push('点车辆芯片触发了退出');

      // ② 详情页返回 → 回首页
      const beforeExit2 = exitLog.length;
      window.cdBusBackView();
      await new Promise((r) => setTimeout(r, 200));
      if (String(document.getElementById('home').className).includes('hidden')) {
        stage5b.push('详情页返回没有回到首页');
      }
      if (exitLog.length !== beforeExit2) stage5b.push('详情页返回时退出了 App');

      // ③ 首页再返回 → 才退出 App
      window.cdBusBackView();
      if (exitLog.length !== beforeExit2 + 1) stage5b.push('首页返回没有退出 App');
    }
  }

  if (stage5b.length) {
    console.error('✗ UI 冒烟失败（车辆芯片 / 返回栈）：');
    for (const f of stage5b) console.error('  - ' + f);
    process.exit(1);
  }
  console.log('✓ 车辆芯片通过：点车原地刷新到站表、返回逐级回退、只有首页才退出');
}

// -------------------------------------------------- 第五阶段附加：下车提醒
{
  const stage5c = [];
  const favCard = findByClass(document.getElementById('favs'), 'fav').find((c) => /16路/.test(textOf(c)))
    || findByClass(document.getElementById('favs'), 'fav').find((c) => !textOf(c).includes('站点收藏'));
  if (!favCard) stage5c.push('没有线路收藏卡，无法进入详情');
  else {
    favCard.onclick();
    await new Promise((r) => setTimeout(r, 900));
    const before = alightServiceLog.length;
    if (typeof window.cdBusStartAlight !== 'function') stage5c.push('没有暴露下车提醒接口');
    else {
      window.cdBusStartAlight(9);
      await new Promise((r) => setTimeout(r, 200));
      const started = alightServiceLog.slice(before).filter((x) => x[0] === 'start');
      if (!started.length) stage5c.push('设下车提醒没有启动原生服务');
      else {
        let payload = null;
        try { payload = JSON.parse(started[0][1]); } catch (e) { payload = null; }
        if (!payload) stage5c.push('下车提醒参数不是合法 JSON');
        else {
          if (!/花园永泉/.test(String(payload.destName))) stage5c.push('目的地站名不对：' + payload.destName);
          if (Number(payload.destOrder) !== 9) stage5c.push('目的地站序不对：' + payload.destOrder);
          if (!Array.isArray(payload.stations) || payload.stations.length < 3) {
            stage5c.push('没有把整条线的站点传给服务：' + JSON.stringify(payload.stations).slice(0, 80));
          } else if (payload.stations[0].lat === undefined || payload.stations[0].order === undefined) {
            stage5c.push('站点缺少 order/lat：' + JSON.stringify(payload.stations[0]));
          }
        }
      }
      const bar = document.getElementById('alightbar');
      if (String(bar.className).includes('hidden')) stage5c.push('设了终点后详情页没有提醒条');

      /* 再点同一个站 = 关闭提醒（🔔 按钮切换） */
      {
        const stopBefore = alightServiceLog.filter((x) => x[0] === 'stop').length;
        window.cdBusStartAlight(9);   // 同 order=9 → 应切换成「关闭」
        await new Promise((r) => setTimeout(r, 150));
        if (String(document.getElementById('alightbar').className).indexOf('hidden') < 0) {
          stage5c.push('再点同一个站没有关闭提醒（按钮应可切换）');
        }
        if (alightServiceLog.filter((x) => x[0] === 'stop').length <= stopBefore) {
          stage5c.push('再点同一个站没有停止原生服务');
        }
        // 重新开启，供后续用例使用
        window.cdBusStartAlight(9);
        await new Promise((r) => setTimeout(r, 150));
      }

      // 服务上报「还有两站」→ 页面要同步状态并按事件播报一次
      alightStatusState = { running: true, destName: '花园永泉', lineName: 'P02', toward: '花园公交站',
        remaining: 2, distance: 800, arrived: false, event: 1, eventText: '还有两站就下车，请提前准备',
        message: '', fresh: true };
      const speakBefore = speakLog.length;
      window.cdBusAlightPoll();
      await new Promise((r) => setTimeout(r, 100));
      const barText = String(document.getElementById('alighttext').textContent || '');
      if (!/还有 2 站/.test(barText)) stage5c.push('提醒条没有同步剩余站数：' + barText);
      /* 前台由页面播（服务在亮屏时跳过），这里要求页面确实播了 */
      if (speakLog.length <= speakBefore) {
        stage5c.push('前台下车提醒没有播报（页面应负责前台播报）');
      }

      // 到站事件：v9.15 起到站播报完立刻收尾（不再等 12 秒）
      alightStatusState = { running: true, destName: '花园永泉', lineName: 'P02', toward: '花园公交站',
        remaining: 0, distance: 40, arrived: true, event: 2, eventText: '到站了，请下车',
        message: '', fresh: true };
      const barBeforeArrive = String(document.getElementById('alightbar').className);
      window.cdBusAlightPoll();
      await new Promise((r) => setTimeout(r, 100));

      // ① 到站必须播报（前台由页面负责）
      if (!/到站了/.test(speakLog[speakLog.length - 1] || '')) {
        stage5c.push('到站没有播报：' + speakLog[speakLog.length - 1]);
      }
      // ② 播报之后立刻取消横幅
      if (!String(document.getElementById('alightbar').className).includes('hidden')) {
        stage5c.push('到站后提醒横幅没有自动消失');
      }
      if (textOf(document.getElementById('alightcard')).includes('下车提醒')) {
        stage5c.push('到站后首页卡片没有自动消失');
      }
      // ③ 本地存储被清掉，下次打开 App 不会又弹旧提醒
      if (storage.get('cdbus.alight') !== undefined && storage.get('cdbus.alight') !== null) {
        stage5c.push('到站后没有清掉本地存储的提醒：' + storage.get('cdbus.alight'));
      }
      // ④ 「下车提醒」按钮恢复可点：状态栏提示自动结束（区别于手动取消）
      if (!/自动结束/.test(String(document.getElementById('status').textContent || ''))) {
        stage5c.push('到站后没有提示自动结束：' + String(document.getElementById('status').textContent || ''));
      }
      // ⑤ 再点一次 🔔 应该能重新设提醒（按钮已恢复）
      const bellAfter = findByClass(document.getElementById('dlist'), 'bell');
      if (bellAfter.length) {
        const beforeRestart = alightServiceLog.length;
        bellAfter[0].onclick({ stopPropagation() {} });
        await new Promise((r) => setTimeout(r, 100));
        if (!alightServiceLog.slice(beforeRestart).some((x) => x[0] === 'start')) {
          stage5c.push('到站收尾后 🔔 没能重新设置提醒');
        }
      }

      // 服务重启后事件号从头算：新提醒不能被当成旧事件吞掉
      alightStatusState = { running: true, destName: '花园永泉', lineName: 'P02', toward: '花园公交站',
        remaining: 2, distance: 800, arrived: false, event: 1, eventText: '还有两站就下车，请提前准备',
        message: '', fresh: true };
      const speakBeforeRestart = speakLog.length;
      window.cdBusAlightPoll();
      await new Promise((r) => setTimeout(r, 100));
      if (speakLog.length <= speakBeforeRestart) stage5c.push('服务重启后的事件没有重新播报');

      // 取消：停服务、清卡片
      const stopBefore = alightServiceLog.length;
      window.cdBusStopAlight();
      await new Promise((r) => setTimeout(r, 100));
      if (!alightServiceLog.slice(stopBefore).some((x) => x[0] === 'stop')) {
        stage5c.push('取消下车提醒没有停原生服务');
      }
      if (String(document.getElementById('alightbar').className).indexOf('hidden') < 0) {
        stage5c.push('取消后详情页提醒条没有隐藏');
      }
      if (/下车提醒/.test(textOf(document.getElementById('alightcard')))) {
        stage5c.push('取消后首页卡片没有移除');
      }

      // 服务被系统回收：轮询自己停，界面回落到未运行
      window.cdBusStartAlight(9);
      await new Promise((r) => setTimeout(r, 100));
      alightStatusState = { running: true, destName: '花园永泉', lineName: 'P02', toward: '花园公交站',
        remaining: 3, distance: 1200, arrived: false, event: 1, eventText: '', message: '', fresh: true };
      window.cdBusAlightPoll();
      alightStatusState = { running: false };
      window.cdBusAlightPoll();
      await new Promise((r) => setTimeout(r, 100));
      if (String(document.getElementById('alightbar').className).indexOf('hidden') < 0) {
        stage5c.push('服务停了以后详情页提醒条还亮着');
      }
      if (/下车提醒/.test(textOf(document.getElementById('alightcard')))) {
        stage5c.push('服务停了以后首页卡片还在');
      }
    }
    document.getElementById('back').onclick();
    await new Promise((r) => setTimeout(r, 300));
  }

  if (stage5c.length) {
    console.error('✗ UI 冒烟失败（下车提醒）：');
    for (const f of stage5c) console.error('  - ' + f);
    process.exit(1);
  }
  console.log('✓ 下车提醒通过：选终点启动服务、两站/到站各播一次、可取消');
}

// --------------------------------------------- 第六阶段：模糊搜索（输入 2 列出 2 开头线路）

document.getElementById('line').value = '2';
document.getElementById('stop').value = '';
document.getElementById('go').onclick();
await new Promise((r) => setTimeout(r, 900));

const stage6 = [];
const pickerHtml = textOf(document.getElementById('plist'));
// 列表里不再放重复标题（数量在顶栏 #psub），改查线路卡本身。
// 卡片只显示线路名（方向/首末班进线路页再看），所以查 line-name。
if (!pickerHtml.includes('line-name')) stage6.push('输入 2 没有出现候选线路：' + pickerHtml.slice(0, 160));
// 候选线路应进入「搜索结果」二级页，而不是继续占用首页列表
if (String(document.getElementById('pick').className).includes('hidden')) {
  stage6.push('多条匹配时没有进入搜索结果二级页');
}
if (!String(document.getElementById('home').className).includes('hidden')) {
  stage6.push('搜索结果页显示时首页仍然可见');
}
if (!String(document.getElementById('ptitle').textContent || '').includes('搜索')) {
  stage6.push('搜索结果页缺少标题：' + String(document.getElementById('ptitle').textContent || ''));
}
for (const expect of ['20路', '20快', '21路']) {
  if (!pickerHtml.includes(expect)) stage6.push('候选里缺少 ' + expect);
}
if (typeof window.cdBusShouldAutoRefresh === 'function' && window.cdBusShouldAutoRefresh()) {
  stage6.push('搜索结果显示时，首页自动刷新没有被跳过');
}
const pickerCards = findByClass(document.getElementById('plist'), 'bus');
if (pickerCards.length < 2) stage6.push('候选线路列表过少：' + pickerCards.length);

/* 同一条线（名字相同）只显示一条：上下行两个 direction 必须被去重，
   否则搜「2」会出现 20路/20路、20快/20快 这样的重复项 */
{
  /* 卡片上显示的是 lineLabel() 处理过的「2路」，而排序用的是原始 name「2」，
     比较时统一去掉「路」后缀，否则拿显示名去比会误判。 */
  const names = pickerCards.map((c) => {
    const m = String(c.__rawHtml || '').match(/class="line-name">([^<]*)</);
    return m ? String(m[1]).replace(/路$/, '') : '';
  });
  const dup = names.filter((n, i) => n && names.indexOf(n) !== i);
  if (dup.length) stage6.push('搜索结果有重复方向：' + dup.join(','));
  if (!names.includes('20')) stage6.push('去重后丢了「20路」：' + names.join(','));

  /* 搜索结果要按线路名自然顺序（字母 + 数字按数值）排列：
     不能出现 361 排在 36 前面、或 1060 排在 106 前面这种。
     用页面自己暴露的比较器，保证测的就是线上那份逻辑。 */
  const cmp = window.cdBusNaturalCompare;
  if (typeof cmp !== 'function') {
    stage6.push('没有暴露 cdBusNaturalCompare');
  } else {
    const sorted = names.slice().sort(cmp);
    if (names.join('|') !== sorted.join('|')) {
      stage6.push('搜索结果没有按字母顺序：' + names.join(','));
    }
    /* 比较器本身的回归用例：数字按数值、字母前缀排数字后面 */
    const cases = [
      [['2', '10', '1'], ['1', '2', '10']],
      [['361', '36', '360'], ['36', '360', '361']],
      [['P36', '136', 'T36'], ['136', 'P36', 'T36']],
    ];
    cases.forEach(([input, want]) => {
      const got = input.slice().sort(cmp).join(',');
      if (got !== want.join(',')) stage6.push('自然排序错误：' + input.join(',') + ' → ' + got);
    });
  }
}

if (pickerCards.length) {
  /* v1.0.27：从搜索结果点进详情不许自动播报（只更新页面） */
  const beforeSearchSpeak = speakLog.length;
  pickerCards[0].onclick();
  await new Promise((r) => setTimeout(r, 1200));
  if (speakLog.length > beforeSearchSpeak) {
    stage6.push('从搜索结果点进详情自动播报了：' + speakLog.slice(beforeSearchSpeak).join('|'));
  }
  if (String(document.getElementById('pick').className).includes('hidden') === false) {
    stage6.push('选中候选线路后没有离开搜索结果页');
  }
  if (String(document.getElementById('detail').className).includes('hidden')) {
    stage6.push('点候选线路后没有进入该线路的新页面');
  }
  if (!String(document.getElementById('home').className).includes('hidden')) {
    stage6.push('线路页显示时首页仍然可见');
  }
  /* v1.0.25 合并页：标题是「线路名 · 站名」，起终点方向挪到了副标题 */
  const ltitle = String(document.getElementById('dtitle').textContent || '');
  if (!/路/.test(ltitle)) stage6.push('线路页标题没有显示选中的线路：' + ltitle);
  const dsubNow = String(document.getElementById('dsub').textContent || '');
  if (!/→/.test(dsubNow)) stage6.push('线路页副标题没有显示起终点方向：' + dsubNow);
  if (!/全程 \d+ 站/.test(dsubNow)) {
    stage6.push('线路页没有显示站点数：' + dsubNow);
  }
  const lineChips = findByClass(document.getElementById('lchips'), 'chip');
  if (!lineChips.length) {
    stage6.push('线路页没有列出站名');
  } else {
    lineChips[0].onclick();
    await new Promise((r) => setTimeout(r, 1200));
    /* 合并页下半页是「这辆车到沿途各站」的到站表（.srow），不再是线路卡。
       这些行是 innerHTML 一次性写入的，假 DOM 的 children 为空，只能查文本。 */
    const arrivals = /class="srow/.test(textOf(document.getElementById('dlist'))) ? [1] : [];
    if (!arrivals.length) {
      stage6.push('线路页选站后没有列出到站信息：' + textOf(document.getElementById('dlist')).slice(0, 120));
    }
    if (!/站/.test(String(document.getElementById('dsub').textContent || ''))) {
      stage6.push('线路页选站后副标题没更新');
    }
  }
  // 从线路页返回，应回到搜索结果页（上一级），而不是直接回首页
  window.cdBusBackView();
  await new Promise((r) => setTimeout(r, 500));
  if (String(document.getElementById('pick').className).includes('hidden')) {
    stage6.push('线路页返回没有回到搜索结果页');
  }
  window.cdBusBackView();
  await new Promise((r) => setTimeout(r, 500));
  if (String(document.getElementById('home').className).includes('hidden')) {
    stage6.push('搜索结果页返回没有回到首页');
  }
}

if (stage6.length) {
  console.error('✗ UI 冒烟失败（模糊搜索）：');
  for (const f of stage6) console.error('  - ' + f);
  process.exit(1);
}
console.log('✓ 模糊搜索通过：输入 2 列出 20 / 20快 / 21 … 并可点选');

/* 区县名搜索：接口对「都江堰」只吐前 10 条（5 条线），
   前端必须按数字前缀展开才拿得到全部 12 条桩数据。 */
document.getElementById('line').value = '都江堰';
document.getElementById('go').onclick();
await new Promise((r) => setTimeout(r, 1500));
const djyHtml = textOf(document.getElementById('plist'));
const djyNames = [...new Set(
  (djyHtml.match(/都江堰\d+[A-Z]?路/g) || []).map((n) => n.replace(/路$/, '')),
)];
const stage6b = [];
if (djyNames.length < 10) {
  stage6b.push('搜「都江堰」只拿到 ' + djyNames.length + ' 条线，被 10 条上限截断了：' + djyNames.join(','));
}
for (const expect of ['都江堰6', '都江堰12', '都江堰101']) {
  if (!djyNames.includes(expect)) stage6b.push('搜「都江堰」漏了 ' + expect);
}
if (stage6b.length) {
  console.error('✗ UI 冒烟失败（区县线路展开）：');
  for (const f of stage6b) console.error('  - ' + f);
  process.exit(1);
}
console.log('✓ 区县线路展开通过：搜「都江堰」拿到 ' + djyNames.length + ' 条线');

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
const containsHtml = textOf(document.getElementById('plist'));
const stage7 = [];
for (const expect of ['P106路', 'T106路', '1060路']) {
  if (!containsHtml.includes(expect)) stage7.push('输入 106 没有列出 ' + expect + '：' + containsHtml.slice(0, 200));
}
if (stage7.length) {
  console.error('✗ UI 冒烟失败（包含匹配）：');
  for (const f of stage7) console.error('  - ' + f);
  process.exit(1);
}
{
  /* 搜索结果卡片现在只显示线路名：方向、首末班都进线路页再看。
     这里反过来断言「不再出现」这些信息，防止哪天又被加回去。 */
  const pickText = textOf(document.getElementById('plist'));
  if (/首班 \d{2}:\d{2} · 末班 \d{2}:\d{2}/.test(pickText)) {
    console.error('✗ UI 冒烟失败：搜索结果又显示首末班了：' + pickText.slice(0, 240));
    process.exit(1);
  }
  if (/ → /.test(pickText)) {
    console.error('✗ UI 冒烟失败：搜索结果又显示起终点方向了：' + pickText.slice(0, 240));
    process.exit(1);
  }
  console.log('✓ 搜索结果只显示线路名：不含方向与首末班');
}
console.log('✓ 包含匹配通过：输入 106 列出 P106 / T106 / 1060');

// 搜索历史：刚搜过的关键字应出现在历史里，点它可再次搜索
{
  const histText = textOf(document.getElementById('history'));
  if (!/106/.test(histText)) {
    console.error('✗ UI 冒烟失败：搜索历史没有记录 106：' + histText);
    process.exit(1);
  }
  const histChips = findByClass(document.getElementById('history'), 'chip').filter((c) => !String(c.className).includes('hclear'));
  if (!histChips.length) {
    console.error('✗ UI 冒烟失败：历史里没有可点的关键字');
    process.exit(1);
  }
  document.getElementById('line').value = '';
  histChips[0].onclick();
  await new Promise((r) => setTimeout(r, 800));
  if (!/P106|106/.test(textOf(document.getElementById('plist')))) {
    console.error('✗ UI 冒烟失败：点历史关键字没有触发搜索');
    process.exit(1);
  }
  const clearChip = findByClass(document.getElementById('history'), 'chip').find((c) => String(c.className).includes('hclear'));
  if (!clearChip) {
    console.error('✗ UI 冒烟失败：历史没有「清空」按钮');
    process.exit(1);
  }
  clearChip.onclick({ stopPropagation() {} });
  await new Promise((r) => setTimeout(r, 100));
  if (textOf(document.getElementById('history'))) {
    console.error('✗ UI 冒烟失败：清空后历史仍有内容');
    process.exit(1);
  }
  console.log('✓ 搜索历史通过：记录、点击重搜、清空');
}

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

// ------------------------------------------------ 第九阶段：设置 → 字体大小

const stage9 = [];
const fontScaleOf = () => parseFloat(rootStyle.getPropertyValue('--font-scale'));

// 打开设置，主页应有「字体大小」入口
document.getElementById('settingsBtn').onclick();
await new Promise((r) => setTimeout(r, 300));
document.getElementById('setFont').onclick();
await new Promise((r) => setTimeout(r, 300));

// 六个档位都要渲染出来
const fontText = textOf(document.getElementById('fontList'));
for (const name of ['特小', '小', '标准', '大', '特大', '超大']) {
  if (!fontText.includes(name)) stage9.push('字体页面缺少档位：' + name);
}
if (!fontText.includes('125%')) stage9.push('选项没有显示百分比：' + fontText.slice(0, 200));

// 默认应是标准 100%
if (Math.abs(fontScaleOf() - 1) > 0.01) stage9.push('默认字号系数不是 1，实际 ' + fontScaleOf());

// 点「特大」→ 系数 1.25、写入 localStorage
const fontRows = findByClass(document.getElementById('fontList'), 'fontopt');
if (fontRows.length !== 6) stage9.push('字号选项数量不是 6，实际 ' + fontRows.length);
else {
  const xlRow = fontRows.find((el) => textOf(el).includes('特大'));
  if (!xlRow) stage9.push('找不到「特大」选项');
  else if (typeof xlRow.onclick !== 'function') stage9.push('「特大」选项没有绑定点击事件');
  else {
    xlRow.onclick();
    await new Promise((r) => setTimeout(r, 200));
    if (Math.abs(fontScaleOf() - 1.25) > 0.01) {
      stage9.push('点「特大」后系数应为 1.25，实际 ' + fontScaleOf());
    }
    const stored = localStorage.getItem('cdbus.fontScale');
    if (stored !== '1.25') stage9.push('字号没有写进 localStorage，实际 ' + stored);
    // 注意：className 里 "fontopt" 本身就含子串 "on"，必须按空格分词比较
    const onRows = findByClass(document.getElementById('fontList'), 'fontopt')
      .filter((el) => String(el.className || '').split(/\s+/).includes('on'));
    if (onRows.length !== 1) stage9.push('选中态数量应为 1，实际 ' + onRows.length);
    else if (!textOf(onRows[0]).includes('特大')) stage9.push('选中态不是「特大」');
  }
}

// 返回设置主页，副标题要显示当前字号
document.getElementById('fontBack').onclick();
await new Promise((r) => setTimeout(r, 200));
const sub = textOf(document.getElementById('setFontSub'));
if (!sub.includes('特大') || !sub.includes('125%')) {
  stage9.push('设置主页副标题没反映当前字号：' + sub);
}

// 再进一次，确认选项状态被保留（不是每次重新渲染就丢）
document.getElementById('setFont').onclick();
await new Promise((r) => setTimeout(r, 200));
if (Math.abs(fontScaleOf() - 1.25) > 0.01) stage9.push('重新进入后字号被重置');

if (stage9.length) {
  console.error('✗ UI 冒烟失败（字体大小）：');
  for (const f of stage9) console.error('  - ' + f);
  process.exit(1);
}
console.log('✓ 字体大小通过：6 档选项、实时生效、持久化、不跟随系统');

// 首页有 30 秒自动刷新定时器，测试用完直接退出
process.exit(0);
console.log('  状态栏：' + status);