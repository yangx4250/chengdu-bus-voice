/**
 * 掌上公交（mygolbs）数据源 —— 车来了没覆盖的四川城市（德阳/广元/广安/甘孜/阿坝）。
 *
 * 与 app/src/com/chengdu/bus/MyGolbsClient.java 一一对应，用来做真实接口的冒烟测试。
 *
 * 接口：POST https://h5.mygolbs.com/ApiData.do（application/x-www-form-urlencoded）
 * 无签名、无 token、无加密，直接返回 JSON。
 * 命门：Origin 必须是 https://h5.mygolbs.com（末尾无斜杠）。
 */

const API = 'https://h5.mygolbs.com/ApiData.do';
const UA = 'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36';

export const MG_CITIES = [
  { cityId: 'mg-deyang', name: '德阳市' },
  { cityId: 'mg-guangyuan', name: '广元市' },
  { cityId: 'mg-guangan', name: '广安市' },
  { cityId: 'mg-ganzi', name: '甘孜藏族自治州' },
  { cityId: 'mg-aba', name: '阿坝藏族羌族自治州' },
];

export function isMine(cityId) {
  return typeof cityId === 'string' && cityId.startsWith('mg-');
}

export function cityNameOfId(cityId) {
  return MG_CITIES.find((c) => c.cityId === cityId)?.name || '';
}

export function cityIdOfName(name) {
  if (!name) return '';
  const key = String(name).trim();
  return MG_CITIES.find((c) => c.name === key || c.name.replace('市', '') === key)?.cityId || '';
}

function parseAway(text) {
  if (!text) return 0;
  const m = String(text).match(/(\d+)\s*站/);
  return m ? parseInt(m[1], 10) : 0;
}

function parseEta(text) {
  if (!text) return -1;
  if (text.includes('即将到站')) return 0;
  const m = String(text).match(/(\d+)\s*分钟/);
  return m ? parseInt(m[1], 10) * 60 : -1;
}

export class MyGolbsClient {
  constructor(cityId) {
    this.cityId = cityId;
    this.cityName = cityNameOfId(cityId) || cityId;
  }

  async cmd(params) {
    const res = await fetch(API, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        Origin: 'https://h5.mygolbs.com',
        Referer: 'https://h5.mygolbs.com/',
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json, text/plain, */*',
      },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(18000),
    });
    const text = await res.text();
    const json = JSON.parse(text);
    if (String(json.status) === '1') return json;
    throw new Error(json.msg || '接口返回失败');
  }

  base(cmd) {
    return { CMD: cmd, CITYNAME: this.cityName };
  }

  /** 线路搜索：城市线路目录里筛 lineName 含关键字的，按 lineName+方向去重。 */
  async searchLines(keyword) {
    const data = await this.cmd(this.base('119'));
    const lines = data.buslines || [];
    const kw = (keyword || '').trim();
    const seen = new Set();
    const out = [];
    for (const line of lines) {
      const name = line.lineName || '';
      if (!name) continue;
      if (kw && !name.includes(kw)) continue;
      const dir = line.upperOrDown === '2' ? 1 : 0;
      const key = name + '|' + dir;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        lineId: name,
        name,
        direction: dir,
        startSn: line.from || '',
        endSn: line.to || '',
        firstTime: line.beginTime || '',
        lastTime: line.endTime || '',
      });
      if (out.length >= 30) break;
    }
    return out;
  }

  async searchStations(keyword) {
    const data = await this.cmd({ ...this.base('102'), KEYWORD: keyword || '' });
    const out = [];
    for (const st of data.data || []) {
      const name = st.stationName || st.name || '';
      if (!name) continue;
      out.push({
        stationId: st.stationID || name,
        name,
        lat: st.lat ?? st.station_lat ?? 0,
        lng: st.lon ?? st.station_lon ?? 0,
        distance: st.dis ?? st.distance ?? 0,
      });
    }
    return out;
  }

  /** 附近站点 + 每条线路最近一辆车。CMD=106 → CMD=105。 */
  async nearby(lat, lng, limit = 5) {
    const data = await this.cmd({ ...this.base('106'), LAT: String(lat), LNG: String(lng) });
    const near = data.data || [];
    const stops = [];
    const allArrivals = [];
    for (const st of near.slice(0, limit)) {
      const name = st.name || '';
      const stop = {
        stationId: name,
        name,
        distanceMeters: st.dis || 0,
        lat: st.lat || 0,
        lng: st.lon || 0,
        arrivals: [],
        lineNameList: [],
      };
      try {
        const lines = await this.cmd({
          ...this.base('105'), STATIONNAME: name, MYLAT: '', MYLNG: '',
        });
        const dedup = new Set();
        for (const line of lines.data || []) {
          const lineName = line.lineName || '';
          if (!lineName) continue;
          if (!dedup.has(lineName)) {
            dedup.add(lineName);
            stop.lineNameList.push(lineName);
          }
          const nearText = line.neartext || '';
          const away = Number.isFinite(line.busToStationCount) ? line.busToStationCount : parseAway(nearText);
          const arr = {
            stationId: name,
            stationName: name,
            stationOrder: line.stationOrder || 0,
            lineId: lineName,
            lineName,
            firstTime: line.beginTime || '',
            lastTime: line.endTime || '',
            toward: line.to || '',
            stationsAway: away,
            etaSeconds: parseEta(nearText) > 0 ? parseEta(nearText) : null,
            arrived: nearText.includes('即将到站') || away === 0,
          };
          stop.arrivals.push(arr);
          allArrivals.push(arr);
        }
      } catch (e) {
        // 单站失败不影响其它站点
      }
      stops.push(stop);
    }
    return { stops, allArrivals };
  }

  /** 线路详情：CMD=103。 */
  async lineDetail(lineId) {
    let name = lineId;
    let dir = 0;
    const bar = lineId.indexOf('|');
    if (bar > 0) {
      name = lineId.slice(0, bar);
      dir = parseInt(lineId.slice(bar + 1), 10) || 0;
    }
    const data = await this.cmd({ ...this.base('103'), LINENAME: name, DIRECTION: String(dir === 1 ? 2 : 1) });
    const sts = data.data || [];
    const loop = data.loopType === 1;
    const stations = sts.map((st, i) => ({
      stationId: st.stationName || String(st.stationOrder || i + 1),
      order: st.stationOrder || i + 1,
      rawOrder: st.stationOrder || i + 1,
      name: st.stationName || st.showName || '',
      lat: st.station_lat || 0,
      lng: st.station_lon || 0,
      suspended: false,
      specialLabel: '',
      specialNote: '',
      loop,
      loopLen: sts.length,
    }));
    return {
      lineId,
      name: data.routeName || name,
      startSn: stations[0]?.name || '',
      endSn: stations[stations.length - 1]?.name || '',
      firstTime: data.beginTime || '',
      lastTime: data.endTime || '',
      price: data.commonts || '',
      depDesc: '',
      depIntervalM: -1,
      departLeft: 0,
      departRight: 0,
      intervalLeft: -1,
      intervalRight: -1,
      preArrivalTime: data.planTime || '',
      stations,
    };
  }

  /** 到站：CMD=104。 */
  async arrivals(lineId, station) {
    let name = lineId;
    let dir = 0;
    const bar = lineId.indexOf('|');
    if (bar > 0) {
      name = lineId.slice(0, bar);
      dir = parseInt(lineId.slice(bar + 1), 10) || 0;
    }
    const data = await this.cmd({
      ...this.base('104'),
      LINENAME: name,
      DIRECTION: String(dir === 1 ? 2 : 1),
      STATIONORDER: String(station.order || 1),
    });
    const out = [];
    for (const f of data.routeOnStationRTimeInfoList || []) {
      const plate = f.busNumber || '';
      if (!plate) continue;
      let away = parseAway(f.busToStationTips || '');
      if (Number.isFinite(f.busToStationCount)) away = f.busToStationCount;
      const etaMin = f.busToStationTime ?? -1;
      out.push({
        busId: plate,
        plate,
        order: away,
        stationsAway: away,
        distanceMeters: f.busToStationDistance ?? -1,
        etaSeconds: etaMin > 0 ? etaMin * 60 : null,
        arrivalAt: null,
      });
    }
    out.sort((a, b) => a.stationsAway - b.stationsAway);
    return out;
  }

  /** 单车逐站矩阵。 */
  async stationMatrix(lineId, fromOrder, window) {
    const detail = await this.lineDetail(lineId);
    const targets = detail.stations.filter((st) => st.order >= fromOrder).slice(0, window);
    const buses = new Map();
    for (const st of targets) {
      let arr;
      try { arr = await this.arrivals(lineId, st); } catch (e) { continue; }
      for (const bus of arr) {
        const key = bus.busId;
        if (!key) continue;
        if (!buses.has(key)) {
          buses.set(key, { busId: key, plate: bus.plate, order: bus.order, times: [] });
        }
        buses.get(key).times.push({
          order: st.order,
          name: st.name,
          etaSeconds: bus.etaSeconds ?? -1,
          arrivalAt: bus.arrivalAt,
        });
      }
    }
    return { buses: [...buses.values()] };
  }
}
