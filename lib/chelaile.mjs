/**
 * 车来了（Chelaile）微信小程序接口客户端 —— 四川全省多城市。
 *
 * 背景：网上流传的 PHP 版（gist Ancientwood/774898f4…）走的是老的 App 接口
 * api.chelaile.net.cn/bus/*，现在整站返回 12009「该版本已不提供服务」。
 * 现行可用的是小程序接口 web.chelaile.net.cn/api/bus/*：
 *   - 请求签名  cryptoSign = md5( `"k"="v"&…` + "qwihrnbtmj" )
 *   - 返回体    encryptResult = base64( AES-256-ECB( json ) )
 * 这些参数来自社区逆向实现（SuperL-2233/chelaile-API），会随官方版本变动。
 *
 * 多城市要点：同一套接口，只把 cityId / localCityId 换掉就能查别的城市。
 * 城市清单见 lib/cities.mjs —— 那里记录了四川哪些市州有数据、哪些没有。
 */

import crypto from 'node:crypto';
import {
  CHENGDU,
  CITY_NODES,
  UNCOVERED_CITIES,
  findByName,
  findByCityId,
  nearestNode,
  withinCity,
} from './cities.mjs';

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

/** 兼容旧导入：默认城市仍是成都。 */
export { CHENGDU, CITY_NODES, UNCOVERED_CITIES };

/** 支持的城市（cityId → 名称），从注册表来，不再是只有成都/都江堰。 */
export const SUPPORTED_CITIES = Object.freeze(
  Object.fromEntries(CITY_NODES.map((node) => [node.cityId, node.name])),
);

export class BusApiError extends Error {
  constructor(message, { endpoint, status, cityId } = {}) {
    super(message);
    this.name = 'BusApiError';
    this.endpoint = endpoint;
    this.status = status;
    this.cityId = cityId;
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

/**
 * 把一个城市名/cityId/坐标解析成注册表里的节点。
 *
 * 解析优先级：cityId > name > 坐标。
 * 坐标解析会先用最近中心点粗判，再交给调用方用真实站点距离复核（见 probeCity）。
 *
 * @returns {{node, reason, candidates}}
 */
export function resolveCity({ cityId, name, lat, lng } = {}) {
  if (cityId != null && String(cityId).trim() !== '') {
    const node = findByCityId(cityId);
    if (!node) {
      throw new BusApiError(`未知城市 cityId=${cityId}。用 \`cd-bus cities\` 查看可用城市。`);
    }
    if (node.covered === false) {
      throw new BusApiError(
        `${node.name}暂无实时公交数据${node.note ? `（${node.note}）` : ''}。` +
          (node.fallback?.length
            ? `可改用：${node.fallback.map((id) => findByCityId(id)?.name ?? id).join('、')}。`
            : ''),
        { cityId: String(cityId) },
      );
    }
    return { node, reason: 'cityId', candidates: [] };
  }

  if (name != null && String(name).trim() !== '') {
    const node = findByName(name);
    if (!node) {
      throw new BusApiError(`没听过这个城市：${name}。用 \`cd-bus cities\` 查看可用城市。`);
    }
    if (node.covered === false) {
      throw new BusApiError(
        `${node.name}暂无实时公交数据${node.note ? `（${node.note}）` : ''}。` +
          (node.fallback?.length
            ? `可改用：${node.fallback.map((id) => findByCityId(id)?.name ?? id).join('、')}。`
            : ''),
        { cityId: String(node.adcode) },
      );
    }
    return { node, reason: 'name', candidates: [] };
  }

  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    const near = nearestNode(lat, lng);
    if (!near) throw new BusApiError('城市注册表为空。');
    const uncovered = nearestUncovered(lat, lng);
    // 无数据城市比有数据节点更近，且确实在它的市中心范围内 → 如实报「没有数据」
    if (uncovered && (!near.node || uncovered.distance < near.distance)) {
      return {
        node: { ...uncovered.node, covered: false },
        reason: 'geo-uncovered',
        candidates: near.node ? [near.node] : [],
        distance: uncovered.distance,
      };
    }
    return {
      node: near.node,
      reason: 'geo',
      candidates: near.alternatives.map((alt) => alt.node),
      distance: near.distance,
    };
  }

  return { node: findByCityId(CHENGDU.cityId), reason: 'default', candidates: [] };
}

function nearestUncovered(lat, lng) {
  const ranked = UNCOVERED_CITIES
    .filter((c) => Array.isArray(c.center))
    .map((c) => ({ node: c, distance: Math.round(haversineSafe(lat, lng, c.center)) }))
    .sort((a, b) => a.distance - b.distance);
  const best = ranked[0];
  if (!best) return null;
  // 只有落在该州市中心 60 公里内才认为「人在那儿」
  return best.distance <= 60000 ? best : null;
}

function haversineSafe(lat, lng, center) {
  const [clat, clng] = center;
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(clat - lat);
  const dLng = toRad(clng - lng);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat)) * Math.cos(toRad(clat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export class BusClient {
  /**
   * @param {object} opts
   * @param {string} opts.cityId    城市节点 id（默认成都 007）
   * @param {string} opts.cityName  城市名（与 cityId 二选一，cityId 优先）
   */
  constructor({ cityId = CHENGDU.cityId, cityName, timeoutMs = 15000, retries = 2 } = {}) {
    const resolved = resolveCity(cityName !== undefined ? { name: cityName } : { cityId });
    this.city = resolved.node;
    this.cityId = resolved.node.cityId;
    this.cityName = resolved.node.name;
    this.timeoutMs = timeoutMs;
    this.retries = retries;
  }

  /** 换一个城市（返回新实例，原实例不变）。 */
  withCity(cityIdOrName) {
    const resolved = resolveCity(
      /^\d+$/.test(String(cityIdOrName)) ? { cityId: String(cityIdOrName) } : { name: cityIdOrName },
    );
    return new BusClient({
      cityId: resolved.node.cityId,
      timeoutMs: this.timeoutMs,
      retries: this.retries,
    });
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
        if (!res.ok) throw new BusApiError(`HTTP ${res.status}`, { endpoint, status: res.status, cityId: this.cityId });

        const envelope = extractEnvelope(await res.text());
        const jsonr = envelope.jsonr ?? {};
        const status = jsonr.status;
        if (status && !['00', '0000', '0'].includes(status)) {
          const msg = jsonr.errmsg || `接口返回状态 ${status}`;
          throw new BusApiError(msg, { endpoint, status, cityId: this.cityId });
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
   * 用坐标判断「人在哪个城市」。
   *
   * 先用车来了官方 citylist 接口（无需签名）拿官方 cityId，再和注册表对账：
   *   - 官方说得出 cityId 且在注册表里 → 直接用它；
   *   - 官方给不出 cityId（车来了把该地归到没有实时数据的州市）→ 返回 covered:false，
   *     并附上最近的有数据节点当 fallback。
   *
   * required=true 时，没有实时数据会直接抛错。
   */
  async resolveCityByGeo({ lat, lng, required = false } = {}) {
    if (lat == null || lng == null) {
      if (required) throw new BusApiError('缺少坐标，无法确认所在城市。');
      return { node: this.city, cityId: this.cityId, name: this.cityName, covered: true, source: 'default' };
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
    const official = payload?.data?.gpsRealtimeCity ?? null;
    const officialId = official?.cityId != null ? String(official.cityId) : null;
    const officialName = official?.cityName ? String(official.cityName) : '';

    // 1) 官方给了 cityId，且注册表里有 → 最可信
    if (officialId) {
      const node = findByCityId(officialId);
      if (node && node.covered !== false) {
        return {
          node, cityId: node.cityId, name: node.name, covered: true,
          officialName, source: 'chelaile', level: node.level,
        };
      }
    }

    // 2) 官方只给了名字（如「德阳」「凉山彝族自治州」）→ 可能是无数据州市
    const bare = officialName.replace(/市$|地区$|自治州$|藏族羌族自治州$|彝族自治州$|藏族自治州$/, '');
    const uncovered = UNCOVERED_CITIES.find(
      (c) => c.name === bare || officialName.includes(c.name),
    );
    if (uncovered) {
      const fallbackNodes = (uncovered.fallback ?? [])
        .map((id) => findByCityId(id))
        .filter(Boolean);
      if (required) {
        throw new BusApiError(
          `当前位置属于「${uncovered.name}」，该地暂无实时公交数据` +
            (fallbackNodes.length ? `。可改用：${fallbackNodes.map((n) => n.name).join('、')}。` : '。'),
          { cityId: null },
        );
      }
      return {
        node: { ...uncovered, covered: false },
        cityId: null,
        name: uncovered.name,
        covered: false,
        officialName,
        source: 'chelaile',
        fallback: fallbackNodes.map((n) => ({ cityId: n.cityId, name: n.name })),
        note: uncovered.note,
      };
    }

    // 3) 官方什么都没给 → 用本地注册表按坐标挑最近的
    const near = nearestNode(lat, lng);
    if (!near) throw new BusApiError('城市定位服务不可用，无法确认当前位置。');
    const node = near.node;
    const out = {
      node, cityId: node.cityId, name: node.name, covered: true,
      officialName, source: 'geo-registry', level: node.level,
    };
    if (required && !withinCity(node, lat, lng, 80000)) {
      throw new BusApiError(
        `当前位置离「${node.name}」市区约 ${Math.round(near.distance / 1000)} 公里，可能不在服务范围内。`,
      );
    }
    return out;
  }

  /**
   * 给定坐标，判断本城市能不能查到真实数据。
   *
   * 车来了对「坐标不在运营范围内」的处理很安静：接口照常 200，只是返回的站点
   * distance 全是 -1。所以这里拿 nearby 的距离字段当探针，比猜中心点半径靠谱。
   */
  async probeCity({ lat, lng } = {}) {
    if (lat == null || lng == null) {
      // 没坐标就用城市中心点试一下
      const center = this.city.center;
      if (!Array.isArray(center)) return { covered: false, reason: 'no-center' };
      [lat, lng] = center;
    }
    const data = await this.#call('stop!homePageInfo.action', {
      type: '1', act: '2',
      lat: String(lat), lng: String(lng),
      geo_lat: String(lat), geo_lng: String(lng),
    });
    const stops = data.nearSts ?? [];
    if (!stops.length) return { covered: false, reason: 'no-stops' };
    const real = stops.filter((st) => Number(st.distance) >= 0);
    if (!real.length) return { covered: false, reason: 'out-of-range', sample: stops.slice(0, 3).map((s) => s.sn) };
    return {
      covered: true,
      stops: real.length,
      nearest: Number(real[0].distance),
      sample: real.slice(0, 3).map((s) => s.sn),
    };
  }

  /** 旧接口名保留：坐标在本城市范围内就返回城市信息，否则抛错。 */
  async assertCity({ lat, lng, required = false } = {}) {
    const info = await this.resolveCityByGeo({ lat, lng, required });
    if (info.covered === false) {
      throw new BusApiError(
        `当前位置属于「${info.name}」，该地暂无实时公交数据` +
          (info.fallback?.length ? `。可改用：${info.fallback.map((f) => f.name).join('、')}。` : '。'),
      );
    }
    return info;
  }

  /** 兼容旧名字（旧代码里 assertChengdu 表示「确认在支持范围内」）。 */
  async assertChengdu(opts = {}) {
    return this.assertCity(opts);
  }

  /** 线路搜索：按线路号/关键字，本城市范围内。 */
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
        return true;   // 区县线路是纯数字 lineId，不能按前缀过滤
      })
      .map((line) => ({
        lineId: line.lineId,
        name: line.name,
        direction: line.direction ?? 0,
        startSn: line.startSn ?? '',
        endSn: line.endSn ?? '',
        firstTime: line.firstTime ?? '',
        lastTime: line.lastTime ?? '',
        cityId: this.cityId,
        city: this.cityName,
        caption: `${line.name}（${line.startSn || '?'} → ${line.endSn || '?'}）`,
      }));
  }

  /** 站点搜索：query!nSearch 的 result.stations（服务端最多给 3 条）。 */
  async searchStations(keyword) {
    const data = await this.#call('query!nSearch.action', {
      key: keyword,
      supportPhyStn: 'true',
    });
    const stations = data?.result?.stations ?? [];
    return stations
      .filter((st) => st.sn && Number(st.subwayV2) !== 1)
      .map((st) => ({
        stationId: st.sId,
        name: st.sn,
        lat: st.lat ?? 0,
        lng: st.lng ?? 0,
        distance: st.distance ?? 0,
        cityId: this.cityId,
        city: this.cityName,
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
    /**
     * 站点解析。
     *
     * 车来了对「临时不停靠」的站会把 order 设成 999、坐标设成 0,0，
     * 但 specialOrder 里保留着**真实站序**。实测 P02 / P10 的
     * 「石羊村」「子云村」就是这样：
     *
     *   {"sn":"石羊村","order":999,"special":1,"specialType":2,
     *    "specialLabel":"该站不停靠","specialOrder":15,
     *    "fakeDesc":"该站点车辆暂不停靠，恢复时间未定","wgsLat":0,"wgsLng":0}
     *
     * 以前只读 order，999 会把这些站排到终点之后（截图里就是它们
     * 跑到最右边）。现在用 specialOrder 落回真实位置，并带上标记，
     * 由界面决定怎么显示（灰一点、加个「不停靠」标签）。
     */
    /* 环线判定：首站和末站是同一个物理站（stationId 相同）。
       环线按 1..N 线性给站序，末站就是首站；这条信息要带给 arrivals
       做「绕环」计算（见下面的兜底逻辑）。 */
    const rawList = data.stations ?? [];
    const loopLen = rawList.length;
    const firstId = rawList[0]?.sId ?? '';
    const lastId = rawList[rawList.length - 1]?.sId ?? '';
    const loop = loopLen >= 3 && firstId !== '' && firstId === lastId;

    const stations = rawList.map((st) => {
      const specialType = Number(st.specialType ?? 0);
      /* specialType=2 是「该站不停靠」 */
      const suspended = specialType === 2 || Number(st.order) >= 999;
      const tag = Array.isArray(st.stationTags) && st.stationTags.length
        ? String(st.stationTags[0].name ?? '')
        : '';

      /* 站序用 specialOrder，不是 order。
         实测 P02（028-702-0）的 22 个站：
           order  = 1..14, 999, 999, 15, 16, 17, 18, 19, 20   ← 跳过特殊站后重编号
           specialOrder = 1..22                                ← 完整连续的真实站序
         两个特殊站（石羊村 order=999、子云村 order=999）会把编号错开，
         后面的白鸽(15)、江安村(16) 就和它们撞号了。
         所以整条线统一用 specialOrder，它始终是连续的。 */
      const hasSp = Number.isFinite(Number(st.specialOrder));
      const realOrder = hasSp ? Number(st.specialOrder) : Number(st.order);

      return {
        stationId: st.sId,
        order: realOrder,
        name: st.sn,
        lat: st.wgsLat,
        lng: st.wgsLng,
        /* 以下三个字段只有特殊站才有值，普通站是 false / 空串 */
        suspended,
        specialLabel: suspended ? String(st.specialLabel || tag || '该站不停靠') : '',
        specialNote: suspended ? String(st.fakeDesc || '') : '',
        /* 环线信息：arrivals 靠它判断要不要绕一圈找车 */
        loop,
        loopLen,
      };
    });
    return {
      lineId: line.lineId ?? lineId,
      name: line.name ?? '',
      startSn: line.startSn ?? '',
      endSn: line.endSn ?? '',
      firstTime: line.firstTime ?? '',
      lastTime: line.lastTime ?? '',
      price: line.price ?? '',
      cityId: this.cityId,
      city: this.cityName,
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

    /* 环线上「已过站」的车不算真的过去了：绕一圈还会回来。
       先把它们的站序记下来，全部车都"已过站"时用绕环距离兜底。 */
    const behind = [];
    const buses = (data.buses ?? [])
      .filter((bus) => {
        if (Number(bus.distanceToWaitStn) >= 0) return true;
        const passedOrder = Number(bus.order ?? 0);
        if (passedOrder > 0) behind.push(passedOrder);
        return false;
      })
      .map((bus) => {
        const travel = (bus.travels ?? [])[0] ?? {};
        /* 不截断成 0：负数表示「这辆车已经驶过本站」，正数是还没到。
           以前 Math.max(0, …) 把两者压成都 0，导致「已驶过」被当成「即将进站」，
           也让收班判定分不清车到底还在不在本站之后。 */
        const stationsAway = Math.round(Number(station.order) - Number(bus.order ?? 0));
        const etaSeconds = Number.isFinite(travel.travelTime) ? travel.travelTime : null;
        return {
          order: bus.order,
          stationsAway,
          distanceMeters: Number(bus.distanceToWaitStn),
          etaSeconds,
          arrivalAt: travel.arrivalTime ?? null, // epoch ms
          arrived: stationsAway === 0,   /* 恰好到站；<0 是已驶过 */
        };
      })
      .sort((a, b) => a.stationsAway - b.stationsAway);

    /* 环线兜底：这一站前面一辆车都没有（环线上早段的站是常态），
       按「绕一圈还要几站」找最近的一辆。
       例：K1 线 30 站，车在第 28 站，你在第 2 站 → (2-28+30)%30 = 4 站。
       接口不给这种车的 ETA，所以 etaSeconds 为 null，wrapped 标记供界面区分。 */
    if (!buses.length && station.loop && behind.length) {
      const n = Number(station.loopLen);
      const target = Number(station.order);
      if (n > 1 && target > 0) {
        let bestOrder = 0;
        let bestAway = Infinity;
        for (const busOrder of behind) {
          let away = ((target - busOrder) % n + n) % n;
          if (away === 0) away = n;         // 同一站 = 还要一整圈
          if (away < bestAway) { bestAway = away; bestOrder = busOrder; }
        }
        if (bestOrder > 0) {
          buses.push({
            order: bestOrder,
            stationsAway: bestAway,
            distanceMeters: -1,
            etaSeconds: null,
            arrivalAt: null,
            arrived: false,
            wrapped: true,
          });
        }
      }
    }

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
      /* 保留负值：away < 0 表示这辆车已经开过本站（往终点去了）。
         收班判定要用它区分「最后一辆车还在本站之前」和「已经驶过本站」。 */
      const stationsAway =
        target.order != null && state.order != null ? Math.round(target.order - state.order) : null;
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
      lat: st.lat ?? 0,
      lng: st.lng ?? 0,
      lineNameList: st.lineNameList ?? [],
      arrivals: arrivals.filter((a) => a.stationId === st.sId),
    }));

    return {
      cityId: this.cityId,
      city: this.cityName,
      stops,
      allArrivals: arrivals,
    };
  }
}

/**
 * 多城市客户端：一次持有多个城市，按需切换。
 * 用于「全省巡检」这类要连着查很多城市的场景。
 */
export class MultiCityClient {
  constructor({ cityIds = CITY_NODES.filter((n) => n.level === 'city').map((n) => n.cityId), timeoutMs = 12000, retries = 1 } = {}) {
    this.timeoutMs = timeoutMs;
    this.retries = retries;
    this.clients = new Map();
    for (const id of cityIds) {
      this.clients.set(String(id), new BusClient({ cityId: String(id), timeoutMs, retries }));
    }
  }

  get(cityId) {
    const key = String(cityId);
    if (!this.clients.has(key)) {
      this.clients.set(key, new BusClient({ cityId: key, timeoutMs: this.timeoutMs, retries: this.retries }));
    }
    return this.clients.get(key);
  }

  /** 逐个城市探活：返回每个城市「能不能查到真实数据」。 */
  async healthCheck({ concurrency = 6 } = {}) {
    const entries = [...this.clients.entries()];
    const results = [];
    let cursor = 0;
    const worker = async () => {
      while (cursor < entries.length) {
        const [cityId, client] = entries[cursor++];
        const started = Date.now();
        try {
          const probe = await client.probeCity({ lat: client.city.center?.[0], lng: client.city.center?.[1] });
          results.push({
            cityId,
            city: client.cityName,
            group: client.city.group,
            covered: probe.covered,
            reason: probe.reason ?? '',
            nearest: probe.nearest ?? null,
            sample: probe.sample ?? [],
            ms: Date.now() - started,
          });
        } catch (err) {
          results.push({
            cityId,
            city: client.cityName,
            group: client.city.group,
            covered: false,
            reason: `error: ${err.message}`,
            ms: Date.now() - started,
          });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, entries.length) }, worker));
    return results.sort((a, b) => a.cityId.localeCompare(b.cityId));
  }
}