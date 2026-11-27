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

const HOST = 'https://www.xcycgj.cn:7777';
const CITY_CODE = 'xc';
const UA =
  'Mozilla/5.0 (Linux; Android 13; 2211133C) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/120.0.0.0 Mobile Safari/537.36';

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
