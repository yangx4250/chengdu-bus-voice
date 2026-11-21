/**
 * 车来了（Chelaile）微信小程序接口客户端 —— 只开放成都。
 *
 * 背景：网上流传的 PHP 版（gist Ancientwood/774898f4…）走的是老的 App 接口
 * api.chelaile.net.cn/bus/*，现在整站返回 12009「该版本已不提供服务」。
 * 现行可用的是小程序接口 web.chelaile.net.cn/api/bus/*：
 *   - 请求签名  cryptoSign = md5( `"k"="v"&…` + "qwihrnbtmj" )
 *   - 返回体    encryptResult = base64( AES-256-ECB( json ) )
 * 这些参数来自社区逆向实现（SuperL-2233/chelaile-API），会随官方版本变动。
 */

import crypto from 'node:crypto';

const BASE = 'https://web.chelaile.net.cn/api/bus/';
const SIGN_SALT = 'qwihrnbtmj';
const AES_KEY = Buffer.from('FF32AE65FBFD19414EAAFF6291A54B42', 'utf8');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) ' +
  'NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13) ' +
  'UnifiedPCWindowsWechat(0xf254160a) XWEB/18055';

const BASE_PARAMS = {
  s: 'h5',
  wxs: 'wx_app',
  sign: '1',
  h5RealData: '1',
  v: '3.11.28',
  src: 'weixinapp_cx',
  ctm_mp: 'mp_wx',
  vc: '2',
  favoriteGray: '1',
  gpstype: 'wgs',
  geo_type: 'wgs',
  scene: '1256',
};

/** 成都：小程序 cityId=007，线路 lineId 前缀 028。其它城市一律拒绝。 */
export const CHENGDU = Object.freeze({ cityId: '007', name: '成都', areaCode: '028' });

/** 支持的城市：成都（含区县）与都江堰；两者在车来了数据里互通（007 即可查到都江堰线路）。 */
export const SUPPORTED_CITIES = Object.freeze({
  '007': '成都',
  '271': '都江堰',
});

export class BusApiError extends Error {
  constructor(message, { endpoint, status } = {}) {
    super(message);
    this.name = 'BusApiError';
    this.endpoint = endpoint;
    this.status = status;
  }
}

function cryptoSign(params) {
  const raw = Object.entries(params).map(([k, v]) => `"${k}"="${v}"`).join('&') + SIGN_SALT;
  return crypto.createHash('md5').update(raw, 'utf8').digest('hex');
}

function decrypt(encryptResult) {
  const decipher = crypto.createDecipheriv('aes-256-ecb', AES_KEY, null);
  decipher.setAutoPadding(true);
  return Buffer.concat([
    decipher.update(Buffer.from(encryptResult, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

/** 响应外面裹了 **YGKJ…YGKJ## 广告前缀，取第一个完整 JSON 对象。 */
function extractEnvelope(raw) {
  const start = raw.indexOf('{');
  if (start < 0) throw new BusApiError(`响应不是 JSON：${raw.slice(0, 120)}`);
  let depth = 0;
  for (let i = start; i < raw.length; i += 1) {
    if (raw[i] === '{') depth += 1;
    else if (raw[i] === '}') {
      depth -= 1;
      if (depth === 0) return JSON.parse(raw.slice(start, i + 1));
    }
  }
  throw new BusApiError(`响应 JSON 被截断：${raw.slice(0, 120)}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class BusClient {
  constructor({ cityId = CHENGDU.cityId, timeoutMs = 15000, retries = 2 } = {}) {
    this.cityId = cityId;
    this.timeoutMs = timeoutMs;
    this.retries = retries;
  }

  async #call(endpoint, params = {}) {
    const query = { ...BASE_PARAMS, cityId: this.cityId, localCityId: this.cityId, ...params };
    query.cryptoSign = cryptoSign(query);
    const url = `${BASE}${endpoint}?${new URLSearchParams(query)}`;

    let lastError;
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      try {
        const res = await fetch(url, {
          headers: {
            'User-Agent': UA,
            'xweb_xhr': '1',
            'Content-Type': 'text',
            'Accept': '*/*',
            'Referer': 'https://servicewechat.com/wx71d589ea01ce3321/814/page-frame.html',
            'Accept-Language': 'zh-CN,zh;q=0.9',
          },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!res.ok) throw new BusApiError(`HTTP ${res.status}`, { endpoint, status: res.status });

        const envelope = extractEnvelope(await res.text());
        const jsonr = envelope.jsonr ?? {};
        const status = jsonr.status;
        if (status && !['00', '0000', '0'].includes(status)) {
          const msg = jsonr.errmsg || `接口返回状态 ${status}`;
          throw new BusApiError(msg, { endpoint, status });
        }
        const data = jsonr.data ?? {};
        return data.encryptResult ? JSON.parse(decrypt(data.encryptResult)) : data;
      } catch (err) {
        lastError = err;
        if (err instanceof BusApiError && err.status && err.status < 500) throw err;
        if (attempt < this.retries) await sleep(400 * (attempt + 1));
      }
    }
    throw lastError;
  }

  /**
   * 用坐标做反向城市判断（车来了公开的 citylist 接口，无需签名）。
   * 不是成都就直接拒绝，保证「只播成都公交」。
   */
  async assertChengdu({ lat, lng, required = false } = {}) {
    if (lat == null || lng == null) {
      if (required) throw new BusApiError('缺少坐标，无法确认所在城市（本工具只支持成都）。');
      return CHENGDU;
    }
    const url = new URL('https://web.chelaile.net.cn/cdatasource/citylist');
    url.searchParams.set('type', 'gpsRealtimeCity');
    url.searchParams.set('lat', String(lat));
    url.searchParams.set('lng', String(lng));
    url.searchParams.set('gpstype', 'wgs');
    url.searchParams.set('s', 'android');
    url.searchParams.set('v', '3.80.0');
    url.searchParams.set('src', 'webapp_default');

    const res = await fetch(url, { signal: AbortSignal.timeout(this.timeoutMs) });
    const payload = await res.json().catch(() => ({}));
    const city = payload?.data?.gpsRealtimeCity;
    if (!city) throw new BusApiError('城市定位服务不可用，无法确认当前位置。');
    const supported = SUPPORTED_CITIES[String(city.cityId)] ?? SUPPORTED_CITIES[city.cityId];
    if (!supported) {
      throw new BusApiError(`当前位置属于「${city.cityName}」，本工具目前只支持成都（含都江堰）。`);
    }
    return { cityId: String(city.cityId), name: supported };
  }

  /** 线路搜索：按线路号/关键字，成都范围内。 */
  async searchLines(keyword) {
    const data = await this.#call('query!nSearch.action', {
      key: keyword,
      supportPhyStn: 'true',
    });
    const lines = data?.result?.lines ?? [];
    return lines
      .filter((line) => {
        if (Number(line.subwayV2) === 1) return false;      // 地铁
        if (String(line.name ?? '').startsWith('地铁')) return false;
        return true;   // 都江堰等区县线路是纯数字 lineId，不能再按 028 前缀过滤
      })
      .map((line) => ({
        lineId: line.lineId,
        name: line.name,
        direction: line.direction ?? 0,
        startSn: line.startSn ?? '',
        endSn: line.endSn ?? '',
        firstTime: line.firstTime ?? '',
        lastTime: line.lastTime ?? '',
        caption: `${line.name}路（${line.startSn || '?'} → ${line.endSn || '?'}）`,
      }));
  }

  /** 线路详情：首末班、票价、全部站点（含 sId / order / 坐标）。 */
  async lineDetail(lineId) {
    const data = await this.#call('line!encryptedLineDetail.action', {
      lineId,
      lat: '',
      lng: '',
      geo_lat: '',
      geo_lng: '',
    });
    const line = data.line ?? {};
    const stations = (data.stations ?? []).map((st) => ({
      stationId: st.sId,
      order: st.order,
      name: st.sn,
      lat: st.wgsLat,
      lng: st.wgsLng,
    }));
    return {
      lineId: line.lineId ?? lineId,
      name: line.name ?? '',
      startSn: line.startSn ?? '',
      endSn: line.endSn ?? '',
      firstTime: line.firstTime ?? '',
      lastTime: line.lastTime ?? '',
      price: line.price ?? '',
      stations,
    };
  }

  /**
   * 指定线路 + 站点的实时到站。
   * @returns {{station, buses:[{order, stationsAway, distanceMeters, etaSeconds, arrivalAt, arrived}]}}
   */
  async arrivals(lineId, station) {
    const data = await this.#call('line!encryptedBusDetail.action', {
      cshow: 'busDetail',
      specail: '0',
      specialType: 'undefined',
      lineId,
      targetOrder: String(station.order),
      specialTargetOrder: String(station.order),
      stationId: station.stationId,
      lat: String(station.lat ?? ''),
      lng: String(station.lng ?? ''),
      geo_lat: String(station.lat ?? ''),
      geo_lng: String(station.lng ?? ''),
      userId: '',
      h5Id: '',
      unionId: '',
      accountId: '',
      secret: '',
    });

    const buses = (data.buses ?? [])
      .filter((bus) => Number(bus.distanceToWaitStn) >= 0) // 已过站的车辆没有 distanceToWaitStn
      .map((bus) => {
        const travel = (bus.travels ?? [])[0] ?? {};
        const stationsAway = Math.max(0, Number(station.order) - Number(bus.order ?? 0));
        const etaSeconds = Number.isFinite(travel.travelTime) ? travel.travelTime : null;
        return {
          order: bus.order,
          stationsAway,
          distanceMeters: Number(bus.distanceToWaitStn),
          etaSeconds,
          arrivalAt: travel.arrivalTime ?? null, // epoch ms
          arrived: stationsAway <= 0,
        };
      })
      .sort((a, b) => a.stationsAway - b.stationsAway);

    return { station, buses };
  }

  /** 附近站点：每个站点的线路 + 每条线最近一辆车的到站信息。 */
  async nearby(lat, lng, { limit = 5 } = {}) {
    const data = await this.#call('stop!homePageInfo.action', {
      type: '1',
      act: '2',
      lat: String(lat),
      lng: String(lng),
      geo_lat: String(lat),
      geo_lng: String(lng),
    });

    const arrivals = (data.lines ?? []).map((entry) => {
      const target = entry.targetStation ?? {};
      const state = entry.stnState ?? {};
      const stationsAway =
        target.order != null && state.order != null ? Math.max(0, target.order - state.order) : null;
      return {
        lineId: entry.line?.lineId,
        lineName: entry.line?.name,
        toward: entry.line?.endSn,
        stationName: target.sn,
        stationId: target.sId,
        stationsAway,
        etaSeconds: Number.isFinite(state.travelTime) ? state.travelTime : null,
        arrivalAt: state.arrivalTime ?? null,
        arrived: stationsAway === 0,
      };
    });

    const stops = (data.nearSts ?? []).slice(0, limit).map((st) => ({
      stationId: st.sId,
      name: st.sn,
      distanceMeters: st.distance,
      lines: st.lineNameList ?? [],
      arrivals: arrivals.filter((a) => a.stationId === st.sId),
    }));

    return { stops, allArrivals: arrivals };
  }
}