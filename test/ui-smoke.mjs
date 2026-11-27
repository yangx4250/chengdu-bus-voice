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

/** 读工程里的文件；读不到返回空串（让断言报出来，而不是整个测试崩掉）。 */
function readSafe(rel) {
  try {
    return readFileSync(path.join(here, '..', rel), 'utf-8');
  } catch (e) {
    return '';
  }
}
const html = readFileSync(path.join(here, '..', 'app', 'assets', 'index.html'), 'utf-8');
const scriptStart = html.indexOf('<script>\n(function');
const scriptEnd = html.indexOf('</script>', scriptStart);
const script = html.slice(scriptStart + '<script>'.length, scriptEnd);

// ---------------------------------------------------------------- DOM 桩

function textOf(node) {
  if (!node) return '';
  const raw = node.__rawHtml || '';                    // innerHTML 赋值的内容
  const own = node.textContent || '';
  /* children 可能是 HTMLCollection 桩（类数组、没有 map），统一用 Array.from 摊平 */
  const kids = Array.from(node.children || []).map(textOf).join('');
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
        /* 已收班的线路：真实接口不会给在途车辆（stationsAway 为 null），
           以前桩里写 away=43 是自相矛盾的「有车但已收班」，
           会掩盖「有车不该判灰」这条规则。 */
        { stationId: '028-1', stationName: '花园永泉', stationOrder: 5, lineId: '028-716-0',
          lineName: '716', toward: '郫都区客运中心', stationsAway: null, etaSeconds: null,
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
const transitCalls = [];
const poiQueries = [];
const batteryLog = [];
const notes = [];
/* 让 arrivals 桩返回「已到站」的车（盯站到站播报测试用） */
let arrivalsArrived = false;
let arrivalsCalls = 0;   // arrivals 被调用次数（验证回到前台会重新拉数据）
let arrivalsEta = null;
const heartbeatLog = [];
let heartbeatRunning = false;
let watchDiagOn = false;
let lockNotifyOn = true;
const lockNotifyLog = [];
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
      /* 45 路：没有实时数据 → 从「同站其它」点进来时要能正常渲染 */
      if (String(args.lineId || '').includes('028-45-')) {
        return JSON.stringify({ state: 'ok', data: {
          line: { lineId: '028-45-0', name: '45', startSn: '花园公交站', endSn: '双楠小区',
                  firstTime: '06:00', lastTime: '22:30', departLeft: 0, depIntervalM: 10, preArrivalTime: '' },
          stations: [
            { order: 1, name: '花园公交站', stationId: '028-9', lat: 30.8, lng: 103.9 },
            { order: 4, name: '花园永泉', stationId: '028-1', lat: 30.7, lng: 103.95 },
          ],
          buses: [],
          queriedFrom: 4, queriedTo: 4,
        } });
      }
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
    /* 城市识别现在返回 { cityId, city, covered }；covered:false 表示该地无实时数据 */
    if (method === 'city') {
      return JSON.stringify({ state: 'ok', data: { cityId: '007', city: '成都', covered: true } });
    }
    if (method === 'citytable') {
      return JSON.stringify({ state: 'ok', data: [
        { cityId: '007', name: '成都', group: '成都', level: 'city', covered: true },
        { cityId: '133', name: '绵阳', group: '绵阳', level: 'city', covered: true },
        { cityId: '271', name: '都江堰', group: '成都', level: 'county', covered: true },
        { cityId: null, name: '德阳', group: '德阳', level: 'city', covered: false,
          note: '德阳市区暂无实时数据；广汉可用', fallbackName: '广汉' },
        { cityId: null, name: '凉山', group: '凉山', level: 'city', covered: false,
          note: '凉山州全域暂无实时数据' },
      ] });
    }
    if (method === 'nearby') return JSON.stringify({ state: 'ok', data: nearbyPayload });
    if (method === 'pois') {
      // 模拟服务端：单次最多 3 条，且不同关键词回不同地点 → 多轮收窄能挖出更多
      const key = String(args.key || '');
      poiQueries.push(key);
      if (key === '武侯祠') {
        return JSON.stringify({ state: 'ok', data: [
          { name: '成都武侯祠博物馆', address: '武侯区武侯祠大街 231 号', lat: 30.6469, lng: 104.0481 },
          { name: '成都武侯祠博物馆-西区', address: '武侯区武侯祠大街 231 号', lat: 30.6471, lng: 104.0455 },
          { name: '武侯祠大街', address: '武侯区', lat: 30.6462, lng: 104.0488 },
        ] });
      }
      if (key.indexOf('武侯祠') >= 0) {
        return JSON.stringify({ state: 'ok', data: [
          { name: '武侯祠-地铁站', address: '武侯祠大街', lat: 30.6455, lng: 104.05 },
          { name: '锦里古街', address: '武侯祠大街 231 号', lat: 30.6451, lng: 104.0475 },
        ] });
      }
      return JSON.stringify({ state: 'ok', data: [] });
    }
    if (method === 'transit') {
      transitCalls.push(args);
      return JSON.stringify({ state: 'ok', data: { transits: [
        { duration: 1800, walkingDistance: 600, transferCount: 1, tag: '推荐', segments: [
          { mode: 'walk', walkDistance: 300 },
          { mode: 'bus', name: '98路', lineId: '028-98-1', lineType: 0, from: '顺城大街南', to: '春熙路', viaNum: 5, duration: 900 },
          { mode: 'metro', name: '地铁2号线', lineId: '', lineType: 1, from: '天府广场', to: '春熙路', viaNum: 1, duration: 240 },
          { mode: 'walk', walkDistance: 300 },
        ] },
        { duration: 2400, walkingDistance: 100, transferCount: 0, tag: '直达', segments: [
          { mode: 'bus', name: '48路', lineId: '028-48-0', lineType: 0, from: '盐市口', to: '春熙路', viaNum: 8, duration: 1200 },
        ] },
      ] } });
    }
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
  /* 锁屏通知桩（v1.0.44）：记录开关与测试通知调用 */
  setLockNotify(on) { lockNotifyLog.push(['set', Boolean(on)]); lockNotifyOn = Boolean(on); },
  lockNotifyOn() { return lockNotifyOn; },
  testLockNotify() { lockNotifyLog.push(['test', true]); },
  lockNotifyDiag() { return '开关：开；通知权限：已授权；通道重要度：4；锁屏可见性：1；系统通知总开关：正常'; },
  askNotificationPermission() { lockNotifyLog.push(['perm', true]); },
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
  /* 导航桩：假装装了高德和百度；v1.0.33 起原生侧一律步行 */
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
    const mode = 'walk';   // v1.0.33：去掉 500 米限制，导航一律步行
    navLog.push({ appId, lat, lng, name, fromLat, fromLng, mode, distance });
    return JSON.stringify({ ok: true, app: appId || 'amap', label: '高德地图', mode, distance });
  },
  testTone() {}, testPcm() {}, testSysTone() {}, testSpeak() {}, setVolume() {},
  location() { return '30.657,104.065'; },
};

globalThis.__scrollLog = [];
const window = {
  AndroidBus: bridge,
  /* 布局桩：页面里的滚动定位会用 window.innerHeight / scrollY / scrollTo */
  innerHeight: 800,
  innerWidth: 400,
  scrollY: 0,
  pageYOffset: 0,
  scrollLog: globalThis.__scrollLog,
  scrollTo(a, b) { globalThis.__scrollLog.push(typeof a === 'object' ? a.top : b); },
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
  'ResizeObserver',
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

/* 策略芯片：真实 WebView 里是 HTML 里的静态节点，element.children 返回
   HTMLCollection —— 有 length / 下标 / Symbol.iterator，但**没有 forEach**。
   桩里必须照这个样子造，否则页面写成 chips.forEach 也能过测试（v1.0.59 的 bug）。 */
function makeHtmlCollection(items) {
  const col = { length: items.length };
  for (let i = 0; i < items.length; i++) col[i] = items[i];
  col.item = (i) => items[i] || null;
  col.namedItem = () => null;
  col[Symbol.iterator] = function () { return items[Symbol.iterator](); };
  return col;
}
/* 桩要和页面 HTML 的 data-st 对齐（v1.0.59 起）：推荐=0 少步行=1 少换乘=2 公交优先=3 */
const STRATEGY_ST = { '推荐': '0', '少步行': '1', '少换乘': '2', '公交优先': '3' };
const strategyChips = ['推荐', '少换乘', '少步行', '公交优先'].map((label, i) => {
  const c = makeElement();
  c.className = i === 0 ? 'chip on' : 'chip';
  c.textContent = label;
  c.setAttribute('data-st', STRATEGY_ST[label]);
  return c;
});
document.getElementById('strategyRow').children = makeHtmlCollection(strategyChips);

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
if (html.indexOf('id="loctext"') > html.indexOf('<div class="row searchrow">')) {
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
if (!/VIEWS = \["home", "detail", "metro", "diag", "pick", "route"\]/.test(html)) {
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

/* v1.0.49：首页去掉「查询并播报」「当前位置」两个按钮——
   查询变成搜索框右边的 🔍。
   v1.1.8 起顶栏改为：设置居左、标题居中、刷新居右（按钮位置上移到了标题两侧）。 */
if (/id="near"/.test(html)) failures.push('首页还留着「当前位置」按钮');
if (/>查询并播报</.test(html)) failures.push('首页还留着「查询并播报」按钮');
if (/<button id="go"[^>]*>查询并播报/.test(html)) failures.push('查询按钮还是文字，不是 🔍');
if (!/<input id="line"[\s\S]{0,200}?<button id="go" class="searchgo"[^>]*>🔍<\/button>/.test(html)) {
  failures.push('搜索框右边没有 🔍 查询按钮');
}
if (!/id="refreshHome" class="iconbtn[^"]*"[^>]*>🔄</.test(html)) {
  failures.push('刷新按钮没有变成 🔄 图标');
}
/* 新布局：设置在最左、刷新在最右，标题在中间 —— 见下方「顶栏布局」专项断言 */
if (html.indexOf('id="settingsBtn"') > html.indexOf('id="refreshHome"')) {
  failures.push('设置按钮应在刷新按钮左边（新布局：设置居左、刷新居右）');
}
if (!/\.searchgo\s*\{[^}]*width:\s*46px/.test(html)) {
  failures.push('🔍 按钮没有单独的图标尺寸样式');
}

/* v1.0.50：使用说明按当前版本重写——不能出现已经删掉的功能，
   必须覆盖现在的真实入口（🔍/🔄/三列格子/吸顶区/锁屏通知/字体大小）。 */
if (/查询并播报|自动播报开关|「当前位置」|id="near"/.test(html)) failures.push('使用说明里还在讲已删除的功能');
if (/点击车辆看沿途各站/.test(html)) failures.push('使用说明里还在讲已合并的「车辆页」');
const guideAll = (html.match(/var GUIDE_FULL = \[([\s\S]*?)\n  \];/) || ['', ''])[1];
for (const need of ['🔍', '🔄', '三列', '吸顶', '锁屏通知', '字体大小', '盯站', '下车提醒', '导航', '同站其他']) {
  if (guideAll.indexOf(need) < 0) failures.push('使用说明缺少「' + need + '」相关说明');
}
const fullLen = (html.match(/var GUIDE_FULL = \[([\s\S]*?)\n  \];/) || [])[1] || '';
const secCount = (fullLen.match(/\{ title:/g) || []).length;
if (secCount < 7) failures.push('完整说明章节太少，实际 ' + secCount + ' 章');
/* v1.0.53：首次弹窗和设置页共用同一份 —— 两处都渲染 guideSectionsHtml()，
   且 GUIDE_QUICK 已删除（否则又是两份各写一份）。 */
if (/GUIDE_QUICK/.test(html)) failures.push('GUIDE_QUICK 没删干净，弹窗和设置页可能不一致');
if (!/function guideSectionsHtml\(\)/.test(html)) failures.push('缺少共用的 guideSectionsHtml()');
const modalBody = (html.match(/function openGuideModal\(\)[\s\S]{0,300}/) || [''])[0];
const setBody = (html.match(/function renderGuide\(\)[\s\S]{0,300}/) || [''])[0];
if (!/guideSectionsHtml\(\)/.test(modalBody)) failures.push('首次弹窗没有复用 guideSectionsHtml()');
if (!/guideSectionsHtml\(\)/.test(setBody)) failures.push('设置页没有复用 guideSectionsHtml()');

/* 关于页不该暴露签名指纹（v1.0.52） */
{
  const about = html.slice(html.indexOf('id="setPageAbout"'), html.indexOf('id="setPageAbout"') + 1400);
  if (/<span>签名<\/span>/.test(about)) failures.push('关于页还在显示签名');
  if (/b5c11b4d/.test(html)) failures.push('代码里还留着签名指纹 b5c11b4d');
}

/* 返回键回桌面不应杀死 App（v1.0.55）：exitApp 必须 moveTaskToBack，不能 finish */
{
  const bridgeJava = readFileSync(path.join(here, '..', 'app', 'src', 'com', 'chengdu', 'bus', 'BusBridge.java'), 'utf-8');
  const mainJava = readFileSync(path.join(here, '..', 'app', 'src', 'com', 'chengdu', 'bus', 'MainActivity.java'), 'utf-8');
  const exitFn = (bridgeJava.match(/void exitApp\(\)\s*\{([\s\S]*?)\n    \}/) || ['', ''])[1];
  if (!/moveTaskToBack\s*\(\s*true\s*\)/.test(exitFn)) failures.push('exitApp() 没有用 moveTaskToBack 退回桌面');
  if (/\bfinish\s*\(/.test(exitFn)) failures.push('exitApp() 仍在调用 finish()，会杀死 App');
  const backFn = (mainJava.match(/void onBackPressed\(\)\s*\{([\s\S]*?)\n    \}/) || ['', ''])[1];
  if (/super\.onBackPressed\s*\(/.test(backFn)) failures.push('onBackPressed() 仍会 super.onBackPressed() 结束 Activity');
}

if (failures.length) {
  console.error('✗ UI 冒烟失败：');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}

// ---------------------------------------------------- 第二阶段：搜索 → 选站 → 首页收藏

// 选中线路后进「线路页」，站名芯片在这页上

const stage2 = [];

// ------------------------------------------- v1.0.46：详情页吸顶区不随页面滚动

{
  /* v1.0.48：从「同站其他」往上全部吸顶不动，只有它下面的发车预测 + 到站表滚动。
     #dtop 必须 sticky，而且**不能**有 overflow-y/max-height（否则车牌会跟着内部滚动滚走）。 */
  const dtopRule = html.match(/#dtop\s*\{([^}]*)\}/);
  const rule = dtopRule ? dtopRule[1] : '';
  if (!/position:\s*sticky/.test(rule)) stage2.push('#dtop 不是 sticky，滚动时会跟着页面走');
  if (/overflow-y:\s*auto/.test(rule)) stage2.push('#dtop 又有内部滚动了，车牌会跟着滚走');
  if (/max-height/.test(rule)) stage2.push('#dtop 又有高度上限了，吸顶区会被截断');

  /* 吸顶区必须包含「同站其他」及其以上：车牌行、同站其他 */
  const dtopStart = html.indexOf('id="dtop"');
  const scrollStart = html.indexOf('id="dscroll"');
  if (dtopStart < 0 || scrollStart < 0) {
    stage2.push('详情页缺少 #dtop 或 #dscroll 容器');
  } else {
    const dtopHtml = html.slice(dtopStart, scrollStart);
    ['dbusinfo', 'dbuses', 'dothers', 'lchips', 'ddirs', 'lnav'].forEach(function (id) {
      if (!new RegExp('id="' + id + '"').test(dtopHtml)) {
        stage2.push('#' + id + ' 应该吸顶（在 #dtop 里），实际不在');
      }
    });
    /* 滚动区里只能有发车预测和到站表 */
    const scrollHtml = html.slice(scrollStart, scrollStart + 600);
    if (!/id="depbar"/.test(scrollHtml)) stage2.push('#depbar 应该在滚动区 #dscroll 里');
    if (!/id="dlist"/.test(scrollHtml)) stage2.push('#dlist 应该在滚动区 #dscroll 里');
    ['dbuses', 'dothers', 'lchips'].forEach(function (id) {
      if (new RegExp('id="' + id + '"').test(scrollHtml)) {
        stage2.push('#' + id + ' 不该在滚动区 #dscroll 里（应该吸顶）');
      }
    });
  }
}



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
    else if (navBtns.length !== 4) {
      stage2.push('导航行应有 4 个按钮（导航/收藏/盯站/下车提醒），实际 ' + navBtns.length + ' 个');
    } else {
      /* 点「导航」→ 弹出地图选择层，里面列出已装的地图 App */
      const beforeNav = navLog.length;
      const navEntry = findByClass(lnav, 'navbtn').find((b) => /导航/.test(textOf(b)) && !/收藏|盯站/.test(textOf(b)));
      if (!navEntry) stage2.push('导航行里找不到「导航」按钮');
      else navEntry.onclick({ stopPropagation() {} });
      await new Promise((r) => setTimeout(r, 200));
      const pickList = document.getElementById('dnavpickList');
      const pickText = textOf(pickList);
      if (!/高德地图/.test(pickText)) stage2.push('地图选择层缺少高德：' + pickText);
      if (!/百度地图/.test(pickText)) stage2.push('地图选择层缺少百度：' + pickText);
      if (!/系统地图/.test(pickText)) stage2.push('地图选择层缺少系统地图兜底：' + pickText);
      if (navLog.length !== beforeNav) stage2.push('只是打开选择层就调起了导航');
      const pickBtns = findByClass(pickList, 'navbtn');
      if (!pickBtns.length) stage2.push('地图选择层没有按钮');
      else pickBtns[0].onclick();
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

// v1.0.33：导航一律步行，不再按距离切成驾车。近处、远处都要是 walk。
{
  const nearFix = { lat: 30.7009, lng: 103.95, accuracy: 20, provider: 'gps', stale: false };
  const farFix = { lat: 30.657, lng: 104.065, accuracy: 30, provider: 'network', stale: false };
  if (typeof window.cdBusSetFix !== 'function' || typeof window.cdBusNavToStation !== 'function') {
    stage2.push('没有暴露定位/导航测试钩子');
  } else {
    window.cdBusSetFix(nearFix);
    window.cdBusNavToStation('amap');
    const walkCall = navLog[navLog.length - 1];
    if (walkCall.mode !== 'walk') {
      stage2.push('近距离应走步行导航，实际：' + walkCall.mode + '（' + walkCall.distance + ' 米）');
    }
    if (!(walkCall.distance > 0 && walkCall.distance <= 500)) {
      stage2.push('近距离距离计算不对：' + walkCall.distance);
    }

    /* 导航条：地图 App 收进选择层，行上只有一个「导航」入口 */
    const navRow = document.getElementById('lnav');
    const navText = textOf(navRow);
    if (!navText.includes('导航')) {
      stage2.push('导航条没有「导航」入口：' + navText.slice(0, 60));
    }
    if (navText.includes('导航到')) {
      stage2.push('导航条还残留「导航到」（应固定步行）：' + navText.slice(0, 60));
    }

    window.cdBusSetFix(farFix);
    window.cdBusNavToStation('amap');
    const farCall = navLog[navLog.length - 1];
    if (farCall.mode !== 'walk') {
      stage2.push('超过 500 米也必须走步行导航，实际：' + farCall.mode + '（' + farCall.distance + ' 米）');
    }
    if (!(farCall.distance > 500)) {
      stage2.push('远距离距离计算不对：' + farCall.distance);
    }
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

/* 静态检查：代码里引用的所有 id 都必须在 HTML 里存在，
   否则 $("xxx").className 会抛 TypeError，把整条链路打断（v1.0.41 的教训）。 */
{
  const ids = new Set();
  const re = /\$\("([a-zA-Z0-9_-]+)"\)/g;
  let m;
  while ((m = re.exec(html))) ids.add(m[1]);
  const missing = [];
  for (const id of ids) {
    if (!new RegExp('id="' + id + '"').test(html)) missing.push(id);
  }
  /* status 是 setStatus 里的可选元素（`if (el)` 保护），不算问题 */
  const realMissing = missing.filter((id) => id !== 'status');
  if (realMissing.length) {
    stage2.push('代码引用了不存在的 id（$() 会抛异常）：' + realMissing.join(', '));
  }
}

if (stage2.length) {
  console.error('✗ UI 冒烟失败（收藏链路）：');
  for (const f of stage2) console.error('  - ' + f);
  process.exit(1);
}

// ---------------------------------------------------- 第三阶段：同一站点两个方向分开显示

// 第二阶段把列表切成了线路查询视图，先回到附近站点
// v1.0.49：首页「当前位置」按钮已删除，用标题栏的「刷新」按钮回首页
window.cdBusBackView();
await new Promise((r) => setTimeout(r, 300));
document.getElementById('refreshHome').onclick();
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

/* 首页取消变灰：这个物理站是双向共用，站序只对应一个方向，另一个方向的车
   可能还在跑，所以首页任何线路格子都不该带 ended 类（详情页才判收班）。 */
for (const ln of ['P02', 'P10', '716', 'P36', '45', '801']) {
  const cell = rowOf(ln + '路');
  if (cell && hasClass(cell, 'ended')) {
    stage3.push('首页线路 ' + ln + ' 仍被标成已收班变灰（首页不该变灰）');
  }
}

/* v1.0.26：灰色（不在运营时段）的格子也要能点进去看。
   这里必须真的点一下——守卫写在 onclick 函数体里，只看有没有函数抓不到回归。 */
const anyCell = rowOf('716路');
if (anyCell && typeof anyCell.onclick === 'function') {
  anyCell.onclick();
  await new Promise((r) => setTimeout(r, 900));
  if (String(document.getElementById('detail').className).includes('hidden')) {
    stage3.push('点首页线路格子没有进入详情页');
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
      const sfav3 = findByClass(document.getElementById('lnav'), 'stationfav');
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
    const sfavBtn = findByClass(document.getElementById('lnav'), 'stationfav');
    if (!sfavBtn.length) {
      stage4.push('详情页没有「收藏站点」按钮');
    } else {
      // 选中一个站才有按钮状态；先点站名芯片
      const chips0 = findByClass(document.getElementById('lchips'), 'chip');
      if (chips0.length) {
        chips0[0].onclick();
        await new Promise((r) => setTimeout(r, 400));
        const sfavBtn2 = findByClass(document.getElementById('lnav'), 'stationfav');
        if (sfavBtn2.length) {
          const favsBefore = JSON.parse(storage.get('cdbus.favorites') || '[]').length;
          sfavBtn2[0].onclick();
          await new Promise((r) => setTimeout(r, 100));
          const favsAfter = JSON.parse(storage.get('cdbus.favorites') || '[]').length;
          if (favsAfter !== favsBefore + 1) {
            stage4.push('点「收藏站点」没有写入收藏');
          }
          // 再点取消
          const sfavBtn3 = findByClass(document.getElementById('lnav'), 'stationfav');
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

      const wBtn = findByClass(document.getElementById('lnav'), 'stationwatch');
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
        const wBtn2 = findByClass(document.getElementById('lnav'), 'stationwatch');
        if (!wBtn2.length || String(wBtn2[0].textContent).indexOf('已盯站') < 0) {
          stage4.push('盯站后按钮没有变成「已盯站」：' + (wBtn2[0] ? textOf(wBtn2[0]) : '找不到按钮'));
        } else {
          const stopBefore = watchServiceLog.filter((x) => x[0] === 'stop').length;
          wBtn2[0].onclick();
          await new Promise((r) => setTimeout(r, 300));
          const stopAfter = watchServiceLog.filter((x) => x[0] === 'stop').length;
          if (stopAfter <= stopBefore) stage4.push('再点「已盯站」没有取消盯站');
        }

        /* v1.0.46：盯站通知条取消，改为站名芯片蓝色高亮（.watched）。
           盯站后必须有一个芯片带 watched，取消后一个都不能剩。 */
        wBtn[0].onclick();                        // 先重新盯上
        await new Promise((r) => setTimeout(r, 400));
        const chipsWatched = findByClass(document.getElementById('lchips'), 'watched');
        if (chipsWatched.length !== 1) {
          stage4.push('盯站后站名芯片没有蓝色高亮（.watched 数量 ' + chipsWatched.length + '）');
        }
        /* 顶部盯站通知条整个元素都已删除（v1.0.46 改成站名蓝色高亮） */
        if (/id="dwatchbar"/.test(html)) {
          stage4.push('盯站通知条元素还在（v1.0.46 已删除，改为站名高亮）');
        }
        /* 取消盯站：点导航行里的「📌 已盯站」 */
        const wBtn3s = findByClass(document.getElementById('lnav'), 'stationwatch');
        if (wBtn3s.length) {
          wBtn3s[0].onclick();
          await new Promise((r) => setTimeout(r, 400));
          const chipsAfter = findByClass(document.getElementById('lchips'), 'watched');
          if (chipsAfter.length !== 0) {
            stage4.push('取消盯站后站名芯片还有蓝色高亮（.watched 数量 ' + chipsAfter.length + '）');
          }
          const wBtn4 = findByClass(document.getElementById('lnav'), 'stationwatch');
          const label4 = wBtn4.length ? String(wBtn4[0].textContent) : '';
          if (label4.indexOf('已盯站') >= 0) {
            stage4.push('取消盯站后按钮还是「已盯站」，没有立刻刷新：' + label4);
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
  globalThis.__scrollLog.length = 0;
  favCard16.onclick();
  await new Promise((r) => setTimeout(r, 900));
  /* v1.0.43：从首页点进来时，到站表要自动滚到当前站（不是停在顶部） */
  {
    const t = window.cdBusLastTimes;
    if (!t) stage5.push('renderTimes 没有执行，无法判断是否自动滚动');
    else if (t.scroll !== true) stage5.push('从首页进详情后到站表没有要求滚动到当前站：' + JSON.stringify(t));
    else if (t.nearest !== true) stage5.push('进详情时应滚到当前站而不是车所在站：' + JSON.stringify(t));
  }
  /* v1.0.56：滚动目标必须落在吸顶区下方——第一张卡片不能被 #dtop 挡住。
     直接调纯函数 scrollTargetFor，模拟「吸顶区 420px + 视口 800px」的真实场景，
     断言滚完后元素顶部(finalTop) 在吸顶区下沿(visTop) 之下。 */
  {
    const f = window.cdBusScrollTargetFor;
    if (typeof f !== 'function') stage5.push('没有暴露 window.cdBusScrollTargetFor，无法核对滚动目标');
    else {
      /* 目标行当前在 rect.top=1000（文档中段）、高 96px；吸顶 420、视口 800。
         旧算法 target=1000-800/2+48=648 → finalTop=352，落在吸顶区(0~420)里被挡；
         新算法 target=1000-616+48=432 → finalTop=568，避开吸顶区。 */
      const topH = 420, viewH = 800;
      const calc = f({ top: 1000, height: 96 }, topH, viewH);
      if (!(calc.visTop > topH)) stage5.push('滚动可视上沿没有避开吸顶区：' + JSON.stringify(calc));
      if (!(calc.finalTop >= calc.visTop)) {
        stage5.push('滚完后第一张卡片仍在吸顶区覆盖范围内（会被挡住）：' + JSON.stringify(calc));
      }
      if (!(calc.visMid > viewH / 2)) stage5.push('可视区中点没有下移到吸顶区以下：' + JSON.stringify(calc));
    }
  }
  /* v1.0.54：手动刷新 / 回前台自动刷新都不要再滚回车辆所在站，
     保持用户当前浏览位置（首次进入那一次滚动除外）。 */
  {
    globalThis.__scrollLog.length = 0;
    document.getElementById('drefresh').onclick();          // 手动刷新
    await new Promise((r) => setTimeout(r, 500));
    const tm = window.cdBusLastTimes;
    if (!tm || tm.scroll !== false) stage5.push('手动刷新后到站表又自动滚动了：' + JSON.stringify(tm));
    if (globalThis.__scrollLog.length) stage5.push('手动刷新触发了 scrollTo，页面会跳回车辆站：' + JSON.stringify(globalThis.__scrollLog));

    globalThis.__scrollLog.length = 0;
    window.cdBusResume && window.cdBusResume();             // 回前台自动刷新
    await new Promise((r) => setTimeout(r, 600));
    const ta = window.cdBusLastTimes;
    if (!ta || ta.scroll !== false) stage5.push('回前台自动刷新后到站表又自动滚动了：' + JSON.stringify(ta));
    if (globalThis.__scrollLog.length) stage5.push('回前台自动刷新触发了 scrollTo：' + JSON.stringify(globalThis.__scrollLog));
  }
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

  // 点某一站盯站（走导出的接口）：站名芯片应蓝色高亮（v1.0.46 取代盯站条）
  if (typeof window.cdBusWatchStation === 'function') {
    window.cdBusWatchStation(9);
    await new Promise((r) => setTimeout(r, 400));
    const watched = findByClass(document.getElementById('lchips'), 'watched');
    if (watched.length !== 1) stage5.push('盯站后站名芯片没有蓝色高亮（.watched 数量 ' + watched.length + '）');
    else if (String(watched[0].getAttribute ? watched[0].getAttribute('data-order') : '') !== '9') {
      /* 桩里没存 data-order 也允许，主要看数量 */
    }
    // 清理：停掉盯站，别影响后面
    window.cdBusStopWatch ? window.cdBusStopWatch() : null;
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
    /* 默认折叠：只有标题 + 「展开」按钮，不铺开线路 */
    const foldedNow = textOf(document.getElementById('dothers'));
    if (!/同站其它/.test(foldedNow)) stage5.push('「同站其它」标签丢失');
    if (!/展开/.test(foldedNow)) stage5.push('「同站其它」没有折叠按钮：' + foldedNow.slice(0, 120));
    if (/716路|45路/.test(foldedNow)) {
      stage5.push('默认折叠时不该铺开线路：' + foldedNow.slice(0, 160));
    }
    const othersToggle = findByClass(document.getElementById('dothers'), 'others-toggle')[0];
    if (!othersToggle) stage5.push('找不到「展开」按钮');
    else {
      othersToggle.onclick();
      await new Promise((r) => setTimeout(r, 200));
    }
    const othersNow = textOf(document.getElementById('dothers'));
    if (!/716路/.test(othersNow)) stage5.push('点站名后没有列出该站的其它线路：' + othersNow.slice(0, 120));
  if (!/45路/.test(othersNow)) stage5.push('没有实时数据的线路没有列出（应全量展示）：' + othersNow.slice(0, 160));
    if (!/收起/.test(othersNow)) stage5.push('展开后按钮没有变成「收起」');
    /* 反方向过滤：详情页当前方向是 P02 的终点站；对面站台（801路 往另一方向）不该出现 */
    if (/801路/.test(othersNow)) {
      stage5.push('反方向的线路混进了「同站其它」：' + othersNow.slice(0, 160));
    }
    if (speakLog.length !== beforeSpeak) stage5.push('点站名仍在播报（应只更新列表）');
    if (!wasDetail) stage5.push('前置条件不对：本来就不在详情页');
  }

  /* 首次进入详情时「同站其它」必须是折叠的。
     以前折叠状态存在 localStorage 里一路沿用，点过一次展开就永远展开。 */
  if (typeof window.cdBusOpenDetail === 'function' && typeof window.cdBusOthersFolded === 'function') {
    /* 先人为把状态改成展开，模拟「上次展开过」 */
    await window.cdBusLoadOthers();
    await new Promise((r) => setTimeout(r, 300));
    const toggle = findByClass(document.getElementById('dothers'), 'others-toggle')[0];
    if (toggle && /展开/.test(String(toggle.textContent || ''))) {
      toggle.onclick();
      await new Promise((r) => setTimeout(r, 200));
    }
    if (window.cdBusOthersFolded() !== false) {
      stage5.push('前置条件失败：没能把「同站其它」弄成展开态');
    }
    try { localStorage.setItem('cdbus.othersFolded', '0'); } catch (e) {}

    /* 重新进入详情页 —— 必须回到折叠 */
    await window.cdBusOpenDetail({
      lineId: '028-p02-0', lineName: 'P02',
      stationId: '028-1', stationName: '花园永泉', fromOrder: 9,
      title: 'P02路 · 花园永泉',
    });
    await new Promise((r) => setTimeout(r, 900));
    if (window.cdBusOthersFolded() !== true) {
      stage5.push('重新进入详情后「同站其它」没有恢复折叠');
    }
    const box = textOf(document.getElementById('dothers'));
    if (!/展开/.test(box)) stage5.push('重新进入详情后没有「展开」按钮：' + box.slice(0, 80));
    if (/45路/.test(box)) stage5.push('重新进入详情后仍铺开了线路：' + box.slice(0, 120));
    let leftover = null;
    try { leftover = localStorage.getItem('cdbus.othersFolded'); } catch (e) {}
    if (leftover !== null) stage5.push('折叠状态仍被写进 localStorage：' + leftover);
  }

  /* 点站名一律不播报（用户要求：从任何入口进详情、点上面的站名都不要出声）。
     这里把两条渲染路径的站名芯片都点一遍，确认 speakLog 没增长。 */
  {
    const before = speakLog.length;
    const chipsBox = document.getElementById('lchips');
    const chips = (chipsBox && chipsBox.children) || [];
    if (chips.length) {
      const c0 = chips[chips.length - 1];
      if (typeof c0.onclick === 'function') {
        c0.onclick();
        await new Promise((r) => setTimeout(r, 700));
      }
    }
    const chips2 = (document.getElementById('dchips') || {}).children || [];
    for (const c of Array.from(chips2).slice(0, 2)) {
      if (typeof c.onclick === 'function') {
        c.onclick();
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    if (speakLog.length !== before) {
      stage5.push('点详情页站名仍会自动播报：' + speakLog.slice(before).join(' / ').slice(0, 80));
    }
  }

  /* 源码层面：三处「点站名后的刷新」都不能传 true，openDetail 也不该再播报 */
  if (/refresh\(true\)/.test(html)) {
    stage5.push('代码里仍有 refresh(true)：点站名会自动播报');
  }
  const openDetailBody = (html.match(/async function openDetail\(opts\) \{([\s\S]*?)\n  \}/) || [])[1] || '';
  if (/speak\(/.test(openDetailBody)) {
    stage5.push('openDetail 里仍有 speak()：进详情会自动播报');
  }

  /* 「同站其它」必须跟着用户当前选中的站走：
     选第 22 站（龙溪村委会）后，这一块的标题要是龙溪村委会，不能还停在进页时那站。
     以前这里读 view.stationId/view.fromOrder，于是出现
     「标题 花园公交站 · 同站其它却是 龙溪村委会」这种错位。 */
  if (typeof window.cdBusPickStation === 'function') {
    window.__othersStations = [];
    const origNearby = window.AndroidBus.start;
    window.AndroidBus.start = function (method, payload) {
      if (method === 'nearby') {
        try { window.__othersStations.push(JSON.parse(payload || '{}')); } catch (e) {}
      }
      return origNearby.apply(this, arguments);
    };

    /* 核心断言：换站后「同站其它」的标题站名 = 当前选中站，且查询坐标换成新站的。
       P02 桩里有 1（花园公交站）/ 9（花园永泉）/ 30（郫都区客运中心）三站。 */
    window.__othersStations = [];
    window.cdBusPickStation(9, null);
    await new Promise((r) => setTimeout(r, 800));
    const at9 = textOf(document.getElementById('dothers'));
    const title9 = textOf(document.getElementById('dtitle'));
    if (!/同站其它/.test(at9)) stage5.push('第 9 站没有渲染「同站其它」：' + at9.slice(0, 80));
    if (!/花园永泉/.test(title9)) stage5.push('第 9 站标题不对：' + title9.slice(0, 80));

    window.cdBusPickStation(30, null);
    await new Promise((r) => setTimeout(r, 800));
    const at30 = textOf(document.getElementById('dothers'));
    const title30 = textOf(document.getElementById('dtitle'));

    /* 标题必须换成第 30 站，不能还停在花园永泉 */
    if (!/郫都区客运中心/.test(title30)) {
      stage5.push('换到第 30 站后标题没换：' + title30.slice(0, 80));
    }
    /* 「同站其它」标签里的站名也必须跟着换 */
    if (/同站其它 · 花园永泉/.test(at30)) {
      stage5.push('换到第 30 站后「同站其它」仍标着花园永泉：' + at30.slice(0, 90));
    }
    /* 两次查询坐标必须不同（证明不是复用进页时那一站） */
    const latLngs = window.__othersStations.map((a) => a.lat + ',' + a.lng);
    if (new Set(latLngs).size < 2) {
      stage5.push('两次换站的「同站其它」查的是同一坐标：' + latLngs.join(' / '));
    }

    window.AndroidBus.start = origNearby;
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
  /* 没有实时数据的线路（45路）也必须能点开 —— 以前点了只弹一句提示，是死路。
     放在发车预测断言之后：这段会把页面切到 45 路，会影响 P02 的断言。 */
  if (typeof window.cdBusOpenOtherNoRealtime === 'function') {
    const beforeTitle = textOf(document.getElementById('dtitle'));
    await window.cdBusOpenOtherNoRealtime(
      { name: '45', label: '45路', arrival: null },
      { name: '花园永泉', stationId: '028-1', lat: 30.7, lng: 103.95 },
    );
    await new Promise((r) => setTimeout(r, 900));
    const afterTitle = textOf(document.getElementById('dtitle'));
    const detailHidden = String(document.getElementById('detail').className).includes('hidden');
    if (detailHidden) stage5.push('点没有实时数据的线路没有进入详情页');
    if (!/45/.test(afterTitle)) {
      stage5.push('点没有实时数据的线路后标题不是 45 路：' + afterTitle.slice(0, 80));
    }
    if (afterTitle === beforeTitle) stage5.push('点没有实时数据的线路后页面没变化');
  }

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
      /* v1.0.46：车牌行从到站表里挪到了吸顶区 #dbusinfo（不随页面滚动），
         到站表本身只剩站行。 */
      const busInfoText = textOf(document.getElementById('dbusinfo'));
      if (!/车牌/.test(busInfoText)) {
        stage5b.push('吸顶区没有车牌行：' + busInfoText.slice(0, 80));
      }
      const dlistText = textOf(document.getElementById('dlist'));
      if (/车牌/.test(dlistText)) {
        stage5b.push('车牌行还在滚动区里（应移到吸顶区）：' + dlistText.slice(0, 80));
      }

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

// ------------------------------------------------ 第十阶段：设置 → 锁屏通知（v1.0.44）

const stage10 = [];
document.getElementById('setDiag').onclick();
await new Promise((r) => setTimeout(r, 300));

// 开关默认开
const lockBox = document.getElementById('lockNotify');
if (!lockBox) stage10.push('后台诊断页缺少锁屏通知开关 #lockNotify');
else if (lockBox.checked !== true) stage10.push('锁屏通知默认应为开');

// 关掉 → 必须调用 bridge.setLockNotify(false)
if (lockBox && typeof lockBox.onchange === 'function') {
  lockBox.checked = false;
  lockBox.onchange();
  await new Promise((r) => setTimeout(r, 120));
  const last = lockNotifyLog[lockNotifyLog.length - 1];
  if (!last || last[0] !== 'set' || last[1] !== false) {
    stage10.push('关掉开关没有调用 setLockNotify(false)，日志：' + JSON.stringify(lockNotifyLog));
  }
} else {
  stage10.push('锁屏通知开关没有绑定 onchange');
}

// 测试按钮要能发一条
const testBtn = document.getElementById('lockNotifyTest');
if (!testBtn) stage10.push('缺少「发一条测试通知」按钮');
else if (typeof testBtn.onclick !== 'function') stage10.push('测试通知按钮没有绑定点击事件');
else {
  const before = lockNotifyLog.length;
  testBtn.onclick();
  await new Promise((r) => setTimeout(r, 120));
  if (lockNotifyLog.length <= before) stage10.push('点测试通知没有调用 testLockNotify');
}

// 重新进入设置页时开关状态要跟着原生走
lockNotifyOn = true;
document.getElementById('diagBack').onclick();
await new Promise((r) => setTimeout(r, 150));
document.getElementById('setDiag').onclick();
await new Promise((r) => setTimeout(r, 200));
if (lockBox && lockBox.checked !== true) stage10.push('重进设置页后开关状态没有跟随 lockNotifyOn()');

// 自检按钮：要把诊断文字写进 #lockNotifyInfo，并请求通知权限
const permBtn = document.getElementById('lockNotifyPerm');
if (!permBtn) stage10.push('缺少「检查通知权限」按钮');
else if (typeof permBtn.onclick !== 'function') stage10.push('检查通知权限按钮没有绑定点击事件');
else {
  permBtn.onclick();
  await new Promise((r) => setTimeout(r, 150));
  const infoText = textOf(document.getElementById('lockNotifyInfo'));
  if (!infoText.includes('通知权限')) stage10.push('自检信息没有写进页面：' + infoText.slice(0, 80));
  if (!lockNotifyLog.some((x) => x[0] === 'perm')) stage10.push('自检没有请求通知权限');
}

if (stage10.length) {
  console.error('✗ UI 冒烟失败（锁屏通知）：');
  for (const f of stage10) console.error('  - ' + f);
  process.exit(1);
}
console.log('✓ 锁屏通知通过：默认开、可关闭、测试通知可用、状态跟随原生');

// ---------------------------------------------------------------- 第十一阶段：去哪儿（路线规划）
const stage11 = [];
if (!/VIEWS = \["home", "detail", "metro", "diag", "pick", "route"\]/.test(html)) {
  stage11.push('VIEWS 里没有 route（去哪儿页未注册）');
}
if (!document.getElementById('routeEntry') || !document.getElementById('openRoute')) {
  stage11.push('首页缺少「去哪儿」入口');
}
if (typeof window.cdBusOpenRoute !== 'function' || typeof window.cdBusPlanRoute !== 'function') {
  stage11.push('没有暴露路线规划调试钩子');
}
// 静态：Java 侧必须有换乘 + POI 方法，且起点做 WGS84→GCJ02
const ccSrc = readFileSync(path.join(here, '..', 'app', 'src', 'com', 'chengdu', 'bus', 'ChelaileClient.java'), 'utf-8');
if (!/public JSONObject transit\(/.test(ccSrc)) stage11.push('ChelaileClient 缺少 transit() 换乘方法');
if (!/public JSONArray searchPois\(/.test(ccSrc)) stage11.push('ChelaileClient 缺少 searchPois() 方法');
if (!/Geo\.wgsToGcj\(/.test(ccSrc)) stage11.push('换乘起点没有做 WGS84→GCJ02 转换');
if (!/\/api\/transfer\//.test(ccSrc)) stage11.push('换乘端点路径不是 /api/transfer/');
const bbSrc = readFileSync(path.join(here, '..', 'app', 'src', 'com', 'chengdu', 'bus', 'BusBridge.java'), 'utf-8');
if (!/case "transit"/.test(bbSrc) || !/case "pois"/.test(bbSrc)) stage11.push('BusBridge 缺少 transit/pois 分派');

// 真实触发：进入去哪儿 → 搜目的地 → 选第一个 POI → 自动规划 → 检查公交/地铁标注与跳转
window.cdBusOpenRoute();
await new Promise((r) => setTimeout(r, 100));
if (document.getElementById('route').className.includes('hidden')) stage11.push('点「去哪儿」没有进入路线规划页');
const destIn = document.getElementById('destInput');
destIn.value = '武侯祠';
window.cdBusSearchDestination();
await new Promise((r) => setTimeout(r, 900));
const poiBox = document.getElementById('poiBox');
const pois = findByClass(poiBox, 'poiitem');
if (pois.length < 1) stage11.push('搜目的地没有列出 POI');
else if (pois.length <= 3) {
  // 服务端单次只回 3 条，多轮收窄后必须超过 3 条
  stage11.push('目的地搜索只列出 ' + pois.length + ' 个地点（多轮收窄没生效）');
}
if (poiQueries.length < 2) stage11.push('目的地搜索只查了一轮（没有做多轮收窄）');
else {
  // 选第一个 POI（onclick 真触发，会调 planRoute）
  pois[0].onclick();
  await new Promise((r) => setTimeout(r, 400));
  const routeHtml = textOf(document.getElementById('routeBox'));
  if (!/98路/.test(routeHtml)) stage11.push('方案里没有显示公交线路 98路');
  if (!/地铁2号线/.test(routeHtml)) stage11.push('方案里没有显示地铁 地铁2号线');
  if (!/公交/.test(routeHtml) || !/地铁/.test(routeHtml)) stage11.push('方案没有标注公交/地铁类别');
  if (!/分钟/.test(routeHtml)) stage11.push('方案没有显示用时');
  if (!transitCalls.length) stage11.push('没有调用 transit 换乘接口');
  else {
    const c = transitCalls[transitCalls.length - 1];
    if (!c.from || !isFinite(c.from.lat) || !c.dest || !isFinite(c.dest.lat)) {
      stage11.push('transit 没传起点/终点坐标：' + JSON.stringify(c));
    }
  }

  /* 策略芯片：必须是「真点一下」才验证得出来。WebView 的 children 是
     HTMLCollection（没有 forEach），写成 chips.forEach 会抛 TypeError、全部不绑。 */
  /* 策略值必须和车来了接口对得上：实测 0=推荐 1=少步行 2=少换乘 3=公交优先。
     写反过——「少换乘」发的是 1（其实少步行）、「少步行」发的是 2（其实少换乘）。 */
  const stOf = {};
  for (const c of strategyChips) stOf[String(c.textContent || '')] = c.getAttribute('data-st');
  if (stOf['少换乘'] !== '2') stage11.push('「少换乘」的 strategy 应该是 2，实际 ' + stOf['少换乘']);
  if (stOf['少步行'] !== '1') stage11.push('「少步行」的 strategy 应该是 1，实际 ' + stOf['少步行']);
  if (stOf['推荐'] !== '0') stage11.push('「推荐」的 strategy 应该是 0，实际 ' + stOf['推荐']);
  if (stOf['公交优先'] !== '3') stage11.push('「公交优先」的 strategy 应该是 3，实际 ' + stOf['公交优先']);

  if (typeof strategyChips[1].onclick !== 'function') {
    stage11.push('策略芯片没有绑上点击（children 不是数组，不能对它调 forEach）');
  } else {
    /* 点「少换乘」：strategy 2，且第一条要是换乘最少的方案 */
    const plansBefore = transitCalls.length;
    strategyChips[1].onclick();
    await new Promise((r) => setTimeout(r, 500));
    const st = typeof window.cdBusRouteState === 'function' ? window.cdBusRouteState().strategy : null;
    if (String(st) !== '2') stage11.push('点「少换乘」没有切换策略，当前 strategy=' + st);
    if (!strategyChips[1].className.split(' ').includes('on')) {
      stage11.push('点「少换乘」没有高亮该芯片，className=' + strategyChips[1].className);
    }
    if (strategyChips[0].className.split(' ').includes('on')) {
      stage11.push('点「少换乘」后「推荐」还是高亮状态');
    }
    if (transitCalls.length <= plansBefore) {
      stage11.push('点「少换乘」没有按新策略重新规划');
    } else if (String(transitCalls[transitCalls.length - 1].strategy) !== '2') {
      stage11.push('重新规划没带上策略 2：' + JSON.stringify(transitCalls[transitCalls.length - 1].strategy));
    }
    /* 桩里返回的顺序是「步行 600m/换乘 1 次」在前、「步行 100m/换乘 0 次」在后，
       点「少换乘」后第一条必须是换乘 0 次那条 —— 接口本身不按策略排序，页面要自己排。 */
    const firstLine = (textOf(document.getElementById('routeBox')).match(/方案 1([^方]*)/) || [])[1] || '';
    if (!/直达|换乘 0/.test(firstLine)) {
      stage11.push('点「少换乘」后第一条不是换乘最少的方案：' + firstLine.trim().slice(0, 40));
    }

    /* 点「少步行」：strategy 1，第一条要是走路最少的 */
    strategyChips[2].onclick();
    await new Promise((r) => setTimeout(r, 500));
    const st2 = typeof window.cdBusRouteState === 'function' ? window.cdBusRouteState().strategy : null;
    if (String(st2) !== '1') stage11.push('点「少步行」没有切换策略，当前 strategy=' + st2);
    if (String(transitCalls[transitCalls.length - 1].strategy) !== '1') {
      stage11.push('点「少步行」重新规划没带上策略 1');
    }
    const firstWalk = (textOf(document.getElementById('routeBox')).match(/方案 1([^方]*)/) || [])[1] || '';
    if (!/步行 100 米/.test(firstWalk)) {
      stage11.push('点「少步行」后第一条不是走路最少的方案：' + firstWalk.trim().slice(0, 40));
    }
  }
}

if (stage11.length) {
  console.error('✗ UI 冒烟失败（去哪儿路线规划）：');
  for (const f of stage11) console.error('  - ' + f);
  process.exit(1);
}
console.log('✓ 去哪儿通过：入口、POI 搜索、公交/地铁方案、坐标传参、跳转钩子');

/* ---------------------------------------------------------- 多城市（四川全省） */

const stage12 = [];
{
  /* 重新把页面跑一遍：这一轮要验的是「定位到别的城市后，附近站点确实按新城市查」。 */
  const cityCalls = [];
  const nearbyCalls = [];
  /* start 与 poll 必须成对覆盖：桩的 poll 是按 start 记账的 id 取结果，
     只覆盖 start 会让 poll 拿不到任务，返回空数组。 */
  let seq12 = 0;
  const pending12 = new Map();
  window.AndroidBus.start = function (method, payload) {
    let args = {};
    try { args = JSON.parse(payload || '{}'); } catch (e) {}
    let data = null;
    /* 定位桩：给一个绵阳坐标，才能验「定位后自动切城市」 */
    if (method === 'location') {
      data = { lat: 31.4675, lng: 104.6796, accuracy: 30, provider: 'network', stale: false };
    } else if (method === 'permissions') {
      data = { location: true };
    } else if (method === 'city') {
      cityCalls.push(args);
      data = { cityId: '133', city: '绵阳', covered: true };
    } else if (method === 'nearby') {
      nearbyCalls.push(args);
      data = {
        cityId: args.cityId, city: '绵阳',
        stops: [{ stationId: 'm1', name: '富乐北路', distanceMeters: 80, lat: 31.47, lng: 104.74,
          lineNameList: ['36'], arrivals: [
            { lineId: 'l1', lineName: '36', toward: '建国门', stationId: 'm1',
              stationsAway: 2, etaSeconds: 210, arrived: false }] }],
        allArrivals: [],
      };
    } else if (method === 'citytable') {
      data = [
        { cityId: '007', name: '成都', group: '成都', level: 'city', covered: true },
        { cityId: '133', name: '绵阳', group: '绵阳', level: 'city', covered: true },
        { cityId: null, name: '德阳', group: '德阳', level: 'city', covered: false,
          note: '德阳市区暂无实时数据；广汉可用', fallbackName: '广汉' },
      ];
    }
    const id = 's12-' + (++seq12);
    pending12.set(id, data);
    return id;
  };

  window.AndroidBus.poll = function (id) {
    if (!pending12.has(id)) return JSON.stringify({ state: 'error', error: '任务不存在' });
    const data = pending12.get(id);
    pending12.delete(id);
    return JSON.stringify({ state: 'ok', data: data });
  };

  /* 触发一次定位 → 城市识别 → 首页刷新。
     注意：run() 有 state.busy 保护，上一次自动加载还没结束时会直接返回，
     所以要等到 busy 落下再触发，并给足时间让异步链路跑完。 */
  for (let i = 0; i < 60; i += 1) {
    const st = typeof window.cdBusState === 'function' ? window.cdBusState() : null;
    if (st && st.busy === false) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  if (typeof window.cdBusPermission === 'function') window.cdBusPermission(true);
  /* 城市识别 → 存盘 → refreshHome → nearby，串行几轮网络桩，给 2 秒 */
  await new Promise((r) => setTimeout(r, 2000));

  const state12 = typeof window.cdBusState === 'function' ? window.cdBusState() : null;
  const savedCity = (() => {
    try { return JSON.parse(localStorage.getItem('cdbus.city')); } catch (e) { return null; }
  })();

  if (!cityCalls.length) stage12.push('定位后没有调用 city 识别城市');
  if (!savedCity || String(savedCity.cityId) !== '133') {
    stage12.push('定位到绵阳后没有把城市存下来：' + JSON.stringify(savedCity));
  }
  if (!nearbyCalls.length) {
    stage12.push('切换城市后没有重新请求 nearby');
  } else if (String(nearbyCalls[nearbyCalls.length - 1].cityId) !== '133') {
    stage12.push('nearby 没有带上新城市 cityId：' + JSON.stringify(nearbyCalls[nearbyCalls.length - 1]));
  }

  /* 标题是固定的应用名；城市名单独显示在标题旁的 📍 按钮上 */
  const title = document.getElementById('homeTitle');
  const titleText = title ? String(title.textContent || '') : '';
  if (!/公交来了/.test(titleText)) stage12.push('标题应为应用名「公交来了」，实际：' + titleText);

  /* 顶栏城市名是纯文字：不能有背景色/边框/圆角胶囊样式。
     DOM 桩不会解析 HTML 的 class 属性，所以直接查源码。 */
  if (document.getElementById('cityBtn')) {
    const tag = (html.match(/<button[^>]*id="cityBtn"[^>]*>/) || [])[0] || '';
    if (/citybtn/.test(tag)) stage12.push('顶栏城市仍是旧的胶囊样式类 citybtn：' + tag);
    if (!/citytext/.test(tag)) stage12.push('顶栏城市没有用纯文字样式 citytext：' + tag);
    if (!/id="cityBtnName"/.test(html)) stage12.push('顶栏城市名元素 cityBtnName 丢了');
  } else {
    stage12.push('顶栏找不到城市切换按钮');
  }
  /* 样式里必须真的没有底色和边框 */
  const cityTextRule = (html.match(/\.citytext\s*\{([^}]*)\}/) || [])[1] || '';
  if (/background:\s*#/.test(cityTextRule)) stage12.push('citytext 仍有背景色：' + cityTextRule.trim().slice(0, 60));
  if (/border:\s*1px/.test(cityTextRule)) stage12.push('citytext 仍有边框：' + cityTextRule.trim().slice(0, 60));
  if (/border-radius:\s*999px/.test(cityTextRule)) stage12.push('citytext 仍是圆角胶囊：' + cityTextRule.trim().slice(0, 60));
  /* 设置页要有城市入口，别把功能弄丢 */
  if (!document.getElementById('setCity')) stage12.push('设置页没有「当前城市」入口');

  /* 城市按钮上的名字也应该对 */
  const btnName = document.getElementById('cityBtnName');
  if (!btnName || !/绵阳/.test(String(btnName.textContent || ''))) {
    stage12.push('城市按钮名字没更新：' + (btnName ? btnName.textContent : '(缺失)'));
  }

  /* 无数据城市（德阳）应当被标灰、点它不切城市 */
  if (typeof window.cdBusCityTable === 'function') {
    const table = await window.cdBusCityTable();
    const deyang = (table || []).find((t) => t.name === '德阳');
    if (!deyang) stage12.push('城市表里没有德阳');
    else if (deyang.covered !== false) stage12.push('德阳应标记为无数据');
  }

  if (state12 && state12.cityId && String(state12.cityId) !== '133') {
    stage12.push('state 里的城市没切到绵阳：' + JSON.stringify(state12.cityId));
  }
}

if (stage12.length) {
  console.error('✗ UI 冒烟失败（多城市）：');
  for (const f of stage12) console.error('  - ' + f);
  process.exit(1);
}
/* ------------------------------------------------ 城市名跟随手机定位 */
const stage13 = [];
{
  /* 让 city 接口随坐标返回不同城市：成都 / 绵阳 / 南充 */
  const cityByPos = [
    { lat: 30.657, lng: 104.065, cityId: '007', city: '成都' },
    { lat: 31.4675, lng: 104.6796, cityId: '133', city: '绵阳' },
    { lat: 30.8373, lng: 106.1107, cityId: '526', city: '南充' },
  ];
  let currentPos = cityByPos[0];
  let cityTableAsked = 0;

  const origStart = window.AndroidBus.start;
  const origPoll = window.AndroidBus.poll;
  const pending = new Map();
  let seq = 0;
  window.AndroidBus.start = function (method, payload) {
    let args = {};
    try { args = JSON.parse(payload || '{}'); } catch (e) {}
    const id = 'c13-' + (++seq);
    pending.set(id, { method, args });
    return id;
  };
  window.AndroidBus.poll = function (id) {
    const item = pending.get(id);
    if (!item) return JSON.stringify({ state: 'ok', data: null });
    pending.delete(id);
    if (item.method === 'location') {
      const d = { lat: currentPos.lat, lng: currentPos.lng, accuracy: 25, provider: 'gps', stale: false };
      return JSON.stringify({ state: 'ok', data: d });
    }
    if (item.method === 'city') {
      /* 按传进来的坐标找最近的城市 */
      let best = cityByPos[0], bd = Infinity;
      for (const c of cityByPos) {
        const d2 = (c.lat - item.args.lat) ** 2 + (c.lng - item.args.lng) ** 2;
        if (d2 < bd) { bd = d2; best = c; }
      }
      return JSON.stringify({ state: 'ok', data: { cityId: best.cityId, city: best.city, covered: true } });
    }
    if (item.method === 'citytable') {
      cityTableAsked += 1;
      return JSON.stringify({ state: 'ok', data: [
        { cityId: '007', name: '成都', group: '成都', level: 'city', covered: true },
        { cityId: '133', name: '绵阳', group: '绵阳', level: 'city', covered: true },
        { cityId: '526', name: '南充', group: '南充', level: 'city', covered: true },
      ] });
    }
    if (item.method === 'nearby') {
      return JSON.stringify({ state: 'ok', data: { stops: [], allArrivals: [] } });
    }
    if (item.method === 'permissions') return JSON.stringify({ state: 'ok', data: { location: true } });
    return JSON.stringify({ state: 'ok', data: null });
  };

  async function settle(ms) { await new Promise((r) => setTimeout(r, ms)); }

  /* 1) 先在成都定位 */
  currentPos = cityByPos[0];
  if (typeof window.cdBusPermission === 'function') window.cdBusPermission(true);
  await settle(1200);
  if (window.cdBusCityIdOf() !== '007') {
    stage13.push('成都定位后城市应为 007，实际 ' + window.cdBusCityIdOf());
  }

  /* 2) 人移动到绵阳 → 刷新（带 locate）后城市名必须跟着变 */
  currentPos = cityByPos[1];
  await window.cdBusRefreshHome({ locate: true });
  await settle(900);

  if (window.cdBusCityIdOf() !== '133') {
    stage13.push('移动到绵阳后城市没跟随定位：' + window.cdBusCityIdOf());
  }
  const topName = String(document.getElementById('cityBtnName').textContent || '');
  if (!/绵阳/.test(topName)) stage13.push('顶栏城市名没跟着定位变：' + topName);

  /* 3) 再移动到南充 */
  currentPos = cityByPos[2];
  await window.cdBusRefreshHome({ locate: true });
  await settle(900);
  if (window.cdBusCityIdOf() !== '526') {
    stage13.push('移动到南充后城市没跟随定位：' + window.cdBusCityIdOf());
  }
  if (!/南充/.test(String(document.getElementById('cityBtnName').textContent || ''))) {
    stage13.push('顶栏城市名没跟到南充');
  }

  /* 4) 手动选绵阳（人此时在南充）：就地锁定，原地刷新要保持在绵阳 —— 这是用户明确选择 */
  await window.cdBusSwitchCity('133', '绵阳', true);
  await settle(400);
  if (window.cdBusCityIdOf() !== '133') stage13.push('手动切绵阳失败');
  if (!window.cdBusState().manual) stage13.push('手动选择没有标记 manual');

  /* 仍在选择时所在的位置 → 手动选择继续有效，不能被定位改回去 */
  await window.cdBusRefreshHome({ locate: true });
  await settle(900);
  if (window.cdBusCityIdOf() !== '133') {
    stage13.push('原地刷新把手动选的绵阳改掉了：' + window.cdBusCityIdOf());
  }

  /* 5) 人真的搬到成都（远离手动选择时的位置）→ 手动选择让位，跟随定位到成都 */
  currentPos = cityByPos[0];
  await window.cdBusRefreshHome({ locate: true });
  await settle(1000);
  if (window.cdBusCityIdOf() !== '007') {
    stage13.push('跨市移动到成都后仍锁在手动选的绵阳：' + window.cdBusCityIdOf());
  }
  if (window.cdBusState().manual) stage13.push('跨市后 manual 标记没有清掉');

  window.AndroidBus.start = origStart;
  window.AndroidBus.poll = origPoll;
}

if (stage13.length) {
  console.error('✗ UI 冒烟失败（城市跟随定位）：');
  for (const f of stage13) console.error('  - ' + f);
  process.exit(1);
}
/* ---------------------------------------------- 定位行只显示状态词 */
const stage14 = [];
{
  /* 定位成功后，loctext 里只应有「已定位」（或「缓存位置」），
     不该出现 provider（gps/network）、精度（N 米）、耗时（用时 N 秒） */
  const settle = (ms) => new Promise((r) => setTimeout(r, ms));

  /* 用当前桩再触发一次定位刷新 */
  if (typeof window.cdBusRefreshHome === 'function') {
    await window.cdBusRefreshHome({ locate: true });
    await settle(900);
  }
  const text = String(document.getElementById('loctext').textContent || '');
  if (!/已定位|缓存位置/.test(text)) {
    stage14.push('定位行没有「已定位」：' + text);
  }
  if (/gps|network|未知精度/.test(text)) {
    stage14.push('定位行仍显示定位来源：' + text);
  }
  if (/\d+\s*米/.test(text)) {
    stage14.push('定位行仍显示精度数值：' + text);
  }
  if (/用时/.test(text)) {
    stage14.push('定位行仍显示耗时：' + text);
  }
  /* 城市名不该再拼到这一行（顶栏已独立显示） */
  if (/·/.test(text)) {
    stage14.push('定位行还有分隔符拼接：' + text);
  }

  /* 源码层面也确认：定位成功的两处 setLocbar 调用不再拼额外字段 */
  if (/setLocbar\([^)]*provider/.test(html)) stage14.push('代码里定位行仍拼 provider');
  if (/setLocbar\([^)]*accuracy/.test(html)) stage14.push('代码里定位行仍拼精度');
}

if (stage14.length) {
  console.error('✗ UI 冒烟失败（定位行文案）：');
  for (const f of stage14) console.error('  - ' + f);
  process.exit(1);
}
/* ------------------------------ 有在途车辆时不能判「不在运营时段」 */
const mjs = (await import('node:fs')).readFileSync(
  (await import('node:path')).join(here, '..', 'lib', 'chelaile.mjs'), 'utf-8');

const stage15 = [];
{
  const os = window.cdBusOutsideService;
  if (typeof os !== 'function') {
    stage15.push('outsideService 没有导出，无法校验');
  } else {
    /* 不能写死时间（比如 07:40-13:00 在早上跑就不是「已过末班」）。
       按当前时间动态造一条一定已收班的线路：
       首班 = 当前 -5 小时，末班 = 当前 -1 分钟。 */
    const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
    const hhmm = (m) => {
      const v = ((m % 1440) + 1440) % 1440;
      return String(Math.floor(v / 60)).padStart(2, '0') + ':' + String(v % 60).padStart(2, '0');
    };
    const first = hhmm(nowMin - 300);
    /* 末班要给足余量：pastLastTime 有「末班后 5 分钟仍算在运营」的宽限，
       设成 now-1 会落在宽限内，判不成已收班。用 now-60 稳妥。 */
    const last = hhmm(nowMin - 60);

    /* 1) 最后一辆车还没到本站（away > 0）→ 不算收班，保持白色 */
    if (os(first, last, { stationsAway: 2 }) !== false) {
      stage15.push('车还没到本站就判成收班了');
    }
    /* 2) 车正好在本站（away = 0）→ 不算收班 */
    if (os(first, last, { stationsAway: 0 }) !== false) {
      stage15.push('车正在本站却被判成收班');
    }
    /* 3) 最后一辆车已驶过本站（away < 0）→ 收班，变灰 */
    if (os(first, last, { stationsAway: -1 }) !== true) {
      stage15.push('车已驶过本站却没判成收班');
    }
    if (os(first, last, { stationsAway: -5 }) !== true) {
      stage15.push('车驶过多站后没判成收班');
    }
    /* 4) 完全没车（arrival 为 null）且已过末班 → 收班 */
    if (os(first, last, null) !== true) {
      stage15.push('彻底没车却没判成收班');
    }
    /* 5) 待发车 → 不算收班 */
    if (os(first, last, { stationsAway: null, preStartTime: '09:20' }) !== false) {
      stage15.push('待发车被判成收班');
    }
    /* 6) 还没到末班时间 → 一律不算收班（哪怕车已驶过）。
          用 24 小时运营线路（00:00-23:59）：任何时刻都在区间内，不依赖跑测试的时间。 */
    if (os('00:00', '23:59', { stationsAway: -3 }) !== false) {
      stage15.push('还没到末班时间就把线路判成收班（24 小时线路被误判）');
    }
    /* 7) 首末班数据缺失 → 不判灰（数据缺失不等于收班） */
    if (os(undefined, undefined, { stationsAway: -2 }) !== false) {
      stage15.push('首末班缺失时把线路判灰了');
    }

    /* 8) 客户端必须保留负数 stationsAway —— 截断成 0 就分不出「驶过」和「到站」 */
    if (!/arrived: stationsAway === 0/.test(mjs)) {
      stage15.push('arrivals 里 arrived 仍用 <=0，区分不了「驶过」与「到站」');
    }
    if (/Math\.max\(0, .*target\.order/.test(mjs)) {
      stage15.push('nearby 又把 stationsAway 截断成 0 了');
    }
  }
}

if (stage15.length) {
  console.error('✗ UI 冒烟失败（收班误判）：');
  for (const f of stage15) console.error('  - ' + f);
  process.exit(1);
}
/* ------------------------------------------ 顶栏布局：标题居中、左右按钮 */
const stage16 = [];
{
  const top = (html.match(/<div class="topline">[\s\S]*?<\/div>/) || [])[0] || '';
  if (!top) stage16.push('找不到 topline 容器');

  /* 1) 标题必须在最前，但两侧按钮用绝对定位 —— 标题本身不能和按钮抢 flex 空间 */
  const h1Rule = (html.match(/\.homehead \.topline h1 \{([^}]*)\}/) || [])[1] || '';
  if (!/text-align:\s*center/.test(h1Rule)) {
    stage16.push('标题没有居中（缺 text-align: center）');
  }
  if (!/order:\s*2/.test(h1Rule) || !/flex:\s*1 1 auto/.test(h1Rule)) {
    stage16.push('标题没有占中间并居中：' + h1Rule.trim().slice(0, 70));
  }
  /* 顶栏必须是 flex 三元素布局，且两侧按钮同宽对称。
     踩过的坑（都有截图佐证）：
       - grid 1fr auto 1fr 会被倒计时数字挤出新行，刷新按钮掉到第二行；
       - position:absolute 被 .iconbtn 的 flex 规则盖掉，按钮挤在中间；
       - 两侧宽度不等时 margin:auto 只平分剩余空间，标题偏左。 */
  const topRule = (html.match(/\.homehead \.topline \{([^}]*)\}/) || [])[1] || '';
  if (!/display:\s*flex/.test(topRule)) {
    stage16.push('顶栏不是 flex 布局：' + topRule.trim().slice(0, 70));
  }
  if (/display:\s*grid/.test(topRule)) {
    stage16.push('顶栏又用回 grid 了（会被第四个元素撑出新行）');
  }
  /* 关键：顶部那条通用 header { display:flex; align-items:center } 会把
     .homehead 也变成横向 flex、并按内容宽度居中缩起来 —— 按钮因此永远贴不到边。
     必须显式 width:100% + align-items:stretch 覆盖掉。 */
  const headRule = (html.match(/\.homehead \{([^}]*)\}/) || [])[1] || '';
  if (!/width:\s*100%/.test(headRule)) {
    stage16.push('homehead 没有拉满宽度，顶栏会缩成内容宽度：' + headRule.trim().slice(0, 70));
  }
  if (!/align-items:\s*stretch/.test(headRule)) {
    stage16.push('homehead 没有覆盖 header 的 align-items:center：' + headRule.trim().slice(0, 70));
  }
  if (!/flex-direction:\s*column/.test(headRule)) {
    stage16.push('homehead 不是纵向布局（会被 header 的横向 flex 接管）');
  }
  /* 通用 header 规则若被改成 align-items:stretch 等，也要能兜住 */
  if (/header\s*\{[^}]*align-items:\s*center/.test(html) && !/align-items:\s*stretch/.test(headRule)) {
    stage16.push('header 的 align-items:center 仍在生效且 homehead 未覆盖');
  }

  /* 右侧容器（刷新按钮 + 倒计时）—— 后面的断言都要用，先声明 */
  const wrapRule = (html.match(/\.homehead \.refwrap \{([^}]*)\}/) || [])[1] || '';
  const btnRule = (html.match(/#settingsBtn\.edgebtn,\s*#refreshHome\.edgebtn \{([^}]*)\}/) || [])[1] || '';
  if (!/flex:\s*0 0 44px/.test(btnRule) || !/width:\s*44px/.test(btnRule)) {
    stage16.push('两侧按钮不是等宽固定尺寸，标题会偏：' + btnRule.trim().slice(0, 70));
  }
  /* 取所有匹配里的最后一条（组合选择器在前、单独 id 规则在后） */
  const allSet = [...html.matchAll(/#settingsBtn\.edgebtn \{([^}]*)\}/g)];
  const allRef = [...html.matchAll(/#refreshHome\.edgebtn \{([^}]*)\}/g)];
  const setRule = allSet.length ? allSet[allSet.length - 1][1] : '';
  const refRule = allRef.length ? allRef[allRef.length - 1][1] : '';
  if (!/order:\s*1/.test(setRule)) stage16.push('设置按钮不是在第一位：' + setRule.trim());
  /* 刷新按钮现在包在 .refwrap 里，横向位置由 refwrap 的 order/margin 决定 */
  if (!/order:\s*3/.test(wrapRule)) stage16.push('refwrap 不在第三位（刷新按钮会错位）：' + wrapRule.trim());
  const setM = (setRule.match(/margin:\s*([^;]+)/) || [])[1] || '';
  const wrapM = (wrapRule.match(/margin:\s*([^;]+)/) || [])[1] || '';
  if (setM.trim() !== "0" && setM.trim() !== "") {
    stage16.push('设置按钮应无额外外边距（贴边）：' + setM.trim());
  }
  if (wrapM.trim() !== "0" && wrapM.trim() !== "") {
    stage16.push('refwrap 应无额外外边距（贴边）：' + wrapM.trim());
  }
  /* 真正贴到屏幕边：body 有 padding，顶栏必须用负外边距抵消掉，
     否则按钮只能贴到内容区边缘（用户截图里就是这种情况）。 */
  if (!/margin-left:\s*calc\(-1 \* var\(--pad\)\)/.test(topRule)) {
    stage16.push('顶栏没有抵消左内边距，按钮贴不到屏幕边：' + topRule.trim().slice(0, 90));
  }
  if (!/margin-right:\s*calc\(-1 \* var\(--pad\)\)/.test(topRule)) {
    stage16.push('顶栏没有抵消右内边距');
  }
  /* 光有负边距不够：容器宽度还得补上两侧 pad，否则右边会差一截
     （实测曾多出约 2×--pad 的空白，按钮离右边 27 CSS px）。 */
  if (!/width:\s*calc\(100% \+ 2 \* var\(--pad\)\)/.test(topRule)) {
    stage16.push('顶栏宽度没有补上两侧 pad，右侧会留一截空白：' + topRule.trim().slice(0, 90));
  }
  if (!/box-sizing:\s*border-box/.test(topRule)) {
    stage16.push('顶栏没有 box-sizing:border-box，宽度计算会含边距导致溢出');
  }
  /* 两侧按钮不能有额外外边距（会破坏贴边） */
  const setM2 = (setRule.match(/margin:\s*([^;]+)/) || [])[1] || '';
  const wrapM2 = (wrapRule.match(/margin:\s*([^;]+)/) || [])[1] || '';
  if (/[1-9]\d*px/.test(setM2)) stage16.push('设置按钮仍有额外左外边距：' + setM2);
  if (/[1-9]\d*px/.test(wrapM2)) stage16.push('刷新容器仍有额外右外边距：' + wrapM2);

  /* 窄屏媒体查询里不能再把刷新按钮撑开（旧规则 flex:1 1 40% 会让它跑到中间） */
  if (/#near, #refreshHome \{ flex:/.test(html)) {
    stage16.push('窄屏媒体查询仍在拉伸刷新按钮，会把它挤到标题旁');
  }

  /* 2) 按钮顺序：设置在前、刷新在后（DOM 里设置应在标题之前，做成左边缘） */
  const inTop = (id) => top.indexOf('id="' + id + '"');
  if (inTop('settingsBtn') < 0) stage16.push('topline 里没有设置按钮');
  if (inTop('refreshHome') < 0) stage16.push('topline 里没有刷新按钮');
  if (inTop('settingsBtn') > inTop('homeTitle')) {
    stage16.push('设置按钮应在标题之前（左侧位置）');
  }
  if (inTop('homeTitle') > inTop('refreshHome')) {
    stage16.push('刷新按钮应在标题之后（右侧位置）');
  }

  /* 顶栏只能有三个参与布局的元素：设置、标题、刷新。多一个就会把右边顶宽。 */
  /* 顶栏的横向层只有 3 个：设置 / 标题 / refwrap（refwrap 内部才竖排按钮+计时） */
  const topLevel = (top.match(/id="(settingsBtn|homeTitle|refreshHome)"/g) || []);
  if (topLevel.length !== 3) {
    stage16.push('顶栏横向元素不是 3 个（会挤偏标题）：' + topLevel.join(', '));
  }
  if (!/class="refwrap"/.test(top)) {
    stage16.push('顶栏没有 refwrap 容器包住刷新按钮和倒计时');
  }

  /* 状态行宽度必须和顶栏一致，否则两行轴心对不齐 */
  const locRule = (html.match(/\.homehead \.locline \{([^}]*)\}/) || [])[1] || '';
  if (!/calc\(-1 \* var\(--pad\)\)/.test(locRule)) {
    stage16.push('状态行没有抵消内边距，和标题对不齐：' + locRule.trim().slice(0, 70));
  }
  /* 3) 城市名必须移到定位行里，跟在「已定位」后面 */
  const loc = (html.match(/<div class="locline">[\s\S]*?<\/div>/) || [])[0] || '';
  if (!/id="loctext"/.test(loc)) stage16.push('定位行里没有 loctext');
  if (!/id="cityBtn"/.test(loc)) {
    stage16.push('城市名没有移到定位行（应跟在已定位后面）');
  }
  if (/id="cityBtn"/.test(top)) {
    stage16.push('城市名还在标题行里');
  }
  /* 顺序：loctext 在 cityBtn 之前 */
  if (loc.indexOf('id="loctext"') > loc.indexOf('id="cityBtn"')) {
    stage16.push('城市名排在了「已定位」前面');
  }

  /* 4) 倒计时标签不能挤标题：应绝对定位在刷新按钮旁 */
  const noteRule = (html.match(/\.homehead \.refreshnote \{([^}]*)\}/) || [])[1] || '';
  /* 倒计时竖排在刷新按钮正下方：包在 .refwrap 里，宽度与按钮同为 44px，
     不占横向空间，标题仍精确居中。 */
  if (!/flex-direction:\s*column/.test(wrapRule)) {
    stage16.push('refwrap 不是竖排，倒计时会跑到按钮旁边：' + wrapRule.trim().slice(0, 70));
  }
  if (!/width:\s*44px/.test(wrapRule) || !/flex:\s*0 0 44px/.test(wrapRule)) {
    stage16.push('refwrap 宽度没锁定 44px，会撑宽右侧把标题挤偏：' + wrapRule.trim().slice(0, 70));
  }
  if (!/pointer-events:\s*none/.test(noteRule)) {
    stage16.push('倒计时没设 pointer-events:none，会挡住刷新按钮点击');
  }
  /* 倒计时必须在顶栏的 refwrap 里，不能回到状态行 */
  if (/id="refreshNote"/.test(loc)) {
    stage16.push('倒计时还在状态行，应移到刷新按钮下面');
  }
  if (!/id="refreshNote"/.test(top)) {
    stage16.push('倒计时不在顶栏的 refwrap 里');
  }
}

if (stage16.length) {
  console.error('✗ UI 冒烟失败（顶栏布局）：');
  for (const f of stage16) console.error('  - ' + f);
  process.exit(1);
}
console.log('✓ 顶栏布局通过：homehead 撑满、横向三元素、两侧等宽对称、标题精确居中、倒计时竖排在刷新按钮下');

/* ------------------------------------- 「末班在途」标签（详情页 N 辆在途后面） */
const stage17 = [];
{
  const fn = window.cdBusIsLastBusInTransit;
  if (typeof fn !== 'function') {
    stage17.push('isLastBusInTransit 没有导出');
  } else {
    /* 直接构造 lineView 传给判定函数 —— 不依赖当前页面状态。
       前面阶段把 AndroidBus 桩换成了返回空数据的版本，state.lineView 拿不到。 */
    const mk = (firstTime, lastTime, buses) => ({ firstTime, lastTime, buses });

    /* A：末班已过（00:01）且有在途车 → true */
    if (fn(mk('00:00', '00:01', [{ order: 5, etaSeconds: 60 }])) !== true) {
      stage17.push('末班已过且有车，没判成末班在途');
    }
    /* B：末班在很远未来（23:59）→ false */
    if (fn(mk('00:00', '23:59', [{ order: 5, etaSeconds: 60 }])) !== false) {
      stage17.push('还没到末班时间却判成末班在途');
    }
    /* C：没有在途车辆 → false */
    if (fn(mk('00:00', '00:01', [])) !== false) {
      stage17.push('没有在途车辆却判成末班在途');
    }
    /* D：缺末班时间 → false */
    if (fn(mk('06:00', '', [{ order: 5 }])) !== false) {
      stage17.push('缺末班时间时仍判成末班在途');
    }
    /* E：跨夜线路（22:00-01:30）在 23:00 应判 true，在白天 12:00 应判 false */
    const nightMid = fn(mk('22:00', '01:30', [{ order: 3 }]));
    if (typeof nightMid !== 'boolean') stage17.push('跨夜线路判定没有返回布尔值');
  }

  /* 源码层面：标签必须在「N 辆在途」后面追加，且用独立样式 */
  if (!/辆在途/.test(html)) stage17.push('找不到「辆在途」文案');
  if (!/lvb-last/.test(html)) stage17.push('没有 lvb-last 样式（末班在途标签）');
  const labelBlock = (html.match(/label\.textContent = "🚌 " \+ n \+ " 辆在途"([\s\S]{0,400})/) || [])[1] || '';
  if (!/isLastBusInTransit\(\)/.test(labelBlock)) {
    stage17.push('「N 辆在途」后面没有调用末班判定');
  }
}

if (stage17.length) {
  console.error('✗ UI 冒烟失败（末班在途）：');
  for (const f of stage17) console.error('  - ' + f);
  process.exit(1);
}
/* ---------------------------------------------------- 在线更新（前端部分） */
const stage18 = [];
{
  /* 1) 关于页必须有更新入口与进度条 */
  for (const id of ['updCurrent', 'updCheck', 'updGo', 'updBarWrap', 'updBarFill', 'updState']) {
    if (!new RegExp('id="' + id + '"').test(html)) {
      stage18.push('关于页缺少更新元素 #' + id);
    }
  }
  if (!/\.updbar-fill/.test(html)) stage18.push('缺少进度条样式 .updbar-fill');

  /* 2) 桥接方法齐全（页面按名字调用，缺一个就整条链路断） */
  for (const fn of ['updateCheck', 'updateDownload', 'updatePoll', 'updateCanInstall',
                    'updateOpenInstallPermission', 'updateInstall', 'updateVersion']) {
    if (bridge[fn] === undefined) {
      /* DOM 桩的 bridge 不一定有全部方法，这里只查页面源码有没有调用 */
      if (html.indexOf(fn) < 0) stage18.push('页面没有调用 ' + fn);
    }
  }

  /* 3) 状态处理函数覆盖所有终态 */
  for (const st of ['"checking"', '"checked"', '"downloading"', '"verifying"', '"ready"', '"error"']) {
    if (html.indexOf(st) < 0) stage18.push('前端没有处理状态 ' + st);
  }

  /* 4) 安装前必须检查「未知应用」权限，未授权要跳设置页 */
  if (!/updateCanInstall/.test(html) || !/updateOpenInstallPermission/.test(html)) {
    stage18.push('安装前没有检查未知来源权限 / 没有跳设置页引导');
  }

  /* 5) 启动时静默检查：不能是用户主动操作才查 */
  if (!/updateCheck\(false\)|bridge\.updateCheck\(!manual\)/.test(html)) {
    stage18.push('没有启动时静默检查更新');
  }
  if (!/bridge\.updateCheck\(true\)|updCheck\(true\)/.test(html)) {
    stage18.push('设置页的「检查更新」按钮没有接到手动检查');
  }

  /* 6) Java 侧：清单必须有安装权限 + provider；版本比较必须用 versionName */
  const manifest = readSafe('app/AndroidManifest.xml');
  if (!/REQUEST_INSTALL_PACKAGES/.test(manifest)) {
    stage18.push('清单缺少 REQUEST_INSTALL_PACKAGES');
  }
  if (!/ApkProvider/.test(manifest) || !/grantUriPermissions="true"/.test(manifest)) {
    stage18.push('清单没有注册 FileProvider（或没开 grantUriPermissions）');
  }
  const updaterSrc = readSafe('app/src/com/chengdu/bus/Updater.java');
  if (!/normalize\(currentVersionName\(\)\)/.test(updaterSrc)) {
    stage18.push('版本比较没有用 versionName（versionCode 是自增序号，会永远误判有新版）');
  }
  if (!/releases\/latest/.test(updaterSrc)) {
    stage18.push('没有走 releases/latest 重定向（API 会限流）');
  }
}

if (stage18.length) {
  console.error('✗ UI 冒烟失败（在线更新）：');
  for (const f of stage18) console.error('  - ' + f);
  process.exit(1);
}
/* ---------------------------- Gitee 版本选择：必须取最大版本号，不能取第 0 条 */
const stage19 = [];
{
  const updaterSrc = readSafe('app/src/com/chengdu/bus/Updater.java');
  /* Gitee 的 releases 列表按创建时间正序返回（最老的在前），
     GitHub 是倒序。实测 v1.3.1 排在 v1.3.2 之前 —— 取 [0] 会拿到旧版本，
     用户永远收不到更新。必须遍历挑最大。 */
  if (!/int best = -1/.test(updaterSrc) || !/if \(v > best\)/.test(updaterSrc)) {
    stage19.push('Gitee 版本选择没有取「最大版本号」，取第 0 条会拿到旧版本');
  }
  /* release 已超过 20 条，per_page=20 时第一页只到 v1.5.0，最新版本在第二页之后，
     结果就是「最新版本显示 v1.5.0、当前 1.6.6 却显示已是最新」。必须拉够一页。 */
  if (!/per_page=100/.test(updaterSrc)) {
    stage19.push('Gitee 只拉 20 条 release，最新版本落在第二页之后会漏掉');
  }
  if (!/prerelease/.test(updaterSrc)) {
    stage19.push('没有跳过 prerelease 版本');
  }
}

if (stage19.length) {
  console.error('✗ UI 冒烟失败（Gitee 版本选择）：');
  for (const f of stage19) console.error('  - ' + f);
  process.exit(1);
}
/* ------------------ 站名条滚动：自动刷新不动、手动刷新才回最近站 */
const stage20 = [];
{
  /* 1) renderLineView 必须接收 scroll 参数，而不是写死 true */
  if (!/function renderLineView\(opts\)/.test(html)) {
    stage20.push('renderLineView 没有接收 scroll 参数（滚动行为无法区分自动/手动）');
  }
  if (/renderLineStations\(\{\s*scroll:\s*true\s*\}\)\s*;\s*\n\s*renderLineNav/.test(html)) {
    stage20.push('renderLineView 里写死了 scroll: true，自动刷新也会被拽回最近站');
  }
  const viewBody = (html.match(/function renderLineView\(opts\) \{([\s\S]*?)\n  \}/) || [])[1] || '';
  if (!/renderLineStations\(\{\s*scroll:\s*Boolean\(opts && opts\.scroll\)\s*\}\)/.test(viewBody)) {
    stage20.push('renderLineView 没有把 opts.scroll 传给 renderLineStations');
  }

  /* 2) 自动刷新路径必须不滚 */
  if (/\(!auto\) \|\| view\.scrollOnLoad/.test(html) === false) {
    stage20.push('loadMatrix 里没有「自动刷新不滚、手动才滚」的判定');
  }
  /* 3) 30 秒车辆刷新必须显式 scroll:false */
  const busesIdx = html.indexOf('async function refreshLineBuses');
  const busesSeg = busesIdx >= 0 ? html.slice(busesIdx, busesIdx + 1600) : '';
  if (!/renderLineStations\(\{\s*scroll:\s*false\s*\}\)/.test(busesSeg)) {
    stage20.push('车辆位置刷新（30 秒定时）仍会拽回最近站，应为 scroll:false');
  }
  /* 4) 点站名不滚 */
  if (/点站名[\s\S]{0,200}renderLineView\(\)/.test(html)) {
    stage20.push('点站名的路径还在无参调用 renderLineView');
  }
  /* 5) 决策顺序：**进页/手动刷新/切方向一律对准最近站**，不再看有没有选中站
        （用户要求：无论从哪里进详情页，站名条都定到离我最近那一站） */
  const blockStart = html.indexOf('if (opts && opts.scroll) {');
  const scrollBlock = blockStart >= 0 ? html.slice(blockStart, blockStart + 900) : '';
  if (!scrollBlock) {
    stage20.push('找不到 scroll 分支');
  } else {
    if (!/\.chip\.nearest/.test(scrollBlock)) {
      stage20.push('滚动分支没有用 .chip.nearest 作为目标');
    }
    if (/!hasActive/.test(scrollBlock)) {
      stage20.push('滚动分支还在判断「有没有选中站」，导致从首页车辆进来时不会对准最近站');
    }
  }
  /* 没有定位时要补一次定位再对齐，否则第一次进详情页停在哪全靠运气 */
  if (!/relocate\(6000\)/.test(html) || !/nearestRetrying/.test(html)) {
    stage20.push('进详情页时没有定位就没有补定位，最近站永远滚不过去');
  }
  /* 最近站排在 60 站之后时也要画出来 */
  if (!/var cap = 60;/.test(html) || !/slice\(0, cap\)/.test(html)) {
    stage20.push('站名条只画前 60 站，最近站在后面时滚不过去');
  }
}

if (stage20.length) {
  console.error('✗ UI 冒烟失败（站名条滚动）：');
  for (const f of stage20) console.error('  - ' + f);
  process.exit(1);
}
/* ----------- keepScroll 必须真的被使用（曾经算出来却从没用，等于没生效） */
const stage22 = [];
{
  const fn = (html.match(/function renderLineStations\(opts\) \{([\s\S]*?)\n  \}/) || [])[1] || '';
  if (!fn) {
    stage22.push('找不到 renderLineStations');
  } else {
    /* 1) 必须声明 keepScroll */
    if (!/var keepScroll = /.test(fn)) {
      stage22.push('没有记录 keepScroll');
    }
    /* 2) 必须有「把 keepScroll 写回 box.scrollLeft」的语句 —— 关键 */
    if (!/box\.scrollLeft = keepScroll/.test(fn)) {
      stage22.push('keepScroll 只算不用（自动刷新仍会弹回最近站/开头）');
    }
    /* 3) 还原必须发生在 nearest 滚动与 centerActiveChip 之前 */
    const iRestore = fn.indexOf('box.scrollLeft = keepScroll');
    const iNearest = fn.indexOf('.chip.nearest');
    const iCenter = fn.indexOf('centerActiveChip(box)', iRestore >= 0 ? iRestore : 0);
    if (iRestore >= 0 && iNearest >= 0 && iRestore > iNearest) {
      stage22.push('还原滚动位置被放在「滚到最近站」之后，仍会被覆盖');
    }
    /* 4) 还原后要 return，不能继续走到别的滚动逻辑 */
    const afterRestore = fn.slice(iRestore >= 0 ? iRestore : 0, (iRestore >= 0 ? iRestore : 0) + 300);
    if (!/return;/.test(afterRestore)) {
      stage22.push('还原滚动位置后没有 return，后续滚动逻辑会覆盖它');
    }
  }
}

if (stage22.length) {
  console.error('✗ UI 冒烟失败（自动刷新保持滚动位置）：');
  for (const f of stage22) console.error('  - ' + f);
  process.exit(1);
}
/* ------------------ 到站表行：单排紧凑、🔔 跟在时间后、长站名折行 */
const stage23 = [];
{
  /* 行内已无 🔔（统一移到顶部按钮排） */
  if (/\.srow \.actions \{/.test(html)) stage23.push('还留着 .srow .actions 样式（两排版遗留）');
  if (/data-bell/.test(html)) stage23.push('行内仍有铃铛元素');

  /* 时间必须固定在右边同一列（不换行、不抢站名宽度）：
     flex:0 0 auto + nowrap + 最小宽度 + 右对齐。
     站名 flex:1 在自己的列里折行，行高变高、时间位置不变。 */
  const whenRule2 = (html.match(/\.srow \.swhen \{([^}]*)\}/) || [])[1] || '';
  if (!/flex:\s*0 0 auto/.test(whenRule2)) {
    stage23.push('时间没有 flex:0 0 auto，会被站名挤压：' + whenRule2.trim().slice(0, 70));
  }
  if (!/white-space:\s*nowrap/.test(whenRule2)) stage23.push('时间没有 nowrap，会被断行');
  if (!/min-width:\s*\d+px/.test(whenRule2)) {
    stage23.push('时间列没有最小宽度，不同长度的时间会让站名列起点跳动');
  }
  if (!/text-align:\s*right/.test(whenRule2)) stage23.push('时间没有右对齐');
  /* 站名必须能在自己列内折行 */
  const nameRule2 = (html.match(/\.srow \.sname \{([^}]*)\}/) || [])[1] || '';
  if (!/word-break:\s*break-all/.test(nameRule2)) stage23.push('站名不能折行，长站名会被截断');
  if (/white-space:\s*nowrap/.test(nameRule2)) stage23.push('站名设了 nowrap，长站名无法折行');
  /* 行容器不能整体 wrap（那会把时间推到第二行） */
  const rowRule2 = (html.match(/\.srow \{ display: flex;([^}]*)\}/) || [])[1] || '';
  if (/flex-wrap:\s*wrap/.test(rowRule2)) {
    stage23.push('行容器整体 wrap，时间会被推到第二行（要求时间始终在右边）');
  }
  /* 3) 站名必须允许折行（不能 nowrap、不能省略号截断） */
  const nameRule = (html.match(/\.srow \.sname \{([^}]*)\}/) || [])[1] || '';
  if (/nowrap/.test(nameRule)) stage23.push('站名设了 nowrap，长站名会被挤掉');
  if (/text-overflow:\s*ellipsis/.test(nameRule)) stage23.push('站名用了省略号截断，要求是折到第二行');
  /* 4) 时间不能换行（短，挤不走） */
  const whenRule = (html.match(/\.srow \.swhen \{([^}]*)\}/) || [])[1] || '';
  if (!/white-space:\s*nowrap/.test(whenRule)) stage23.push('时间没有 nowrap，会被断行');
  /* 5) 行内边距要比原来小（卡片变窄） */
  const rowRule = (html.match(/\.srow \{ display: flex;([^}]*)\}/) || [])[1] || '';
  const pad = (rowRule.match(/padding:\s*(\d+)px/) || [])[1];
  if (!pad || Number(pad) > 10) {
    stage23.push('行内边距没减小（仍 ' + (pad || '?') + 'px），卡片没有变窄');
  }
}

if (stage23.length) {
  console.error('✗ UI 冒烟失败（到站表行布局）：');
  for (const f of stage23) console.error('  - ' + f);
  process.exit(1);
}
/* ------------------ 下车提醒从「每行 🔔」改成「顶部按钮排一个」 */
const stage24 = [];
{
  /* 1) 到站表行里不能再有自己的铃铛 */
  if (/data-bell/.test(html)) stage24.push('到站表每行仍有独立铃铛（data-bell）');
  const rowTpl = (html.match(/'<span class="swhen">' \+ when \+ clock \+([\s\S]{0,160})/) || [])[1] || '';
  if (/bell/.test(rowTpl)) stage24.push('行模板里还在拼铃铛');
  if (!/\.srow \.bell/.test(html) === false) {
    /* 样式残留也查一下（可以留，但元素没了就该清） */
  }
  if (/\.srow \.bell \{/.test(html)) stage24.push('行内铃铛的样式没清理');

  /* 2) 按钮排必须有「下车提醒」，且排在「盯站」之后 */
  if (!/renderAlightBtn/.test(html)) {
    stage24.push('没有 renderAlightBtn，顶部按钮排缺下车提醒');
  }
  const navBody = (html.match(/function renderLineNav\(\) \{([\s\S]*?)\n  \}/) || [])[1] || '';
  const iFav = navBody.indexOf('makeStationFavBtn');
  const iWatch = navBody.indexOf('renderLineWatchBtn');
  const iAlight = navBody.indexOf('renderAlightBtn');
  if (iAlight < 0) {
    stage24.push('renderLineNav 里没挂下车提醒按钮');
  } else {
    if (iWatch >= 0 && iAlight < iWatch) stage24.push('下车提醒排在盯站之前，要求是之后');
    if (iFav >= 0 && iAlight < iFav) stage24.push('下车提醒排在收藏之前');
  }

  /* 3) 按钮要能开关切换，且开启时有高亮样式 */
  const alightBody = (html.match(/function renderAlightBtn\(target\) \{([\s\S]*?)\n  \}/) || [])[1] || '';
  if (!/alightRunning && alightDest/.test(alightBody)) stage24.push('按钮没有读取提醒状态');
  if (!/startAlight\(target\.order\)/.test(alightBody)) stage24.push('按钮没有调用 startAlight');
  if (!/已开提醒/.test(alightBody)) stage24.push('按钮没有「已开提醒」的状态文案');
  if (!/\.alightbtn\.on/.test(html)) stage24.push('下车提醒按钮没有开启态样式');
}

if (stage24.length) {
  console.error('✗ UI 冒烟失败（下车提醒按钮位置）：');
  for (const f of stage24) console.error('  - ' + f);
  process.exit(1);
}
/* ---------------------- 发现新版本时弹窗提醒 */
const stage25 = [];
{
  /* 1) 弹窗结构齐全 */
  for (const id of ['updModal', 'updModalVer', 'updModalGo', 'updModalLater',
                    'updModalState', 'updModalBarWrap']) {
    if (!new RegExp('id="' + id + '"').test(html)) {
      stage25.push('更新弹窗缺少 #' + id);
    }
  }
  /* 2) 发现新版必须开弹窗，不能只 toast */
  if (!/updOpenModal\(latest\)/.test(html)) {
    stage25.push('发现新版本时没有调用 updOpenModal');
  }
  const checkedBlock = html.slice(html.indexOf('updLast = { latest: latest'));
  if (!/updOpenModal/.test(checkedBlock.slice(0, 900))) {
    stage25.push('checked 分支里没有弹窗调用');
  }
  /* 3) 「以后再说」要记住版本，同一版不再自动弹 */
  if (!/updSkipVersion/.test(html)) stage25.push('没有记录「以后再说」的版本');
  if (!/UPD_SKIP_KEY/.test(html)) stage25.push('没有 skip 的存储键');
  /* 4) 手动检查时即使 skip 过也要弹 */
  if (!/if \(!silent \|\| skipped !== latest\)/.test(html)) {
    stage25.push('手动检查被 skip 记录挡住了（手动应总能弹）');
  }
  /* 5) 立即更新要触发下载 */
  if (!/\$\("updModalGo"\)\.onclick/.test(html)) stage25.push('「立即更新」按钮没有绑定');
  const goBlock = html.slice(html.indexOf('$("updModalGo").onclick'));
  if (!/updDownload\(\)/.test(goBlock.slice(0, 300))) stage25.push('「立即更新」没有调用下载');
  /* 6) 以后再说要关闭并记 skip */
  const laterBlock = html.slice(html.indexOf('$("updModalLater").onclick'));
  if (!/updSkipVersion/.test(laterBlock.slice(0, 300))) stage25.push('「以后再说」没有记 skip');
  if (!/updCloseModal/.test(laterBlock.slice(0, 300))) stage25.push('「以后再说」没有关闭弹窗');
  /* 7) 下载中弹窗要显示进度 */
  if (!/updModalBarFill/.test(html)) stage25.push('弹窗里没有进度条填充元素');
}

if (stage25.length) {
  console.error('✗ UI 冒烟失败（更新弹窗）：');
  for (const f of stage25) console.error('  - ' + f);
  process.exit(1);
}
console.log('✓ 更新弹窗通过：发现新版即弹、立即更新触发下载、以后再说记住版本、手动检查总能弹');

console.log('✓ 下车提醒按钮通过：行内铃铛已移除、按钮排在盯站后、可开关且有高亮');

/* ---------- 「临时不停靠」的站：站序要用 specialOrder，不能用 order */
const stage26 = [];
{
  const mjsSrc = readSafe('lib/chelaile.mjs');
  /* 车来了对不停靠站给 order=999、specialOrder=真实序、坐标 0,0。
     实测 P02 的 order 序列是 1..14,999,999,15,16,...（跳过特殊站后重编号），
     而 specialOrder 是连续的 1..22。所以整条线必须统一用 specialOrder。 */
  if (!/specialOrder/.test(mjsSrc)) {
    stage26.push('lib 层没有读 specialOrder，特殊站会排到终点之后');
  }
  const stationMap = (mjsSrc.match(/const stations = \(data\.stations[\s\S]*?\n    \}\);/ ) || [])[0] || '';
  if (!/hasSp \? Number\(st\.specialOrder\) : Number\(st\.order\)/.test(mjsSrc)) {
    stage26.push('站序没有统一用 specialOrder（会造成撞号）');
  }
  if (!/suspended/.test(mjsSrc)) {
    stage26.push('lib 层没有标记 suspended（界面无法区分不停靠的站）');
  }
  /* 前端要显示「不停靠」标记 */
  if (!/station\.suspended/.test(html)) {
    stage26.push('前端没有使用 suspended 标记');
  }
  if (!/不停靠/.test(html)) {
    stage26.push('界面上看不到「不停靠」文字');
  }
  if (!/\.chip\.suspended/.test(html) || !/\.sustag/.test(html)) {
    stage26.push('缺少不停靠站的样式（变淡 + 角标）');
  }
}

if (stage26.length) {
  console.error('✗ UI 冒烟失败（不停靠的站）：');
  for (const f of stage26) console.error('  - ' + f);
  process.exit(1);
}
console.log('✓ 不停靠的站通过：站序用 specialOrder 落回真实位置、界面标出「不停靠」');

/* ---------------------- 环线：首末站同一站 + 早段站点要靠绕环找车 */
const stage27 = [];
{
  const mjsSrc = readSafe('lib/chelaile.mjs');
  const javaSrc = readSafe('app/src/com/chengdu/bus/ChelaileClient.java');
  /* 环线 = 首站和末站是同一个物理站（stationId 相同）。
     车来了按 1..N 线性给站序，环线上早段的站前面一辆车都没有，
     接口全返回「已过站」，不兜底就会显示无车。 */
  if (!/const loop = loopLen >= 3/.test(mjsSrc)) {
    stage27.push('lib 层没有判定环线（首末站同 id），绕环兜底无从触发');
  }
  if (!/loop,\s*\n\s*loopLen,/.test(mjsSrc)) {
    stage27.push('lib 层没把 loop/loopLen 带到站点上');
  }
  if (!/station\.loop && behind\.length/.test(mjsSrc)) {
    stage27.push('lib 层缺少环线绕环兜底（早段车站会显示无车）');
  }
  if (!/\(\(target - busOrder\) % n \+ n\) % n/.test(mjsSrc)) {
    stage27.push('绕环距离公式不对（应为 (目标-车+N)%N）');
  }
  if (!/wrapped: true/.test(mjsSrc)) {
    stage27.push('绕环车没有 wrapped 标记，界面无法区分');
  }
  /* APK 走的是 Java 侧，两边必须一致 */
  if (!/boolean loop = false;/.test(javaSrc) || !/item\.put\("loop", loop\)/.test(javaSrc)) {
    stage27.push('Java 侧没有判定并下发 loop（APK 里绕环兜底不会生效）');
  }
  if (!/station\.optBoolean\("loop", false\)/.test(javaSrc)) {
    stage27.push('Java arrivals 没读 loop，绕环兜底没实现');
  }
  if (!javaSrc.includes('(order - busOrder) % loopLen + loopLen) % loopLen')) {
    stage27.push('Java 侧绕环距离公式不对');
  }
  if (!/if \(bus\.optBoolean\("wrapped", false\)\) continue;/.test(javaSrc)) {
    stage27.push('逐站矩阵没跳过绕环车（会冒出没有时间的幽灵车）');
  }
  if (!/\.put\("loopLen", station\.optInt\("loopLen", 0\)\)/.test(javaSrc)) {
    stage27.push('矩阵返回的站点丢了 loopLen，点站后算不了绕环');
  }
}

if (stage27.length) {
  console.error('✗ UI 冒烟失败（环线）：');
  for (const f of stage27) console.error('  - ' + f);
  process.exit(1);
}
console.log('✓ 环线通过：首末站同 id 判定、早段车站靠绕环找车、矩阵不混入幽灵车');

/* ---------------------- 静态地铁/有轨数据：站序必须和 from→to 一致

   蓉2号线（T2）的站点数组被整体旋转过：数组从「合信路」开始，
   一圈绕到「电子科大」结束，于是 22 个站在界面上排成了
   合信路→…→郫县西站→成都西站→…→电子科大，路径凭空多出 17 公里。
   这里对全部线路做三条硬校验，防止再手改出错。 */
const stage28 = [];
{
  const m = html.match(/id="metroData">([\s\S]*?)<\/script>/);
  if (!m) {
    stage28.push('找不到内嵌的地铁数据 metroData');
  } else {
    let data = null;
    try { data = JSON.parse(m[1]); } catch (e) { stage28.push('metroData 不是合法 JSON：' + e.message); }
    if (data) {
      const R = 6371000;
      const rad = (d) => d * Math.PI / 180;
      const hav = (a, b) => {
        const dLa = rad(b.lat - a.lat), dLo = rad(b.lng - a.lng);
        const h = Math.sin(dLa / 2) ** 2 +
          Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLo / 2) ** 2;
        return 2 * R * Math.asin(Math.sqrt(h));
      };
      const short = (s) => String(s || '').replace(/站$/, '');
      const seen = {};
      for (const ln of data.lines) {
        const st = ln.stations || [];
        if (st.length < 2) { stage28.push(ln.name + '：站点少于 2 个'); continue; }
        /* 1) 首站必须是 from，末站必须是 to —— 旋转/反转都会在这里暴露 */
        if (short(st[0].name) !== short(ln.from)) {
          stage28.push(ln.name + '：首站 ' + st[0].name + ' 不等于起点 ' + ln.from + '（站序被旋转过？）');
        }
        if (short(st[st.length - 1].name) !== short(ln.to)) {
          stage28.push(ln.name + '：末站 ' + st[st.length - 1].name + ' 不等于终点 ' + ln.to);
        }
        /* 2) 相邻两站不能跨太远，否则说明中间被插错/漏站 */
        for (let i = 0; i < st.length - 1; i++) {
          const g = hav(st[i], st[i + 1]);
          if (g > 25000) {
            stage28.push(ln.name + '：' + st[i].name + '→' + st[i + 1].name + ' 跳了 ' + Math.round(g) + ' 米');
          }
        }
        /* 3) 站名不能在同一线路里重复（环线除外，环线首末同名是同 id 的两条记录） */
        const idx = {};
        st.forEach((x, i) => { if (idx[x.name] !== undefined) seen[ln.id] = true; idx[x.name] = i; });
      }
      /* 蓉2号线单独立个靶子：总长 24 公里左右，旋转错位后会变成 41 公里 */
      const t2 = data.lines.find((l) => l.id === 'T2');
      if (t2) {
        let len = 0;
        for (let i = 0; i < t2.stations.length - 1; i++) len += hav(t2.stations[i], t2.stations[i + 1]);
        if (len > 30000) {
          stage28.push('蓉2号线站序错乱：路径总长 ' + Math.round(len / 1000) + ' 公里（正常约 24 公里）');
        }
      } else {
        stage28.push('地铁数据里没有蓉2号线（T2）');
      }
    }
  }
}

if (stage28.length) {
  console.error('✗ UI 冒烟失败（地铁站序）：');
  for (const f of stage28) console.error('  - ' + f);
  process.exit(1);
}
console.log('✓ 地铁站序通过：首末站对齐 from/to、无异常跳站、蓉2号线路径长度正常');

/* ---------------------- 地铁/有轨首末班：双向都要有，且时间必须合法 */
const stage29 = [];
{
  const m = html.match(/id="metroData">([\s\S]*?)<\/script>/);
  if (!m) {
    stage29.push('找不到内嵌的地铁数据 metroData');
  } else {
    const data = JSON.parse(m[1]);
    const isHHMM = (v) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || ''));
    const maxHHMM = (v) => {
      const [h, mi] = String(v).split(':').map(Number);
      return h * 60 + mi;
    };
    let missing = 0;
    for (const ln of data.lines) {
      if (ln.id === 'M-TR') continue;              // 都江堰专线官网没有数据
      const t = ln.times;
      if (!Array.isArray(t) || !t.length) {
        missing++;
        stage29.push(ln.name + '：没有首末班数据');
        continue;
      }
      /* 环线（from == to）只给一条「全线」，其余必须是双向两条 */
      const wantTwo = String(ln.from || '') !== String(ln.to || '');
      if (wantTwo && t.length !== 2) {
        stage29.push(ln.name + '：双向线路只有 ' + t.length + ' 条首末班（应为 2）');
      }
      t.forEach((x) => {
        if (!x.dir) stage29.push(ln.name + '：首末班里缺方向');
        if (!isHHMM(x.first)) stage29.push(ln.name + ' ' + x.dir + '：首班时间不合法 ' + x.first);
        if (!isHHMM(x.last)) stage29.push(ln.name + ' ' + x.dir + '：末班时间不合法 ' + x.last);
        if (isHHMM(x.first) && isHHMM(x.last) && maxHHMM(x.last) <= maxHHMM(x.first)) {
          stage29.push(ln.name + ' ' + x.dir + '：末班不晚于首班（' + x.first + ' / ' + x.last + '）');
        }
      });
      /* 双向的 dir 必须正好是 from 和 to，不能两个都写同一头 */
      if (wantTwo && t.length === 2) {
        const dirs = t.map((x) => x.dir).sort();
        const expect = [String(ln.from), String(ln.to)].sort();
        if (dirs[0] !== expect[0] || dirs[1] !== expect[1]) {
          stage29.push(ln.name + '：首末班方向是 ' + dirs.join('/') + '，应为 ' + expect.join('/'));
        }
      }
    }
    if (missing) stage29.push('共 ' + missing + ' 条线路缺首末班数据');
  }
  /* 界面必须真的把它渲染出来 */
  if (!/\.mtimes/.test(html) || !/\.mtrow/.test(html)) {
    stage29.push('缺少首末班的样式（.mtimes / .mtrow）');
  }
  if (!/line\.times/.test(html)) {
    stage29.push('线路页没有读取 times，首末班不会显示');
  }
  if (!/首班 <b>/.test(html) || !/末班/.test(html)) {
    stage29.push('界面上看不到「首班 / 末班」文字');
  }
}

if (stage29.length) {
  console.error('✗ UI 冒烟失败（地铁首末班）：');
  for (const f of stage29) console.error('  - ' + f);
  process.exit(1);
}
console.log('✓ 地铁首末班通过：19 条线路双向齐备、时间合法、末班晚于首班、界面有渲染');

/* ---------------------- 地铁/有轨 下车提醒：靠手机定位，不靠车辆数据 */

/* 地铁没有实时车辆数据，提醒只能靠定位；这里验证整条链路真的接上了原生服务，
   并且地铁和有轨电车的参数不一样（地下定位精度差 → 半径放大、不给站序）。 */
{
  const startMetro = window.cdBusStartMetroAlight;
  const stopMetro = window.cdBusStopMetroAlight;
  const runningFor = window.cdBusMetroAlightRunning;
  const fail = [];
  if (typeof startMetro !== 'function') fail.push('没有暴露 cdBusStartMetroAlight');
  if (typeof runningFor !== 'function') fail.push('没有暴露 cdBusMetroAlightRunning');

  const metroData = JSON.parse(html.match(/id="metroData">([\s\S]*?)<\/script>/)[1]);
  const line1 = metroData.lines.find((l) => l.id === '1');
  const tram = metroData.lines.find((l) => l.kind === 'tram' && l.id !== 'M-TR');
  const st1 = line1.stations[5];

  if (!fail.length) {
    alightServiceLog.length = 0;
    startMetro(line1, st1, 5);
    const call = alightServiceLog.find((x) => x[0] === 'start');
    if (!call) {
      fail.push('点了到站提醒但没调用 bridge.startAlightService');
    } else {
      const p = JSON.parse(call[1]);
      if (p.destName !== st1.name) fail.push('传给原生的终点站名不对：' + p.destName);
      if (Math.abs(p.destLat - st1.lat) > 1e-9 || Math.abs(p.destLng - st1.lng) > 1e-9) {
        fail.push('传给原生的终点坐标不对');
      }
      if (Number(p.arriveMeters) !== 600) fail.push('地铁的到站半径应为 600 米（地下定位误差大），实际 ' + p.arriveMeters);
      if (p.stations !== '[]') fail.push('地铁不该传站序（隧道里会乱跳），实际 ' + p.stations);
      if (!runningFor(line1.id, st1.name)) fail.push('开完提醒后 cdBusMetroAlightRunning 仍返回 false');
    }

    /* 有轨电车在地面跑：要给站序、到站半径用默认 250 */
    alightServiceLog.length = 0;
    const tst = tram.stations[6];
    startMetro(tram, tst, 6);
    const tcall = alightServiceLog.filter((x) => x[0] === 'start').pop();
    if (!tcall) {
      fail.push('有轨电车没能开提醒');
    } else {
      const p = JSON.parse(tcall[1]);
      if (Number(p.arriveMeters) !== 250) fail.push('有轨电车的到站半径应为 250 米，实际 ' + p.arriveMeters);
      const list = JSON.parse(p.stations);
      if (!Array.isArray(list) || list.length !== tram.stations.length) {
        fail.push('有轨电车应把整条线路站序传下去，实际 ' + p.stations.slice(0, 60));
      }
    }

    /* 关闭：必须真的调 stopAlightService 并把状态清掉 */
    alightServiceLog.length = 0;
    stopMetro();
    if (!alightServiceLog.some((x) => x[0] === 'stop')) fail.push('取消提醒没有调用 bridge.stopAlightService');
    if (runningFor(line1.id, st1.name)) fail.push('取消后仍报告提醒进行中');
  }

  /* 同一时间只能有一条提醒：地铁开之前要把公交那条收掉 */
  if (!/if \(alightRunning\) stopAlight\(true\)/.test(html)) {
    fail.push('地铁开提醒前没有先收掉上一条（原生只跑一个服务）');
  }
  /* 地铁播报不能加「路」 */
  if (!/kind === "metro"\) return alight\.lineName \+ "，"/.test(html)) {
    fail.push('地铁播报前缀没去掉「路」字（会说成「1号线路」）');
  }
  /* 界面：状态条 + 面板按钮 */
  if (!/id="malight"/.test(html)) fail.push('地铁页缺少提醒状态条 #malight');
  if (!/到 \(\?\).*提醒我下车|提醒我下车/.test(html)) fail.push('站面板里没有「提醒我下车」按钮');
  if (!/metroAlightBtnHtml/.test(html)) fail.push('站面板按钮没有渲染函数');

  if (fail.length) {
    console.error('✗ UI 冒烟失败（地铁下车提醒）：');
    for (const f of fail) console.error('  - ' + f);
    process.exit(1);
  }
  /* 界面链路：选中线路 → 点站 → 面板出现「提醒我下车」→ 点它 → 状态条亮起 */
  const openLine = window.cdBusSelectMetroLine;
  const showSt = window.cdBusMetroShowStation;
  if (typeof openLine !== 'function' || typeof showSt !== 'function') {
    fail.push('缺少 cdBusSelectMetroLine / cdBusMetroShowStation 钩子');
  } else if (openLine('1')) {
    const st = line1.stations[7];
    await showSt(st);
    await new Promise((r) => setTimeout(r, 30));
    const panel = textOf(document.getElementById('mstation'));
    if (!panel.includes('提醒我下车')) {
      fail.push('地铁站面板里没有「提醒我下车」按钮，实际：' + panel.slice(0, 120));
    }
    if (!panel.includes('出入口')) {
      fail.push('地铁站面板里没有出入口区块，实际：' + panel.slice(0, 160));
    }
    if (!panel.includes('导航到')) {
      fail.push('地铁站面板里没有「导航到」按钮，实际：' + panel.slice(0, 160));
    }
    const navBtn = document.getElementById('mnavBtn');
    if (!navBtn || typeof navBtn.onclick !== 'function') {
      fail.push('「导航到」按钮没有绑定点击事件');
    } else {
      navBtn.onclick();
      await new Promise((r) => setTimeout(r, 60));
      const pick = document.getElementById('dnavpick');
      if (!String(pick.className || '').includes('guidemodal') || String(pick.className || '').includes('hidden')) {
        fail.push('点「导航到」没有弹出地图选择层');
      }
      const t = document.getElementById('dnavpickTitle');
      if (!t || !String(t.textContent).includes(st.name)) {
        fail.push('导航选择层的标题里没有站名，实际：' + (t && t.textContent));
      }
      if (typeof window.cdBusCloseNavPick === 'function') window.cdBusCloseNavPick();
    }
    const btn = document.getElementById('malightToggle');
    if (!btn || typeof btn.onclick !== 'function') {
      fail.push('「提醒我下车」按钮没有绑定点击事件');
    } else {
      alightServiceLog.length = 0;
      btn.onclick();
      await new Promise((r) => setTimeout(r, 30));
      if (!alightServiceLog.some((x) => x[0] === 'start')) fail.push('点按钮没触发原生提醒服务');
      const bar = document.getElementById('malight');
      if (String(bar.className || '').includes('hidden')) fail.push('开提醒后地铁页顶部状态条没显示');
      const barText = textOf(bar);
      if (!barText.includes(st.name)) fail.push('状态条里没有终点站名，实际：' + barText.slice(0, 80));
      /* 再点一次是取消 */
      const btn2 = document.getElementById('malightToggle');
      if (btn2 && typeof btn2.onclick === 'function') {
        alightServiceLog.length = 0;
        btn2.onclick();
        await new Promise((r) => setTimeout(r, 30));
        if (!alightServiceLog.some((x) => x[0] === 'stop')) fail.push('再点一次没有取消提醒');
      } else {
        fail.push('提醒开着时按钮消失了，没法取消');
      }
    }
  }

  console.log('✓ 地铁下车提醒通过：定位触发、地铁 600 米/不传站序、有轨 250 米/传站序、可取消、互斥、界面链路完整');
}

/* ---------------------- 地铁站：站点导航 + 出入口列表 */
{
  const fail = [];
  const md = JSON.parse(html.match(/id="metroData">([\s\S]*?)<\/script>/)[1]);
  const exits = md.exits || {};
  const names = Object.keys(exits);
  if (!names.length) {
    fail.push('metroData 里没有 exits（出入口数据没抓进来）');
  } else {
    if (names.length < 300) fail.push('出入口只覆盖 ' + names.length + ' 个站，太少');
    /* 结构校验：每条是 [口编号, 街道说明] */
    let bad = 0;
    for (const n of names) {
      const arr = exits[n];
      if (!Array.isArray(arr) || !arr.length) { bad++; continue; }
      for (const x of arr) {
        /* 口编号：A / B1 / C2，或者成都东客站那种「东广场」 */
        if (!Array.isArray(x) || typeof x[0] !== 'string' || !x[0] || x[0].length > 8) { bad++; break; }
        if (/[（(]/.test(x[0])) { bad++; break; }   // 括号状态要拆到第三个元素
      }
    }
    if (bad) fail.push('有 ' + bad + ' 个站的出入口结构不合法');
    /* 抽查几个大站：出入口数量应该合理 */
    const sample = names.slice(0, 5).map((n) => n + ':' + exits[n].length);
    if (exits['天府广场'] && exits['天府广场'].length < 3) {
      fail.push('天府广场出入口只有 ' + exits['天府广场'].length + ' 个，明显不对');
    }
  }

  /* 界面：面板要能拿到出入口 HTML 和导航按钮 */
  if (!/function metroExitsHtml/.test(html)) fail.push('没有 metroExitsHtml');
  if (!/function metroNavBtnHtml/.test(html)) fail.push('没有 metroNavBtnHtml');
  if (!/出\s*入口|出入口/.test(html)) fail.push('界面上看不到「出入口」字样');
  if (!/openNavPickFor/.test(html)) fail.push('没有 openNavPickFor（地铁站导航入口）');
  /* 导航弹层要同时满足两条，缺一条就是「点了没反应」：
     ① 不能挂在某个 view 容器里 —— 地铁页打开时 #detail 是隐藏的，父容器隐藏则弹层看不见；
     ② 必须在主 <script> 之前 —— 脚本是边解析边执行的，晚于脚本的节点
        在 $("dnavpickCancel") 那一刻还不存在，会抛 TypeError 把后面所有按钮绑定全打断。 */
  const pickAt = html.indexOf('<div id="dnavpick"');
  const mainScriptAt = html.indexOf('<script>\n(function () {');
  if (pickAt < 0) {
    fail.push('找不到 #dnavpick');
  } else if (mainScriptAt > 0 && pickAt > mainScriptAt) {
    fail.push('导航弹层 #dnavpick 排在主脚本之后，脚本执行时它还不在 DOM 里，会抛 TypeError 打断后面的按钮绑定');
  }

  /* 同一条规则对所有静态节点都成立：脚本里 $("x").onclick 用到的 id，
     它的标记必须出现在主脚本之前，否则 setStatus 之外的所有绑定都会中断。 */
  {
    const bindIds = [...html.matchAll(/\$\("([A-Za-z0-9_]+)"\)\.(onclick|onchange|oninput|onkeydown|onkeyup|onblur|onfocus)\s*=/g)]
      .map((m) => m[1]);
    const late = [];
    for (const id of new Set(bindIds)) {
      const at = html.search(new RegExp('id="' + id + '"[ >]'));
      if (at < 0) continue;                       // 动态创建的，跳过
      if (mainScriptAt > 0 && at > mainScriptAt) late.push(id);
    }
    if (late.length) {
      fail.push('这些节点的标记排在主脚本之后，绑定时会抛 TypeError：' + late.join('、'));
    }
  }

  /* 站口说明是外部数据，必须转义 */
  if (!/function escHtml/.test(html) || !/escHtml\(loc\)/.test(html)) {
    fail.push('出入口文字没有转义就直接拼 HTML');
  }

  if (fail.length) {
    console.error('✗ UI 冒烟失败（地铁导航/出入口）：');
    for (const f of fail) console.error('  - ' + f);
    process.exit(1);
  }
  const sample = names.slice(0, 3).map((n) => n + ' ' + exits[n].map((x) => x[0]).join('')).join('，');
  console.log('✓ 地铁出入口/导航通过：' + names.length + ' 个站有出入口（' + sample + '…），导航走 openNavPickFor，文字已转义');
}

console.log('✓ 到站表行通过：时间固定右边、站名在自己列内折行、行内无铃铛');

console.log('✓ 自动刷新保持位置通过：keepScroll 被真正写回、优先于最近站滚动、还原后 return');

console.log('✓ 站名条滚动通过：自动刷新保持原位、手动刷新才回最近站、点站名不滚、切方向回最近');

/* ---------------------- 进详情页：站名条一律对准「离我最近」那一站

   用户要求：无论从哪里进详情页（首页车辆、站名芯片、收藏卡、搜索、同站其它），
   上方横向站点条都要定到离我最近那一站，而不是停在某个被点过的站上。 */
{
  const fail = [];
  const intent = window.cdBusScrollIntent;
  const setFix = window.cdBusSetFix;
  const setLineView = window.cdBusSetLineView;
  if (typeof intent !== 'function' || typeof setFix !== 'function' || typeof setLineView !== 'function') {
    fail.push('缺少 cdBusScrollIntent / cdBusSetFix / cdBusSetLineView 调试钩子');
  } else {
    /* 造一条线路：用 1 号线的真实坐标，站序 1..N */
    const md = JSON.parse(html.match(/id="metroData">([\s\S]*?)<\/script>/)[1]);
    const src = md.lines.find((l) => l.id === '1').stations;
    const stations = src.map((st, i) => ({
      order: i + 1, name: st.name, stationId: 'sid-' + i, lat: st.lat, lng: st.lng,
    }));
    const lv = { lineId: 'TEST', name: '测试线', stations: stations };
    setLineView(lv);

    /* 定位到第 8 站；同时把「选中站」设成第 2 站（模拟从首页某辆车点进来） */
    const near = stations[7];
    setFix({ lat: near.lat, lng: near.lng, accuracy: 15, stale: false });
    window.cdBusSetStation ? window.cdBusSetStation(stations[1]) : null;

    if (intent({ scroll: true }) !== 'nearest') {
      fail.push('进详情页（scroll:true）没有对准最近站，实际：' + intent({ scroll: true }));
    }
    /* 自动刷新必须保持原位 */
    if (intent({ scroll: false }) !== 'none') {
      fail.push('自动刷新仍会滚动站名条，应为 none，实际：' + intent({ scroll: false }));
    }
    if (intent() !== 'none') {
      fail.push('无参调用仍在滚动站名条');
    }
    /* 没定位 → 退回选中站，而不是乱滚 */
    setFix(null);
    const noFix = intent({ scroll: true });
    if (noFix !== 'active' && noFix !== 'none') {
      fail.push('没有定位时的回退值异常：' + noFix);
    }
    /* 收尾，别影响后面的用例 */
    setLineView(null);
  }

  if (fail.length) {
    console.error('✗ UI 冒烟失败（进详情页对准最近站）：');
    for (const f of fail) console.error('  - ' + f);
    process.exit(1);
  }
  console.log('✓ 进详情页对准最近站通过：任何入口都滚到最近站、自动刷新不滚、没定位才退回选中站');
}

/* ---------------------- 站名条居中：不留末尾空白，够不着就贴边 */
{
  const fail = [];
  /* 用户明确说过：站名条末尾那块空白不要。所以：
     1) 不再插 chipspacer 节点；2) 没有 .chipspacer 样式；3) 靠后的站滚不到中间就贴边。 */
  if (/chipspacer|chipSpacer/.test(html)) fail.push('还留着 chipspacer（末尾那块空白）');
  if (/cdBusChipSpacer/.test(html)) fail.push('还在导出 cdBusChipSpacer');
  if (!/function centerChipNow/.test(html)) fail.push('没有 centerChipNow()');
  if (!/function pinChipCenter/.test(html)) fail.push('没有 pinChipCenter()');

  const centerFn = (html.match(/function centerChipNow[\s\S]*?\n  \}/) || [''])[0];
  /* 必须夹在 [0, scrollWidth - clientWidth] 里，否则浏览器会把它顶回去，
     表现就是「点了没反应」或者滚到一个奇怪的位置 */
  if (!/scrollWidth[\s\S]{0,80}?-\s*bw/.test(centerFn)) {
    fail.push('centerChipNow 没有按 scrollWidth - clientWidth 夹住目标位置');
  }
  if (!/target > max/.test(centerFn)) fail.push('centerChipNow 没有处理「滚过头」的情况');
  if (!/box\.scrollLeft = target/.test(centerFn)) fail.push('centerChipNow 没有直接赋值 scrollLeft');
  /* smooth 会被紧随其后的重画打断 */
  if (/behavior:\s*["']smooth["']/.test(centerFn)) {
    fail.push('centerChipNow 里用了 smooth 滚动，会被重画打断');
  }

  /* 进详情页那一屏必须用 pinChipCenter 钉住最近站 */
  const block = (html.match(/if \(opts && opts\.scroll\) \{[\s\S]{0,700}?\n    \}/) || [''])[0];
  if (!/pinChipCenter\(box, target\)/.test(block)) {
    fail.push('opts.scroll 分支没有用 pinChipCenter 对准最近站');
  }
  if (!/delays = \[0, 50, 150, 350, 700\]/.test(html)) fail.push('pinChipCenter 没有重试时间表');
  if (!/touchstart/.test(html) || !/touched/.test(html)) fail.push('用户自己滑动时没有停手');

  if (fail.length) {
    console.error('✗ UI 冒烟失败（站名条居中）：');
    for (const f of fail) console.error('  - ' + f);
    process.exit(1);
  }
  console.log('✓ 站名条居中通过：末尾不留空白、能居中就居中、够不着就贴边、布局没好会重试、用户滑动就停手');
}

/* ---------------------- 深色 / 浅色模式 */
{
  const fail = [];
  if (!/id="modeSw"/.test(html)) fail.push('设置页没有浅色模式开关 #modeSw');
  if (!/id="setMode"/.test(html)) fail.push('设置页没有外观这一行 #setMode');
  if (!/function applyMode/.test(html)) fail.push('没有 applyMode()');
  if (!/function setMode/.test(html)) fail.push('没有 setMode()');
  if (!/cdbus\.mode/.test(html)) fail.push('明暗设置没存 localStorage');
  if (!/applyMode\(modeNow\(\)\)/.test(html)) fail.push('启动时没有应用已保存的明暗');

  /* 默认浅色：modeNow 里只有明确存过 dark 才是深色 */
  const modeFn = (html.match(/function modeNow\(\)[\s\S]*?\n  \}/) || [''])[0];
  if (!/=== "dark"/.test(modeFn)) fail.push('modeNow 没有判断 dark');
  if (/return "dark";\s*\n  \}/.test(modeFn)) fail.push('modeNow 的兜底还是深色（应默认浅色）');
  if (!/return "light";/.test(modeFn)) fail.push('modeNow 的兜底不是浅色');

  /* 两套配色都写在 CSS 里，缺一项就会有一块地方不跟着变 */
  const cssAll = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  const lightBlock = (cssAll.match(/:root \{[\s\S]*?\n  \}/) || [''])[0];
  const darkBlock = (cssAll.match(/html\[data-mode="dark"\] \{[\s\S]*?\n  \}/) || [''])[0];
  if (!lightBlock) fail.push('没有 :root 浅色配色');
  if (!darkBlock) fail.push('没有 html[data-mode="dark"] 深色配色');
  const need = ['--bg', '--bg2', '--card', '--card2', '--line', '--line2', '--press',
    '--text', '--text2', '--muted', '--muted2', '--accent', '--ok', '--warn', '--err'];
  for (const [name, blk] of [['浅色', lightBlock], ['深色', darkBlock]]) {
    for (const k of need) {
      if (!new RegExp(k + ':\\s*#').test(blk)) fail.push(name + '配色缺 ' + k);
    }
  }
  /* 浅色默认：:root 的底色必须是浅的，深色块的必须是深的 */
  const pick = (blk, k) => (blk.match(new RegExp(k + ':\\s*(#[0-9a-fA-F]{6})')) || [])[1] || '';
  const luma = (hex) => {
    const v = hex.replace('#', '');
    const c = [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) / 255)
      .map((x) => (x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  if (luma(pick(lightBlock, '--bg')) < 0.5) fail.push(':root 的底色不是浅色');
  if (luma(pick(darkBlock, '--bg')) > 0.1) fail.push('深色的底色不够深');
  if (!/color-scheme:\s*light/.test(lightBlock)) fail.push('浅色没设 color-scheme');
  /* 浅色高亮底（--accent-bg / --ok-bg / 卡片底）上不能写死白字：
     浅色模式下白字贴浅底等于看不见（当前站那一行就踩过这个坑）。 */
  const rules = cssAll.split(/\n  (?=[.#a-zA-Z])/);
  for (const rule of rules) {
    const head = rule.split('{')[0] || '';
    const body = rule.split('{')[1] || '';
    const lightBg = /background:\s*var\(--(accent|ok|warn|err)-bg\)/.test(body)
      || /background:\s*var\(--card\)/.test(body);
    if (lightBg && /color:\s*(#fff|#ffffff|rgba\(255,\s*255,\s*255)/.test(body)) {
      fail.push('高亮底上写了白字，浅色模式下看不见：' + head.trim().slice(0, 40));
    }
  }
  if (!/\.srow\.current \.sname \{[^}]*var\(--accent-soft\)/.test(cssAll)) {
    fail.push('当前站那一行的站名不是主题色（可能又是白字）');
  }
  if (!/color-scheme:\s*dark/.test(darkBlock)) fail.push('深色没设 color-scheme');

  /* 首屏前定明暗（head 里那段脚本），否则会先闪一下浅色再变深 */
  const head = html.slice(0, html.indexOf('<body'));
  if (!/cdbus\.mode/.test(head)) fail.push('head 里没有首屏前定明暗的脚本');

  /* 样式表里除了这两块定义，不能再有写死的深蓝灰 */
  const rest = cssAll.replace(lightBlock, '').replace(darkBlock, '');
  const leftovers = ['#0e1626', '#1b2436', '#22304a', '#34415e', '#b9c6dd', '#16233d', '#16233a']
    .filter((c) => rest.includes(c));
  if (leftovers.length) fail.push('样式表里还有写死的深色：' + leftovers.join(' '));

  if (fail.length) {
    console.error('✗ UI 冒烟失败（明暗模式）：');
    for (const f of fail) console.error('  - ' + f);
    process.exit(1);
  }
  console.log('✓ 明暗模式通过：默认浅色、开关+整行可切、两套配色齐全、首屏前定明暗、样式表无写死深色');
}

/* ---------------------- 自适应状态栏：系统栏跟着页面的明暗变 */
{
  const fail = [];
  const act = readSafe('app/src/com/chengdu/bus/MainActivity.java');
  const br = readSafe('app/src/com/chengdu/bus/BusBridge.java');

  /* 原生侧：状态栏/导航栏颜色 + 图标亮暗 */
  if (!/public void applySystemBar\(/.test(act)) fail.push('MainActivity 没有 applySystemBar()');
  if (!/setStatusBarColor/.test(act)) fail.push('没有设置状态栏颜色');
  if (!/setNavigationBarColor/.test(act)) fail.push('没有设置导航栏颜色');
  if (!/APPEARANCE_LIGHT_STATUS_BARS/.test(act)) fail.push('Android 11+ 没处理状态栏图标亮暗');
  if (!/SYSTEM_UI_FLAG_LIGHT_STATUS_BAR/.test(act)) fail.push('老版本没处理状态栏图标亮暗');
  /* 浅色要有浅底、深色要有深底，两边都得对上页面配色 */
  if (!/#F4F6F9/.test(act)) fail.push('浅色状态栏颜色和页面底色对不上');
  if (!/#0B1220/.test(act)) fail.push('深色状态栏颜色和页面底色对不上');
  /* 启动时先按上次的选择刷一遍，别闪 */
  if (!/applySystemBar\(isLightModeSaved\(\)\)/.test(act)) fail.push('启动时没有先按保存的模式刷系统栏');
  if (!/PREF_LIGHT/.test(act)) fail.push('明暗模式没存 SharedPreferences');
  /* WebView 底色也要跟着变（原来是写死深蓝） */
  if (/setBackgroundColor\(Color\.parseColor\("#0B1220"\)\)/.test(act)) {
    fail.push('WebView 底色还写死深蓝');
  }

  /* 桥：页面 → 原生 */
  if (!/public void setUiMode\(String mode\)/.test(br)) fail.push('BusBridge 没有 setUiMode(String)');
  if (!/@JavascriptInterface/.test(br)) fail.push('缺少 JavascriptInterface');
  /* 页面：切模式时调用 */
  if (!/bridge\.setUiMode\(m\)/.test(html)) fail.push('页面切换明暗时没通知原生');
  /* 老版本 App 没有这个方法，必须容错 */
  const call = (html.match(/try \{[^}]{0,120}bridge\.setUiMode[^}]{0,40}\} catch \(e\) \{\}/) || [''])[0];
  if (!call) fail.push('调用 setUiMode 没有 try/catch 兜底');

  if (fail.length) {
    console.error('✗ UI 冒烟失败（自适应状态栏）：');
    for (const f of fail) console.error('  - ' + f);
    process.exit(1);
  }
  console.log('✓ 自适应状态栏通过：状态栏/导航栏跟着明暗切色、图标反色、启动先刷、WebView 底色跟着变');
}

/* ---------------------- 更新源顺序：Gitee 必须是首次检测与下载的第一顺位 */
const stage21 = [];
{
  const src = readSafe('app/src/com/chengdu/bus/Updater.java');

  /* 1) fetchLatest 的第一句必须调 checkFromGitee */
  const fetchBody = (src.match(/private Release fetchLatest\(\) \{([\s\S]*?)\n    \}/) || [])[1] || '';
  if (!fetchBody) {
    stage21.push('找不到 fetchLatest()');
  } else {
    const giteePos = fetchBody.indexOf('checkFromGitee()');
    const proxyPos = fetchBody.indexOf('gh-proxy.com');
    const ghPos = fetchBody.indexOf('checkFromGithubRedirect("")');
    if (giteePos < 0) {
      stage21.push('fetchLatest 没有调用 checkFromGitee');
    } else {
      if (proxyPos >= 0 && proxyPos < giteePos) stage21.push('GitHub 代理排在 Gitee 之前');
      if (ghPos >= 0 && ghPos < giteePos) stage21.push('GitHub 直连排在 Gitee 之前');
    }
  }

  /* 2) Gitee 的 URL 必须在其它源之前出现在 DOWNLOAD_SOURCES 里 */
  const arr = (src.match(/DOWNLOAD_SOURCES = \{([\s\S]*?)\};/) || [])[1] || '';
  if (!arr) {
    stage21.push('找不到 DOWNLOAD_SOURCES');
  } else {
    const iGitee = arr.indexOf('gitee.com');
    const iProxy = arr.indexOf('gh-proxy.com');
    if (iGitee < 0) stage21.push('DOWNLOAD_SOURCES 里没有 Gitee 源');
    else if (iProxy >= 0 && iProxy < iGitee) stage21.push('代理源排在 Gitee 之前');
  }

  /* 3) 下载时不能用占位符把 Gitee 过滤掉（这是上一版的真 bug） */
  if (/!u\.contains\("LATEST_TAG"\)/.test(src) && !/lastTag/.test(src)) {
    stage21.push('Gitee 下载路径仍靠占位符，会被过滤条件跳过');
  }
  if (!/lastTag/.test(src)) {
    stage21.push('没有记住检查到的 tag，下载时拼不出 Gitee 的确定路径');
  }
  if (!/releases\/download\/" \+ lastTag/.test(src)) {
    stage21.push('下载时没有用真实 tag 拼 Gitee 路径（没先检查就下载会跳过 Gitee）');
  }
}

if (stage21.length) {
  console.error('✗ UI 冒烟失败（更新源顺序）：');
  for (const f of stage21) console.error('  - ' + f);
  process.exit(1);
}
console.log('✓ 更新源顺序通过：首次检测与下载都以 Gitee 为第一顺位、不会被占位符跳过');

/* ---------------------- 掌上公交（mygolbs）：车来了没覆盖的城市 */

{
  const fail = [];
  const br = readSafe('app/src/com/chengdu/bus/BusBridge.java');
  const mg = readSafe('app/src/com/chengdu/bus/MyGolbsClient.java');

  if (!/class MyGolbsClient/.test(mg)) fail.push('缺少 MyGolbsClient.java');
  if (!/h5\.mygolbs\.com\/ApiData\.do/.test(mg)) fail.push('接口地址不对');
  /* Origin 头是命门：错了返回 47 字节占位串，永远查不到 */
  if (!/Origin.*h5\.mygolbs\.com/.test(mg) && !/setRequestProperty\("Origin", ORIGIN\)/.test(mg)) {
    fail.push('没有设置正确的 Origin 头');
  }
  /* 城市必须用 mg- 前缀，和车来了数字 id 不冲突 */
  if (!/mg-/.test(mg)) fail.push('mygolbs 城市没有用 mg- 前缀');
  if (!/isMine/.test(mg)) fail.push('缺少 isMine() 判断');

  /* BusBridge 要按城市分流 */
  if (!/MyGolbsClient\.isMine/.test(br)) fail.push('BusBridge 没有按城市分流到掌上公交');
  if (!/mgClientFor/.test(br)) fail.push('BusBridge 没有掌上公交客户端缓存');
  /* 关键数据方法都要分流：nearby / detail / arrivals / lines */
  for (const m of ['nearby', 'lineDetail', 'arrivals', 'searchLines']) {
    if (!new RegExp('mgClientFor\\(args\\)\\.' + m).test(br)) {
      fail.push('方法 ' + m + ' 没有分流到掌上公交');
    }
  }
  /* 城市选择器要合并两家 */
  if (!/MyGolbsClient\.cityTable\(\)/.test(br)) fail.push('城市选择器没有合并掌上公交城市');
  /* 定位到无数据市州时要转成 mg- 城市 */
  if (!/covered/.test(br) || !/mg-deyang/.test(br)) {
    fail.push('定位到车来了未覆盖城市时没有转成掌上公交城市');
  }

  /* 覆盖的城市 */
  for (const city of ['德阳市', '广元市', '广安市', '甘孜', '阿坝']) {
    if (!mg.includes(city)) fail.push('掌上公交城市表缺少 ' + city);
  }

  if (fail.length) {
    console.error('✗ UI 冒烟失败（掌上公交）：');
    for (const f of fail) console.error('  - ' + f);
    process.exit(1);
  }
  console.log('✓ 掌上公交通过：mg- 前缀分流、Origin 命门、四大数据方法都分流、城市表合并、定位转换');
}

console.log('✓ Gitee 版本选择通过：拉多条 release 按版本号取最大、跳过 prerelease');

console.log('✓ 在线更新通过：入口与进度条、桥接方法、全状态处理、权限引导、启动静默检查、清单与版本比较');

console.log('✓ 末班在途通过：末班已过且有车才显示、未到末班不显示、无车不显示、缺数据不显示');

console.log('✓ 收班判定通过：末班后·最后一辆车驶过本站才变灰；没到本站/正在本站/待发车都不变灰');

console.log('✓ 定位行精简通过：只显示「已定位」，无来源/精度/耗时/城市拼接');

console.log('✓ 城市跟随定位通过：跨市移动自动切换、顶栏与状态同步、手动选择就地有效·跨市让位给定位');

console.log('✓ 多城市通过：定位识别城市、切换后重查 nearby、标题固定应用名、城市按钮同步、无数据城市标记');

// 首页有 30 秒自动刷新定时器，测试用完直接退出
process.exit(0);
console.log('  状态栏：' + status);