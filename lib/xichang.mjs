/**
 * 西昌公交（熊猫巴士 PandaBus 白牌站）—— 与 app/src/com/chengdu/bus/XichangClient.java 对应。
 *
 * 来源：逆向 月城公交 App (com.pandabus.android.yuecheng) 2.7.5。
 * 服务端址见 com.pandabus.android.yuecheng.common.Dictionarys：
 *   HOST_RELEASE = https://www.xcycgj.cn:8800 （POST，爱加密抽走了业务实现，逆不出参数）
 *   换乘查询     = https://www.xcycgj.cn:7777/search （GET，无 token，实测可用）
 *
 * 只有换乘规划能拿到。实时到站、附近站点、线路目录都拿不到（WAF + 加固）。
 *
 * ⚠️ 该站有阿里云 WAF：频繁请求返回 405 HTML（IP 级限制，换 UA 无效）。必须限速。
 */

import net from 'node:net';
import crypto from 'node:crypto';

const HOST = 'https://www.xcycgj.cn:7777';
/** 实时数据：裸 TCP，明文协议（不走 HTTP，抓包工具默认看不到）。 */
const RT_HOST = '39.108.28.78';
const RT_PORT = 1787;
const RT_MAGIC = 0x0000babe;
const RT_FIELDS = 24;
const CITY_CODE = 'xc';
const UA =
  'Mozilla/5.0 (Linux; Android 13; 2211133C) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/120.0.0.0 Mobile Safari/537.36';

/** 「107路下行(西宁-川兴车站)」→「107」：前端到处 lineName + "路"，不剥掉会显示「39路路」。 */
export function normalizeLineName(raw) {
  if (!raw) return '';
  let t = String(raw).trim();
  /* 括号有半角也有全角（如「环湖（建昌古城-建昌古城）」），两种都要截 */
  const cands = [t.indexOf('('), t.indexOf('（')].filter((i) => i > 0);
  if (cands.length) t = t.slice(0, Math.min(...cands));
  t = t.replace('上行', '').replace('下行', '').trim();
  if (t.endsWith('路')) t = t.slice(0, -1).trim();
  return t;
}

export const XICHANG = { cityId: 'xc-xichang', name: '西昌', transitOnly: true };

export class WafBlockedError extends Error {
  constructor() {
    super('西昌服务器临时限制访问，请稍后再试');
    this.name = 'WafBlockedError';
    this.waf = true;
  }
}

export function isMine(cityId) {
  return typeof cityId === 'string' && cityId.startsWith('xc-');
}

/** 「3路上行(63790部队-武警州支队二大队)」→「3路」 */
function shortLineName(full) {
  if (!full) return '';
  const head = full.includes('(') ? full.slice(0, full.indexOf('(')) : full;
  return head.replace('上行', '').replace('下行', '').trim();
}

export class XichangClient {
  constructor(cityId = XICHANG.cityId) {
    this.cityId = cityId;
    this.cityName = XICHANG.name;
    this.timeoutMs = 18000;
  }

  async #get(path) {
    const res = await fetch(HOST + path, {
      headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*' },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = (await res.text()).trim();
    if (!text.startsWith('{')) throw new WafBlockedError();
    if (res.status >= 400) throw new Error('西昌接口返回 HTTP ' + res.status);
    return JSON.parse(text);
  }

  /**
   * 换乘规划，结构对齐 lib/chelaile.mjs 的 transit。
   * 注意：西昌接受 WGS84 坐标，不做 GCJ-02 转换（转了反而偏）。
   */
  async transit(fromLat, fromLng, fromName, toLat, toLng, toName) {
    const q =
      `/search?cityCode=${CITY_CODE}` +
      `&startLat=${fromLat}&startLng=${fromLng}` +
      `&endLat=${toLat}&endLng=${toLng}`;
    const data = await this.#get(q);
    const routes = Array.isArray(data.result) ? data.result : [];
    const transits = routes.map((r) => {
      const segments = [];
      let busCount = 0;
      for (const seg of r.segments || []) {
        const bus = seg.bus;
        if (bus) {
          busCount += 1;
          segments.push({
            mode: 'bus',
            name: shortLineName(bus.routeName || ''),
            rawName: bus.routeName || '',
            lineId: String(bus.routeId || ''),
            from: bus.departStop?.name || '',
            to: bus.arriveStop?.name || '',
            viaNum: Array.isArray(bus.viaStops) ? bus.viaStops.length : 0,
            duration: Math.round((bus.duration || 0) / 60),
            firstTime: bus.startTime || '',
            lastTime: bus.endTime || '',
            price: bus.ticketPrice || '',
          });
        } else if (seg.walking) {
          const wd = Math.round(seg.walking.distance || 0);
          if (wd > 0) {
            segments.push({
              mode: 'walk',
              walkDistance: wd,
              duration: Math.round((seg.walking.duration || 0) / 60),
            });
          }
        }
      }
      return {
        duration: Math.round((r.duration || 0) / 60),
        walkingDistance: Math.round(r.walkDistance || 0),
        transferCount: Math.max(0, busCount - 1),
        tag: '',
        price: r.totalTicketPrice || '',
        stopCount: r.stopCount || 0,
        segments,
      };
    });
    return { transits, raw: routes };
  }
}

/**
 * 「线路名|开往」→ routeDirId。
 *
 * 界面（和执行 lib 的 CLI）沿用车来了的习惯，lineId 是 `1|观鸟岛湿地公园`
 * 这种合成串；协议只认数字方向 ID。拿合成串去查 seq=7 / 95，服务器会直接
 * 关闭连接，客户端等满 15 秒后只能报「服务器没响应」。
 */
const routeDirByLineId = new Map();
/** 线路名 → 该线路在附近数据里出现过的方向 ID（上下行），换向用。 */
const dirsByName = new Map();

const looseLineId = (x) => String(x).replace(/路/g, '').replace(/\s/g, '');

function lookupRouteDir(lineId) {
  const key = looseLineId(lineId);
  const hit = routeDirByLineId.get(lineId);
  if (hit) return hit;
  for (const [k, v] of routeDirByLineId) {
    if (looseLineId(k) === key) return v;
  }
  /* 只给线路名（没有「|开往」）时按名字取第一个方向 */
  const bare = key.includes('|') ? key.slice(0, key.indexOf('|')) : key;
  for (const [k, v] of routeDirByLineId) {
    const kb = looseLineId(k);
    if ((kb.includes('|') ? kb.slice(0, kb.indexOf('|')) : kb) === bare) return v;
  }
  return null;
}

/** 纯数字 → 原样返回；合成串 → 查 nearby 时登记过的映射，查不到再就近反查一次。 */
export async function routeDirIdOf(lineId) {
  const t = String(lineId == null ? '' : lineId).trim();
  if (!t) throw new Error('缺少线路 ID');
  if (/^\d+$/.test(t)) return t;
  const hit = lookupRouteDir(t);
  if (hit) return hit;
  /* 收藏/跨进程场景下映射可能是空的：用市中心坐标扫一次附近现捞 */
  try { await nearby(FALLBACK_LAT, FALLBACK_LNG, 8); } catch (e) { /* 服务器不通就往下报明确错误 */ }
  const again = lookupRouteDir(t);
  if (!again) throw new Error('这条线路暂时没有实时方向，先回首页刷新一次附近站点再进来');
  return again;
}

/** 兜底反查用的西昌市中心坐标（胜利路/顺城街一带，站最密）。 */
const FALLBACK_LAT = 27.8861;
const FALLBACK_LNG = 102.2820;

/**
 * 发一次实时查询，返回第一个带载荷的响应帧文本。
 *
 * 握手帧：magic + 长度0 + 序号0
 * 请求载荷：1;时间戳;xc;用户ID,设备ID;纬度,经度;纬度;经度;0
 * 响应：1;时间戳;0,<24字段/条>
 *
 * 不需要签名，userId/terminalKey 用随机 UUID 服务器照样返回数据。
 */
function rtQuery(seq, payload, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(RT_PORT, RT_HOST);
    let buf = Buffer.alloc(0);
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; sock.destroy(); reject(new Error('西昌实时服务器没响应')); } }, timeoutMs);
    const done = (v, err) => { if (settled) return; settled = true; clearTimeout(timer); sock.destroy(); err ? reject(err) : resolve(v); };

    sock.on('connect', () => {
      const frame = (body, seq) => {
        const h = Buffer.alloc(12);
        h.writeUInt32BE(RT_MAGIC, 0);
        h.writeUInt32BE(body.length, 4);
        h.writeUInt32BE(seq, 8);
        return Buffer.concat([h, body]);
      };
      sock.write(frame(Buffer.alloc(0), 0));
      sock.write(frame(Buffer.from(payload, 'utf8'), seq));
    });
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      let off = 0;
      while (buf.length - off >= 12) {
        if (buf.readUInt32BE(off) !== RT_MAGIC) { off = buf.length; break; }
        const len = buf.readUInt32BE(off + 4);
        if (len < 0 || len > 8 * 1024 * 1024) { off = buf.length; break; }
        if (buf.length - off - 12 < len) break;
        /* 只跳过握手回包（len=0）。「当地没车」的响应只有十几个字节，
           不能用 len>200 过滤，否则会一直等到超时。 */
        if (len > 0) return done(buf.slice(off + 12, off + 12 + len).toString('utf8'));
        off += 12 + len;
      }
      if (off > 0) buf = buf.slice(off);
    });
    sock.on('error', (e) => done(null, e));
  });
}

/** 0630 → 06:30 */
function hhmm(s) {
  const t = String(s || '').trim();
  return /^\d{4}$/.test(t) ? t.slice(0, 2) + ':' + t.slice(2) : t;
}

/** l1 / l2 = 即将进站；更大的编号协议没说含义，不猜。 */
function isArriving(status) {
  return status === 'l1' || status === 'l2';
}

/**
 * 附近站点实时车辆，结构对齐掌上公交的 nearby。
 *
 * 只报能确定的：协议给了「车距本站多少米」，但没有站表，
 * 算不出「还有几站 / 还有几分钟」，所以 stationsAway / etaSeconds 一律 null，
 * 界面改用 distanceMeters 显示距离。
 */
export async function nearby(lat, lng, limit = 5) {
  const dev = crypto.randomUUID();
  const payload = `1;${Date.now()};xc;${dev},${dev};${lat},${lng};${lat};${lng};0`;
  const text = await rtQuery(2, payload);
  const i1 = text.indexOf(';');
  const i2 = text.indexOf(';', i1 + 1);
  /* "1;<时间戳>;" = 这个位置附近没有车 */
  const f = (i2 < 0 || i2 + 1 >= text.length) ? [] : text.slice(i2 + 1).split(',');

  const byStation = new Map();
  const allArrivals = [];
  const total = f.length > 1 ? Math.floor((f.length - 1) / RT_FIELDS) : 0;
  for (let k = 0; k < total; k++) {
    const b = 1 + k * RT_FIELDS;
    if (b + RT_FIELDS > f.length) break;
    const stationName = (f[b + 6] || '').trim();
    const lineName = normalizeLineName(f[b + 2]);
    if (!stationName || !lineName) continue;
    const status = (f[b + 9] || '').trim();
    const arr = {
      /* 字段 4 是本站的站点 ID，和站表的 stationId 对得上 */
      stationId: (f[b + 4] || '').trim() || stationName,
      stationName,
      lineName,
      toward: (f[b + 10] || '').trim(),
      lineId: lineName + '|' + (f[b + 10] || '').trim(),
      /* 线路方向 ID 和目标站站序：补站数/ETA 要用 */
      routeDirId: (f[b + 1] || '').trim(),
      targetOrder: Math.round(Number(f[b + 5]) || 0),
      plate: (f[b + 0] || '').trim(),
      firstTime: hhmm(f[b + 13]),
      lastTime: hhmm(f[b + 14]),
      fare: (f[b + 12] || '').trim(),
      distanceMeters: Math.round(Number(f[b + 4]) || 0),
      busLat: Number(f[b + 7]) || 0,
      busLng: Number(f[b + 8]) || 0,
      etaSeconds: null,
      stationsAway: null,
      arrived: status.startsWith('p') ? false : isArriving(status),
    };
    if (status.startsWith('p')) arr.preStartTime = hhmm(f[b + 13]);
    if (!byStation.has(stationName)) {
      byStation.set(stationName, { dist: Math.round(Number(f[b + 3]) || 0), list: [] });
    }
    byStation.get(stationName).list.push(arr);
    allArrivals.push(arr);
    if (arr.routeDirId) {
      routeDirByLineId.set(arr.lineName + '|' + arr.toward, arr.routeDirId);
      routeDirByLineId.set((f[b + 2] || '').trim(), arr.routeDirId);
      const ids = dirsByName.get(arr.lineName) || new Set();
      ids.add(arr.routeDirId);
      dirsByName.set(arr.lineName, ids);
    }
  }

  const order = [...byStation.entries()].sort((a, b2) => a[1].dist - b2[1].dist);
  const stops = order.slice(0, limit).map(([name, grp]) => {
    /* 西昌按物理站点返回，同一条线的上下行各来一条：首页格子只写线路名，
       两条一起画就是「26路 26路」。同一线路只留第一条（详情页仍能换向）。 */
    const seen = new Set();
    const arrivals = grp.list.filter((a) => {
      if (!a.lineName) return true;
      if (seen.has(a.lineName)) return false;
      seen.add(a.lineName);
      return true;
    });
    return {
      stationId: name,
      name,
      distanceMeters: grp.dist,
      arrivals,
      lineNameList: [...seen],
    };
  });
  return { stops, allArrivals };
}

/** 0630 → 06:30 已在上面定义 */
const rtBody = (id) => `1;${Date.now()};xc;;;${id}`;

/**
 * 线路站表（协议 seq=7）。
 * routeDirId 就是附近接口里每条记录的第 2 个字段（107路上行=184、下行=185）。
 *
 * 响应：184:107路:0::0630:2100:20183:票价:1;1,2957,西宁,lat,lng;2,2958,火车北站,lat,lng;...
 */
export async function lineDetail(routeDirId) {
  routeDirId = await routeDirIdOf(routeDirId);
  const text = await rtQuery(7, rtBody(routeDirId));
  const parts = text.split(';');
  const out = { lineId: routeDirId, name: '', fullName: '', firstTime: '', lastTime: '', totalLength: '', price: '', stations: [] };
  if (parts.length < 3) return out;
  const head = parts[2].split(':');
  out.fullName = (head[1] || '').trim();
  out.name = normalizeLineName(out.fullName);
  out.firstTime = hhmm(head[4]);
  out.lastTime = hhmm(head[5]);
  out.totalLength = head[6] || '';
  out.price = (head[7] || '').trim();
  /* parts[3] 里是全部站点，用 ':' 分隔 */
  const block = parts.length > 3 ? parts[3] : '';
  const segs = block.split(':');
  for (let i = 0; i < segs.length; i++) {
    const f = segs[i].trim().split(',');
    if (f.length < 5) continue;
    out.stations.push({
      stationId: f[1],
      order: Math.round(Number(f[0]) || 0),
      name: f[2],
      lat: Number(f[3]) || 0,
      lng: Number(f[4]) || 0,
    });
  }
  if (out.stations.length) {
    out.startSn = out.stations[0].name;
    out.endSn = out.stations[out.stations.length - 1].name;
  }
  return out;
}

/**
 * 线路车辆位置 + 速率（协议 seq=95）。
 * 每辆车：routeDirId:线路名(含方向):车牌:车牌:lat:lng:速率km/h:距下一站米:下一站名:当前站序:实时ID:ts:ts:?:1
 */
/** seq=95 必须带 距站距离;站序;纬度;经度，少一个服务器都不回包。 */
export async function vehicles(routeDirId, dist = 0, order = 0, lat = 0, lng = 0) {
  routeDirId = await routeDirIdOf(routeDirId);
  const text = await rtQuery(95, `1;${Date.now()};xc;;;${routeDirId};${dist};${order};${lat};${lng}`);
  const parts = text.split(';');
  const out = [];
  for (let i = 2; i < parts.length; i++) {
    const f = parts[i].trim().split(':');
    if (f.length < 11) continue;
    out.push({
      routeDirId: f[0],
      lineName: normalizeLineName(f[1]),
      plate: f[2],
      lat: Number(f[4]) || 0,
      lng: Number(f[5]) || 0,
      speedKmh: Number(f[6]) || 0,
      /* 字段 7 是下一站的站点 ID，不是距离 */
      nextStationId: (f[7] || '').trim(),
      nextStation: f[8],
      order: Math.round(Number(f[9]) || 0),
      realtimeId: f[10],
    });
  }
  return out;
}

/**
 * 到站：用车辆站序 + 目标站站序算剩余站数，用速率和平均站距算 ETA。
 *
 * 站数公式 目标站序 − 车辆站序 + 1：拿官方 App 的「4站 / 15站」逐条对过。
 * 车速 < 5km/h 当作停站，不给 ETA（给 0 或无穷都是假的）。
 */
const stationCache = new Map();

/** 两点球面距离（米）。 */
export function distanceMeters(lat1, lng1, lat2, lng2) {
  const r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r;
  const dLng = (lng2 - lng1) * r;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(x));
}

/** 站表坐标 [[站序,纬度,经度], ...]，带缓存。 */
async function stationPoints(routeDirId) {
  if (stationCache.has(routeDirId)) return stationCache.get(routeDirId);
  const d = await lineDetail(routeDirId);
  if (!d.stations.length) return null;
  const pts = d.stations.map((x) => [x.order, x.lat, x.lng]);
  stationCache.set(routeDirId, pts);
  return pts;
}

/**
 * 按车辆位置和目标站序算剩余站数、剩余距离、ETA。
 *
 * 距离一律用站表坐标现算：
 * 附近接口的字段 4 和 seq=95 的字段 7 都是站点 ID（不是米），
 * seq=96 的值和实算距离比值在 0.02~0.12 之间浮动，不是米。
 * 站表坐标算出的全程和协议头声明只差 0.1%。
 */
export async function progress(v, routeDirId, targetOrder) {
  const busOrder = v.order || 0;
  if (busOrder <= 0) return { stationsAway: null, etaSeconds: null, remainingMeters: null, arrived: false };
  const away = targetOrder > 0 ? targetOrder - busOrder + 1 : null;
  const out = {
    stationsAway: away !== null && away > 0 ? away : null,
    arrived: away !== null && away <= 1,
    /* 车已开过目标站 */
    passed: away !== null && away <= 0,
    etaSeconds: null,
    remainingMeters: null,
  };

  const pts = await stationPoints(routeDirId);
  if (!pts) return out;
  let meters = 0;
  for (let i = 0; i < pts.length; i++) {
    const [ord, lat, lng] = pts[i];
    if (ord < busOrder + 1) continue;
    if (ord > targetOrder) break;
    if (ord === busOrder + 1) meters += distanceMeters(v.lat, v.lng, lat, lng);
    else meters += distanceMeters(pts[i - 1][1], pts[i - 1][2], lat, lng);
  }
  if (meters <= 0) return out;
  /* 距离先给出来（停站的车也能显示还有多远） */
  out.remainingMeters = Math.round(meters);
  /* 已经很近（<100 米）就直接算进站，别显示「还有 2 站 / 0 分钟」 */
  if (meters < 100) {
    out.arrived = true;
    out.stationsAway = 1;
    return out;
  }
  /* 停站/已过站/已到站都不给 ETA：拿 0 当速率除会得出无穷，编一个又是假的 */
  if (out.arrived || out.passed || !v.speedKmh || v.speedKmh < 5) return out;
  out.etaSeconds = Math.round(meters / (v.speedKmh * 1000 / 3600));
  return out;
}

/** 到站。站数公式：目标站序 − 车辆站序 + 1（和官方 App 的「4站」对过）。 */
export async function arrivals(routeDirId, station) {
  routeDirId = await routeDirIdOf(routeDirId);
  const targetOrder = station && station.order ? Number(station.order) : 0;
  const veh = await vehicles(routeDirId, (station && station.stationId) || 0, targetOrder,
    (station && station.lat) || 0, (station && station.lng) || 0);
  const out = [];
  for (const v of veh) {
    const p = await progress(v, routeDirId, targetOrder);
    out.push({
      lineId: routeDirId,
      lineName: v.lineName,
      plate: v.plate,
      lat: v.lat,
      lng: v.lng,
      nextStation: v.nextStation,
      order: v.order,
      speedKmh: v.speedKmh,
      ...p,
    });
  }
  return out;
}

/**
 * 同一条线路的两个方向 + 各自首末班（详情页换向芯片用）。
 *
 * 协议没有「按名字查线路」的接口，方向 ID 只能从两处来：
 *   1. 附近接口里同名线路出现过的方向（上下行都在跑时最可靠）；
 *   2. 兜底探测 routeDirId ± 1，站表线路名对得上才算
 *      （实测 39路=412/413、107路=184/185、11路=64/65 相邻；环线如 1路=2 没有反向）。
 */
export async function directions(routeDirId) {
  const cur = await routeDirIdOf(routeDirId);
  let curDetail;
  try { curDetail = await lineDetail(cur); } catch (e) { return []; }
  const name = curDetail.name;
  const ids = [cur];
  const known = dirsByName.get(name);
  if (known) for (const id of known) if (!ids.includes(id)) ids.push(id);
  if (ids.length < 2) {
    const base = Number(cur);
    if (Number.isFinite(base)) {
      for (const cand of [base + 1, base - 1]) {
        if (cand <= 0) continue;
        try {
          const d = await lineDetail(String(cand));
          if (d.name === name && d.stations.length > 0) { ids.push(String(cand)); break; }
        } catch (e) { /* 探测失败就当没有反向 */ }
      }
    }
  }
  const out = [];
  for (const id of ids) {
    let d = id === cur ? curDetail : null;
    if (!d) { try { d = await lineDetail(id); } catch (e) { continue; } }
    if (!d || !d.stations.length) continue;
    out.push({
      lineId: id, name: d.name, fullName: d.fullName,
      firstTime: d.firstTime, lastTime: d.lastTime,
      startSn: d.startSn || '', endSn: d.endSn || '',
    });
  }
  return out;
}
