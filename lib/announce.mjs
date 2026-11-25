/**
 * 把实时到站数据翻译成「像人说的话」，供屏幕输出和语音播报共用。
 * 播报风格参考地铁/站台广播：线路 → 方向 → 还有几站 → 大约多久。
 */

const toMinutes = (seconds) => Math.max(0, Math.round(seconds / 60));

/** 预估时间精确到 30 秒：90 → 「1 分 30 秒」，600 → 「10 分钟」 */
export function formatEta(seconds) {
  if (seconds == null || !(seconds > 0)) return '暂无预测';
  const half = Math.round(seconds / 30);
  if (half <= 1) return '30 秒内';
  const m = Math.floor(half / 2);
  const r = half % 2;
  return r ? `${m} 分 30 秒` : `${m} 分钟`;
}

export function formatClock(epochMs) {
  if (!epochMs) return '';
  return new Date(epochMs).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Shanghai',
  });
}

/**
 * 一辆车怎么念：还有几站优先，其次时间。
 * 距离车站还远（≥4 站）时只报站数——这时候的 ETA 常被算法压成 1 分钟，念出来反而误导。
 */
export function describeBus(bus) {
  if (bus.arrived) return '即将进站';
  const stations = bus.stationsAway ?? null;
  const eta = bus.etaSeconds ?? null;
  if (stations != null && stations >= 4) return `还有 ${stations} 站`;
  const parts = [];
  if (stations != null && stations > 0) parts.push(`还有 ${stations} 站`);
  if (eta != null) parts.push(formatEta(eta));
  if (parts.length === 0) parts.push('正在接近本站');
  return parts.join('，');
}

/**
 * 线路名的可读写法。
 *
 * 四川各地的线路命名并不统一：成都 `16`、自贡 `1路`、泸州 `酒城快线D1`、
 * 绵阳 `1001M（社区巴士）`、都江堰 `都江堰1`。以前一律拼「路」，
 * 结果念出「1001M（社区巴士）路」「酒城快线D1路」这种怪话。
 * 现在只在**纯数字**后面补「路」，其它原样念。
 */
export function lineLabel(lineName) {
  const name = String(lineName ?? '').trim();
  if (!name) return '公交';
  return /^\d+$/.test(name) ? `${name}路` : name;
}

/** 站台一条线路的播报句。 */
export function announcementLine({ lineName, toward, bus }) {
  const direction = toward ? `开往${toward}` : '';
  return `${lineLabel(lineName)}，${direction}，${describeBus(bus)}。`;
}

/** 该不该主动「喊」：车快到了，或者已经进站。 */
export function isUrgent(bus) {
  if (!bus) return false;
  if (bus.arrived) return true;
  return (bus.stationsAway != null && bus.stationsAway <= 2) || (bus.etaSeconds != null && bus.etaSeconds <= 150);
}

/**
 * 指定线路 + 站点的播报文案。
 * @param {{line:{name,toward}, station:{name}, buses:[]}} data
 */
export function buildStationAnnouncement({ lineName, toward, stationName, buses, maxBuses = 3 }) {
  const head = `${lineLabel(lineName)}，${stationName}站`;
  if (!buses.length) return `${head}，当前没有即将到站的车辆。`;

  const actual = buses.slice(0, maxBuses);
  const spoken = actual.map((bus, index) => {
    if (index === 0) return `最近一辆${describeBus(bus)}`;
    return `下一辆${describeBus(bus)}`;
  });
  const first = actual[0];
  const lead = first.arrived || (first.stationsAway != null && first.stationsAway <= 1)
    ? `请注意，${lineLabel(lineName)}即将进站。`
    : '';
  return `${lead}${head}，${spoken.join('；')}。${toward ? `开往${toward}。` : ''}`;
}

/** 附近站点播报：按站点聚合，每站念前两条最靠前的线路。 */
export function buildNearbyAnnouncement(stops, { maxStops = 3, maxLinesPerStop = 2 } = {}) {
  if (!stops.length) return '附近没有查到公交站点。';
  const chunks = stops.slice(0, maxStops).map((stop) => {
    const arrivals = (stop.arrivals ?? [])
      .filter((arrival) => arrival.stationsAway != null || arrival.etaSeconds != null)
      .sort((a, b) => (a.stationsAway ?? 99) - (b.stationsAway ?? 99) || (a.etaSeconds ?? 1e9) - (b.etaSeconds ?? 1e9))
      .slice(0, maxLinesPerStop);

    if (!arrivals.length) return `${stop.name}站，暂无实时车辆。`;
    const detail = arrivals
      .map((arrival) => {
        const bus = { stationsAway: arrival.stationsAway, etaSeconds: arrival.etaSeconds, arrived: arrival.arrived };
        return `${lineLabel(arrival.lineName)}${describeBus(bus)}`;
      })
      .join('，');
    return `${stop.name}站，${detail}。`;
  });
  return chunks.join('');
}