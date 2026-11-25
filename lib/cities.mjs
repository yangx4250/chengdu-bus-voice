/**
 * 四川省公交城市注册表。
 *
 * 全部数据源都是车来了（Chelaile）小程序接口，每个「城市」在它那边有一个 cityId。
 * 实测（2026-11-25）结论，每一条都用真实线路站点坐标反算核对过：
 *
 *   覆盖：15 个地级市 + 11 个区县独立节点；另有 6 个市州完全没有数据。
 *   陷阱：车来了有几个「同名异地」的节点，名字看着像四川，实际在别的省 ——
 *         257「东兴」在广西防城港（21.55,107.98），325「沙湾」在新疆（44.3,85.6）。
 *         所以注册表里每个节点都带 center，且必须用真实坐标核对过才能登记。
 *   陷阱：291「甘孜」是甘孜县（31.6,99.9），不是州府康定；康定没有任何 cityId。
 *   陷阱：allCity 列表里存在行政区划码形态的 id（如德阳 510600），查线路恒返回空，
 *         不能当 cityId 用 —— 这里把 adcode 单独存成字段，只用于展示。
 *
 * 判定「有没有覆盖」的可靠信号：调 nearby 时，若返回站点的 distance 全是 -1，
 * 说明坐标不在该 cityId 的运营范围内（接口不报错，只是给了个距离未知的兜底站）。
 */

/** 四川省 21 个市州的州府/市中心坐标（WGS84）。 */
const PREFECTURES = [
  { adcode: '510100', name: '成都', center: [30.657, 104.0657] },
  { adcode: '510300', name: '自贡', center: [29.3392, 104.7784] },
  { adcode: '510400', name: '攀枝花', center: [26.5823, 101.7187] },
  { adcode: '510500', name: '泸州', center: [28.8718, 105.4433] },
  { adcode: '510600', name: '德阳', center: [31.1289, 104.3979] },
  { adcode: '510700', name: '绵阳', center: [31.4675, 104.6796] },
  { adcode: '510800', name: '广元', center: [32.4358, 105.8436] },
  { adcode: '510900', name: '遂宁', center: [30.5133, 105.5929] },
  { adcode: '511000', name: '内江', center: [29.5802, 105.0584] },
  { adcode: '511100', name: '乐山', center: [29.5521, 103.7656] },
  { adcode: '511300', name: '南充', center: [30.8373, 106.1107] },
  { adcode: '511400', name: '眉山', center: [30.0754, 103.8485] },
  { adcode: '511500', name: '宜宾', center: [28.7513, 104.6432] },
  { adcode: '511600', name: '广安', center: [30.4564, 106.6334] },
  { adcode: '511700', name: '达州', center: [31.2093, 107.468] },
  { adcode: '511800', name: '雅安', center: [29.9877, 103.001] },
  { adcode: '511900', name: '巴中', center: [31.8671, 106.7477] },
  { adcode: '512000', name: '资阳', center: [30.1289, 104.6279] },
  { adcode: '513200', name: '阿坝', center: [31.8994, 102.2212], seat: '马尔康' },
  { adcode: '513300', name: '甘孜', center: [30.0493, 101.9638], seat: '康定' },
  { adcode: '513400', name: '凉山', center: [27.8945, 102.2644], seat: '西昌' },
];

/**
 * 城市节点表（均已用真实站点坐标核对）。
 *
 * level = 'city'    地级市/州本级节点，覆盖主城区
 * level = 'county'  区县独立节点，父级用 group 字段指向地级市名
 * center            实测数据重心，不是行政中心 —— 用于「最近城市」判定
 * radius            判定「坐标是否属于本节点」的半径（米），按实测覆盖范围给
 */
const NODES = [
  // —— 15 个地级市 ——
  { cityId: '007', name: '成都', group: '成都', level: 'city', radius: 45000,
    aliases: ['蓉城', '成都市区'], center: [30.66, 104.058] },
  { cityId: '371', name: '自贡', group: '自贡', level: 'city', radius: 45000, center: [29.361, 104.77] },
  { cityId: '192', name: '攀枝花', group: '攀枝花', level: 'city', radius: 45000, center: [26.545, 101.726] },
  { cityId: '344', name: '泸州', group: '泸州', level: 'city', radius: 45000, center: [28.861, 105.408] },
  { cityId: '133', name: '绵阳', group: '绵阳', level: 'city', radius: 45000, center: [31.475, 104.74] },
  { cityId: '609', name: '遂宁', group: '遂宁', level: 'city', radius: 40000, center: [30.535, 105.587] },
  // 内江节点实测同时覆盖内江市区与隆昌市（两个城区都能查到真实距离）
  { cityId: '130', name: '内江', group: '内江', level: 'city', radius: 60000, center: [29.45, 105.17],
    covers: ['内江市区', '隆昌'] },
  { cityId: '191', name: '乐山', group: '乐山', level: 'city', radius: 40000, center: [29.583, 103.744] },
  { cityId: '526', name: '南充', group: '南充', level: 'city', radius: 45000, center: [30.828, 106.106] },
  // 眉山节点实测只覆盖仁寿县城（东坡区查不到），故降级为仁寿的区县节点处理，见下方
  { cityId: '193', name: '宜宾', group: '宜宾', level: 'city', radius: 45000, center: [28.728, 104.571] },
  { cityId: '320', name: '达州', group: '达州', level: 'city', radius: 45000, center: [31.225, 107.519] },
  { cityId: '194', name: '雅安', group: '雅安', level: 'city', radius: 40000, center: [30.004, 103.022] },
  { cityId: '282', name: '巴中', group: '巴中', level: 'city', radius: 40000, center: [31.862, 106.752] },
  { cityId: '263', name: '资阳', group: '资阳', level: 'city', radius: 40000, center: [30.141, 104.629] },

  // —— 区县独立节点：成都 ——
  { cityId: '271', name: '都江堰', group: '成都', level: 'county', radius: 25000, center: [30.997, 103.616] },
  { cityId: '516', name: '崇州', group: '成都', level: 'county', radius: 25000, center: [30.612, 103.672] },
  { cityId: '11054', name: '彭州', group: '成都', level: 'county', radius: 25000, center: [30.966, 103.952] },
  { cityId: '11057', name: '简阳', group: '成都', level: 'county', radius: 25000, center: [30.387, 104.542] },
  // 温江节点覆盖成都西郊一大片（数据重心偏西北，到温江城区 30 公里内都算真实）
  { cityId: '11043', name: '温江', group: '成都', level: 'county', radius: 45000, center: [30.926, 103.673],
    covers: ['温江', '成都西郊'] },
  { cityId: '11051', name: '双流', group: '成都', level: 'county', radius: 25000, center: [30.555, 103.919] },

  // —— 区县独立节点：其余市州 ——
  { cityId: '135', name: '广汉', group: '德阳', level: 'county', radius: 25000, center: [30.987, 104.274] },
  { cityId: '136', name: '江油', group: '绵阳', level: 'county', radius: 25000, center: [31.778, 104.739] },
  { cityId: '523', name: '隆昌', group: '内江', level: 'county', radius: 20000, center: [29.341, 105.278] },
  { cityId: '272', name: '荣县', group: '自贡', level: 'county', radius: 20000, center: [29.453, 104.410] },
  { cityId: '11004', name: '仁寿', group: '眉山', level: 'county', radius: 30000, center: [30.007, 104.150] },
  { cityId: '547', name: '荥经', group: '雅安', level: 'county', radius: 20000, center: [29.797, 102.840] },
  { cityId: '399', name: '岳池', group: '广安', level: 'county', radius: 20000, center: [30.527, 106.450] },
  { cityId: '369', name: '道孚', group: '甘孜', level: 'county', radius: 20000, center: [30.975, 101.131] },
  // 291 是甘孜县，不是康定 —— 单独登记，别当成州府
  { cityId: '291', name: '甘孜县', group: '甘孜', level: 'county', radius: 20000, center: [31.622, 99.993],
    note: '甘孜县城，非州府康定' },
];

/**
 * 别名：同一个 cityId 的另一种叫法（车来了返回的名字 / 常见俗称）。
 * 眉山节点的 cityId 557 与 11004 数据完全相同（都是仁寿），所以登记成仁寿的别名。
 */
const ALIASES = [
  { cityId: '11004', names: ['眉山', '眉山市'] },
];

/**
 * 没有实时公交覆盖的市州。仍然登记，因为：
 *   - 定位到这些地方时要能说出「你在德阳，本地暂无实时数据」，而不是报「不支持」；
 *   - 部分城市可以退到下辖县市节点（fallback 字段）。
 */
const UNCOVERED = [
  {
    name: '德阳', adcode: '510600', center: [31.1289, 104.3979],
    fallback: ['135'], note: '德阳市区（旌阳）暂无实时数据；广汉可用，什邡/绵竹/中江/罗江均无节点',
  },
  {
    name: '广元', adcode: '510800', center: [32.4358, 105.8436],
    fallback: [], note: '广元全市（含利州/昭化/朝天/旺苍/青川/剑阁/苍溪）均无实时数据',
  },
  {
    name: '广安', adcode: '511600', center: [30.4564, 106.6334],
    fallback: ['399'], note: '广安市区暂无实时数据；岳池可用，前锋/武胜/邻水/华蓥均无节点',
  },
  {
    name: '阿坝', adcode: '513200', center: [31.8994, 102.2212], seat: '马尔康',
    fallback: [], note: '阿坝州全域（马尔康/汶川/理县/茂县/九寨沟等）均无实时数据',
  },
  {
    name: '甘孜', adcode: '513300', center: [30.0493, 101.9638], seat: '康定',
    fallback: ['369', '291'], note: '康定及大部分县无数据；道孚、甘孜县可用',
  },
  {
    name: '凉山', adcode: '513400', center: [27.8945, 102.2644], seat: '西昌',
    fallback: [], note: '凉山州全域（西昌/会理/冕宁等）均无实时数据',
  },
];

const prefectureOf = (group) => PREFECTURES.find((p) => p.name === group) ?? null;

/** 完整节点表：含坐标、覆盖半径、父级市州、行政区划码。 */
export const CITY_NODES = Object.freeze(
  NODES.map((node) => {
    const pref = prefectureOf(node.group);
    const aliases = [
      ...(node.aliases ?? []),
      ...ALIASES.filter((a) => a.cityId === node.cityId).flatMap((a) => a.names),
    ];
    return Object.freeze({
      cityId: node.cityId,
      name: node.name,
      group: node.group,
      level: node.level,
      adcode: pref ? pref.adcode : '',
      center: node.center,
      radius: node.radius ?? 30000,
      aliases,
      covers: node.covers ?? [],
      note: node.note ?? '',
      covered: true,
    });
  }),
);

/** 无数据覆盖的市州（也参与定位识别）。 */
export const UNCOVERED_CITIES = Object.freeze(
  UNCOVERED.map((city) =>
    Object.freeze({
      cityId: null,
      name: city.name,
      group: city.name,
      level: 'city',
      adcode: city.adcode,
      center: city.center,
      radius: 60000,
      seat: city.seat ?? '',
      aliases: city.seat ? [city.seat] : [],
      covers: [],
      covered: false,
      fallback: city.fallback,
      note: city.note,
    }),
  ),
);

/** 全省 21 个市州的汇总视图（含覆盖状态）。 */
export const SICHUAN_PREFECTURES = Object.freeze(
  PREFECTURES.map((pref) => {
    const primary = CITY_NODES.find((n) => n.level === 'city' && n.group === pref.name) ?? null;
    const counties = CITY_NODES.filter((n) => n.level === 'county' && n.group === pref.name);
    const uncovered = UNCOVERED_CITIES.find((c) => c.name === pref.name) ?? null;
    return Object.freeze({
      name: pref.name,
      adcode: pref.adcode,
      seat: pref.seat ?? '',
      center: pref.center,
      primary,                        // 市本级节点（可能为 null）
      counties,                       // 有数据的区县节点
      covered: Boolean(primary),      // 市本级有没有实时数据
      partial: Boolean(!primary && counties.length),  // 只有区县有数据
      note: uncovered ? uncovered.note : '',
    });
  }),
);

/** 成都（保留旧名字，兼容已有调用方）。 */
export const CHENGDU = Object.freeze({ cityId: '007', name: '成都', areaCode: '028' });

const norm = (value) => String(value == null ? '' : value).trim().replace(/市$|县$|地区$|自治州$/, '');

/** 按 cityId 查节点。 */
export function findByCityId(cityId) {
  const key = String(cityId ?? '').trim();
  return CITY_NODES.find((n) => n.cityId === key)
    ?? UNCOVERED_CITIES.find((n) => n.adcode === key)
    ?? null;
}

/** 按名字/别名查节点，支持「德阳广汉」「成都都江堰」这种带父级前缀的写法。 */
export function findByName(name) {
  const key = norm(name);
  if (!key) return null;
  const all = [...CITY_NODES, ...UNCOVERED_CITIES];
  const exact = all.find((n) => norm(n.name) === key);
  if (exact) return exact;
  const byAlias = all.find((n) => n.aliases.some((a) => norm(a) === key));
  if (byAlias) return byAlias;
  // 「成都都江堰」→ 先按父级拆，再按尾串匹配
  const suffix = all.filter((n) => key.endsWith(norm(n.name)));
  if (suffix.length) {
    const preferred = suffix.find((n) => n.group === key.slice(0, key.length - norm(n.name).length));
    return preferred ?? suffix.sort((a, b) => b.name.length - a.name.length)[0];
  }
  return all.find((n) => norm(n.name).includes(key) || key.includes(norm(n.name))) ?? null;
}

/** 球面距离（米）。 */
export function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * 找离坐标最近的节点（默认只在有数据的节点里挑）。
 *
 * @returns {{node, distance, inside:boolean, alternatives}}
 */
export function nearestNode(lat, lng, { includeUncovered = false, maxDistance = Infinity } = {}) {
  const pool = includeUncovered ? [...CITY_NODES, ...UNCOVERED_CITIES] : CITY_NODES;
  const ranked = pool
    .filter((n) => Array.isArray(n.center))
    .map((n) => ({ node: n, distance: haversine(lat, lng, n.center[0], n.center[1]) }))
    .filter((entry) => entry.distance <= maxDistance)
    .sort((a, b) => a.distance - b.distance);
  if (!ranked.length) return null;
  const best = ranked[0];
  return {
    node: best.node,
    distance: best.distance,
    inside: best.distance <= (best.node.radius ?? 40000),
    alternatives: ranked.slice(1, 4),
  };
}

/**
 * 坐标是否落在某节点的运营范围内（按节点自己的实测半径）。
 */
export function withinCity(node, lat, lng, radiusOverride) {
  if (!Array.isArray(node?.center)) return false;
  const radius = radiusOverride ?? node.radius ?? 40000;
  return haversine(lat, lng, node.center[0], node.center[1]) <= radius;
}

/** 供 /cities 命令和前端选择器用的精简列表。 */
export function listCities({ includeCounties = true } = {}) {
  return SICHUAN_PREFECTURES.map((pref) => ({
    name: pref.name,
    adcode: pref.adcode,
    seat: pref.seat,
    covered: pref.covered,
    partial: pref.partial,
    cityId: pref.primary ? pref.primary.cityId : null,
    note: pref.note,
    counties: includeCounties
      ? pref.counties.map((c) => ({ name: c.name, cityId: c.cityId, note: c.note }))
      : [],
  }));
}

/** 统计：多少个市州有市本级数据 / 只有区县 / 完全没有。 */
export function coverageSummary() {
  const full = SICHUAN_PREFECTURES.filter((p) => p.covered);
  const partial = SICHUAN_PREFECTURES.filter((p) => !p.covered && p.counties.length);
  const none = SICHUAN_PREFECTURES.filter((p) => !p.covered && !p.counties.length);
  return {
    total: SICHUAN_PREFECTURES.length,
    full: full.map((p) => p.name),
    partial: partial.map((p) => p.name),
    none: none.map((p) => p.name),
    nodes: CITY_NODES.length,
  };
}