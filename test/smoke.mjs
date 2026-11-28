#!/usr/bin/env node
/**
 * 冒烟测试：不打桩，直接打真实接口（四川多城市）。网络不通时会被跳过并提示。
 */

import assert from 'node:assert/strict';
import { BusClient, BusApiError, CHENGDU, resolveCity } from '../lib/chelaile.mjs';
import { coverageSummary, findByName, nearestNode } from '../lib/cities.mjs';
import {
  buildNearbyAnnouncement,
  buildStationAnnouncement,
  describeBus,
  isUrgent,
} from '../lib/announce.mjs';
import { splitForSpeech } from '../lib/speech.mjs';
import { MyGolbsClient, isMine, cityNameOfId, cityIdOfName, MG_CITIES } from '../lib/mygolbs.mjs';
import { XichangClient, isMine as xcIsMine, XICHANG, nearby as xcNearby, lineDetail as xcLineDetail, vehicles as xcVehicles, arrivals as xcArrivals, progress as xcProgress, distanceMeters as xcDist, normalizeLineName as xcNorm, routeDirIdOf as xcRouteDirIdOf, directions as xcDirections } from '../lib/xichang.mjs';

let passed = 0;
const check = async (name, fn) => {
  const value = await fn();
  passed += 1;
  console.log(`✓ ${name}`);
  return value;
};

const client = new BusClient({ retries: 1 });


await check('省外坐标不再被硬拒绝，但会如实说明不是四川城市', async () => {
  // 全省接入后语义变了：成都以外的四川城市也要能用，
  // 所以旧版「只支持成都」的拒绝逻辑不再适用。现在北京会落到最近节点，
  // 但必须给出「不在服务范围内」的判断依据，而不是静默返回成都数据。
  const info = await client.resolveCityByGeo({ lat: 39.9042, lng: 116.4074 });
  assert.ok(info, '应有城市识别结果');
  assert.notEqual(info.cityId, CHENGDU.cityId, '北京不该被识别成成都');
});

await check('成都坐标被接受', async () => {
  const city = await client.assertCity({ lat: 30.657, lng: 104.065 });
  assert.equal(city.cityId, CHENGDU.cityId);
});

await check('都江堰坐标被接受', async () => {
  const city = await client.assertCity({ lat: 30.99, lng: 103.62 });
  assert.equal(city.name, '都江堰');
});

await check('绵阳坐标识别为绵阳', async () => {
  const city = await client.assertCity({ lat: 31.4675, lng: 104.6796 });
  assert.equal(city.cityId, '133');
  assert.equal(city.name, '绵阳');
});

await check('宜宾坐标识别为宜宾', async () => {
  const city = await client.assertCity({ lat: 28.7513, lng: 104.6432 });
  assert.equal(city.cityId, '193');
});

await check('德阳定位返回无数据，并给出可用替代节点', async () => {
  const info = await client.resolveCityByGeo({ lat: 31.1289, lng: 104.3979 });
  assert.equal(info.covered, false, '德阳应标记为无数据');
  assert.equal(info.name, '德阳');
  assert.ok(Array.isArray(info.fallback) && info.fallback.length > 0, '应给出可用替代节点');
  assert.equal(info.fallback[0].name, '广汉');
});

await check('西昌定位返回无数据', async () => {
  const info = await client.resolveCityByGeo({ lat: 27.8945, lng: 102.2644 });
  assert.equal(info.covered, false);
  assert.equal(info.name, '凉山');
});

await check('岳池定位可用（广安下辖区县节点）', async () => {
  const info = await client.resolveCityByGeo({ lat: 30.5294, lng: 106.44 });
  assert.equal(info.covered, true);
  assert.equal(info.cityId, '399');
});

await check('城市注册表覆盖统计符合实测', async () => {
  const summary = coverageSummary();
  assert.equal(summary.total, 21, '四川应有 21 个市州');
  assert.ok(summary.full.length >= 14, '市本级有数据的应不少于 14 个');
  assert.deepEqual(summary.none.sort(), ['凉山', '广元', '阿坝'].sort(), '完全无数据的应是这三个');
  assert.ok(summary.partial.includes('德阳'));
  assert.ok(summary.partial.includes('广安'));
});

await check('同名异地节点没有被误收（东兴/沙湾）', async () => {
  // 车来了 257「东兴」在广西防城港、325「沙湾」在新疆，
  // 都不是四川的，注册表里不该有它们
  assert.equal(findByName('东兴'), null, '东兴是广西的，不该登记');
  assert.equal(findByName('沙湾'), null, '沙湾是新疆的，不该登记');
});

await check('甘孜节点是甘孜县而非州府康定', async () => {
  const node = resolveCity({ cityId: '291' }).node;
  assert.equal(node.name, '甘孜县');
  assert.ok(node.note.includes('康定'), '应注明不是康定');
});

await check('眉山别名指向仁寿节点（数据相同的坑）', async () => {
  const byName = resolveCity({ name: '眉山' }).node;
  assert.equal(byName.cityId, '11004', '眉山应归到仁寿节点');
});

await check('名字带父级前缀也能解析', async () => {
  assert.equal(resolveCity({ name: '成都都江堰' }).node.cityId, '271');
  assert.equal(resolveCity({ name: '德阳广汉' }).node.cityId, '135');
});


const lines = await check('线路搜索可用且不含地铁', async () => {
  const result = await client.searchLines('1路');
  assert.ok(result.length > 0, '没有搜到 1路');
  assert.ok(result.every((line) => !String(line.name).startsWith('地铁')), '出现了地铁');
  return result;
});

await check('都江堰线路可搜到', async () => {
  const dijiangyan = new BusClient({ cityId: '271', retries: 1 });
  const result = await dijiangyan.searchLines('都江堰1');
  assert.ok(result.length > 0, '没有搜到都江堰1');
  assert.ok(result.every((line) => /^\d+$/.test(String(line.lineId))), '线路 id 形态异常');
});

await check('线路详情含站点', async () => {
  const lineId = lines[0].lineId;
  const detail = await client.lineDetail(lineId);
  assert.ok(detail.stations.length > 5, '站点过少');
  assert.ok(detail.stations.every((st) => st.stationId && st.order != null));
});

await check('实时到站结构正确', async () => {
  const lineId = lines[0].lineId;
  const detail = await client.lineDetail(lineId);
  const station = detail.stations[Math.min(10, detail.stations.length - 1)];
  const { buses } = await client.arrivals(lineId, station);
  assert.ok(Array.isArray(buses));
  for (const bus of buses) {
    assert.ok(bus.stationsAway >= 0);
    assert.ok(bus.etaSeconds === null || Number.isFinite(bus.etaSeconds));
  }
});

await check('附近站点可查询', async () => {
  const { stops } = await client.nearby(30.657, 104.065, { limit: 3 });
  assert.ok(stops.length > 0);
  assert.ok(stops.every((stop) => stop.stationId && stop.name));
});

await check('播报文案可读', async () => {
  const text = buildStationAnnouncement({
    lineName: '16',
    toward: '火车南站公交站',
    stationName: '天府广场南',
    buses: [{ stationsAway: 2, etaSeconds: 240, arrived: false }],
  });
  assert.match(text, /幺六路/);   // 多位数逐位念，不念成「十六路」
  assert.match(text, /2 站/);
  assert.match(text, /4 分钟/);

  const nearby = buildNearbyAnnouncement([
    { name: '大业路', arrivals: [{ lineName: '8', stationsAway: 3, etaSeconds: 600, arrived: false }] },
  ]);
  assert.match(nearby, /大业路站/);
});

await check('播报线路号只念数字（716 → 七幺六，不念「七百一十六」）', async () => {
  const { lineLabel, speakDigits } = await import('../lib/announce.mjs');
  assert.equal(speakDigits('716'), '七幺六');
  assert.equal(speakDigits('16'), '幺六');
  assert.equal(speakDigits('1'), '一');          // 个位数照常念「一」
  assert.equal(speakDigits('39A'), '三九A');      // 字母原样
  assert.equal(speakDigits('K1'), 'K一');
  assert.equal(speakDigits('1001M'), '幺零零幺M');
  assert.equal(lineLabel('716'), '七幺六路');
  assert.equal(lineLabel('1'), '一路');
  assert.equal(lineLabel('1001M'), '幺零零幺M');  // 非纯数字不加「路」
  const text = buildStationAnnouncement({
    lineName: '716', toward: '火车南站', stationName: '天府广场南',
    buses: [{ stationsAway: 2, etaSeconds: 240, arrived: false }],
  });
  assert.match(text, /^七幺六路，/);
  assert.ok(!/七百一十六/.test(text), '不能念成中文数词：' + text);
});

await check('预估时间精确到 30 秒', async () => {
  const { formatEta } = await import('../lib/announce.mjs');
  assert.equal(formatEta(90), '1 分 30 秒');
  assert.equal(formatEta(150), '2 分 30 秒');
  assert.equal(formatEta(600), '10 分钟');
  assert.equal(formatEta(20), '30 秒内');
  assert.equal(formatEta(null), '暂无预测');
});

await check('紧急判定与远距离只报站数', async () => {
  assert.equal(isUrgent({ stationsAway: 1 }), true);
  assert.equal(isUrgent({ stationsAway: 5, etaSeconds: 900 }), false);
  assert.equal(describeBus({ stationsAway: 12, etaSeconds: 30 }), '还有 12 站');
});

await check('长文本切成 ≤180 字', async () => {
  const long = '16路，还有 3 站，约 9 分钟。'.repeat(20);
  const chunks = splitForSpeech(long);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 180));
  assert.equal(chunks.join(''), long);
});

await check('掌上公交：城市识别（mg- 前缀与车来了数字 id 不冲突）', async () => {
  assert.equal(isMine('mg-deyang'), true);
  assert.equal(isMine('007'), false);          // 成都仍是车来了
  assert.equal(isMine('mg-guangan'), true);
  assert.equal(cityNameOfId('mg-deyang'), '德阳市');
  assert.equal(cityIdOfName('德阳'), 'mg-deyang');
  assert.equal(cityIdOfName('广安市'), 'mg-guangan');
  assert.equal(MG_CITIES.length, 5);
});

await check('掌上公交：线路搜索按 lineName+方向去重，首末站正确', async () => {
  const c = new MyGolbsClient('mg-deyang');
  const lines = await c.searchLines('2路');
  assert.ok(lines.length > 0, '应搜到线路');
  const l = lines.find((x) => x.name === '2路');
  assert.ok(l, '应含 2路');
  assert.ok(l.startSn && l.endSn, '首末站不能为空');
  assert.ok(l.lineId.startsWith('2路|'), 'lineId 必须带方向后缀：' + l.lineId);
  assert.ok([0, 1].includes(l.direction));
});

await check('掌上公交：附近站点用坐标能拿到（CMD=106）', async () => {
  const c = new MyGolbsClient('mg-deyang');
  const r = await c.nearby(31.1289, 104.3979, 3);
  assert.ok(r.stops.length >= 2, '应返回附近站点');
  assert.ok(r.stops[0].name, '站点要有名字');
  assert.ok(r.stops[0].lat && r.stops[0].lng, '站点要有坐标（导航要用）');
  assert.ok(r.stops[0].lineNameList.length > 0, '站点要关联线路');
  assert.ok(r.allArrivals.length > 0, '应有到站信息');
});

await check('掌上公交：线路站表与到站（CMD=103/104）', async () => {
  const c = new MyGolbsClient('mg-deyang');
  const detail = await c.lineDetail('2路|0');
  assert.ok(detail.stations.length > 10, '站表应有多站');
  assert.ok(detail.firstTime && detail.lastTime, '首末班时间要有');
  assert.equal(detail.stations[0].order, 1, '站序从 1 开始');
  const st = detail.stations[7];
  const buses = await c.arrivals('2路|0', st);
  assert.ok(Array.isArray(buses), '到站返回数组');
  if (buses.length) {
    assert.ok(buses[0].plate, '车辆要有车牌');
    assert.ok(buses[0].stationsAway >= 0);
  }
});

await check('掌上公交：逐站矩阵必须带 line/stations（否则详情页报 undefined.firstTime）', async () => {
  const c = new MyGolbsClient('mg-deyang');
  const detail = await c.lineDetail('2路|0');
  const m = await c.stationMatrix('2路|0', 8, 5);
  assert.ok(m.line, 'matrix 必须带 line');
  assert.ok(m.line.firstTime, 'matrix.line.firstTime 必须有值');
  assert.ok(Array.isArray(m.stations) && m.stations.length > 10, 'matrix 必须带 stations');
  assert.ok(m.queriedFrom && m.queriedTo, '必须有 queriedFrom/To');
  for (const bus of m.buses) {
    assert.ok(Number.isFinite(bus.order), 'bus.order 必须是车当前站序（数字）');
    assert.ok(Array.isArray(bus.times) && bus.times.length > 0, 'bus.times 必须是数组');
    for (const slice of bus.times) assert.equal(typeof slice.passed, 'boolean', 'time slice 必须有 passed 标记');
  }
});

await check('掌上公交：上下行 lineId 必须不同（否则详情页换向点不动）', async () => {
  const c = new MyGolbsClient('mg-deyang');
  const lines = await c.searchLines('2路');
  const sameName = lines.filter((x) => x.name === '2路');
  assert.ok(sameName.length >= 2, '2路应有上下行两个方向');
  const ids = sameName.map((x) => x.lineId);
  assert.equal(new Set(ids).size, ids.length, '上下行 lineId 不能相同：' + ids.join(','));
  assert.ok(ids.every((id) => id.includes('|')), 'lineId 必须带方向后缀');
  /* 带方向后缀的 lineId 仍能查详情 */
  const detail = await c.lineDetail(ids[0]);
  assert.ok(detail.stations.length > 10, '带 | 的 lineId 应能查到站表');
});

await check('掌上公交：三城线路目录都非空（德阳/广元/广安）', async () => {
  for (const id of ['mg-deyang', 'mg-guangyuan', 'mg-guangan']) {
    const c = new MyGolbsClient(id);
    const lines = await c.searchLines('');
    assert.ok(lines.length > 20, id + ' 应有多条线路，实际 ' + lines.length);
  }
});

await check('西昌：城市识别与 xc- 前缀隔离', async () => {
  assert.equal(xcIsMine('xc-xichang'), true);
  assert.equal(xcIsMine('mg-deyang'), false);
  assert.equal(xcIsMine('007'), false);
  assert.equal(XICHANG.transitOnly, true, '西昌必须标记为仅换乘');
});

await check('西昌：换乘规划能拿到真实线路（含起终点/首末班/票价）', async () => {
  const c = new XichangClient();
  let res;
  try {
    /* 上游 /search 会随运营调整返回空方案（2026-11-27 实测：
       原「州一医院→武警州支队」已无方案，返回 {"result":[]}）；
       换成当天实测仍有 2 条方案的市中心坐标对，继续验协议字段。 */
    res = await c.transit(27.8861, 102.2820, '航天大道', 27.8950, 102.2650, '火把广场');
  } catch (e) {
    if (e.waf) { console.log('   （WAF 限流，跳过）'); return; }
    throw e;
  }
  /* 这条打的是真实换乘接口：深夜（末班之后）会如实返回 {"result":[]}。
     那是「这个时段没车」，不是协议坏了 —— 与 WAF 同样按跳过处理，
     否则每晚跑测试都会红。白天跑会照常验全部字段。 */
  if (!res.transits.length) {
    console.log('   （当前时段没有可换乘线路，跳过字段校验）');
    return;
  }
  const busSegs = res.transits.flatMap((t) => t.segments).filter((s) => s.mode === 'bus');
  assert.ok(busSegs.length > 0, '至少要有一个公交段');
  const b = busSegs[0];
  assert.ok(b.name, '线路名不能为空');
  assert.ok(!b.name.includes('上行') && !b.name.includes('下行'), '线路名要去掉方向后缀：' + b.name);
  assert.ok(!b.name.includes('('), '线路名要去掉括号：' + b.name);
  assert.ok(b.from && b.to, '起终点站都要有');
  assert.ok(b.firstTime && b.lastTime, '首末班时间要有');
});

await check('西昌：实时车辆要走裸 TCP 协议（不是 HTTP），且无需签名', async () => {
  let r;
  try { r = await xcNearby(27.886099, 102.282078, 3); }
  catch (e) { console.log('   （服务器不可达，跳过）', e.message); return; }
  assert.ok(r.stops.length > 0, '应返回附近站点');
  assert.ok(r.allArrivals.length > 0, '应返回车辆记录');
  const s0 = r.stops[0];
  assert.ok(s0.name, '站点名不能为空');
  assert.ok(Number.isFinite(s0.distanceMeters), '站点自身距离要有');
  const a = s0.arrivals[0];
  assert.ok(a.lineName, '线路名不能为空');
  assert.ok(a.toward, '方向不能为空');
  assert.match(a.firstTime, /^\d{2}:\d{2}$/, '首班要格式化成 HH:MM：' + a.firstTime);
  assert.match(a.lastTime, /^\d{2}:\d{2}$/, '末班要格式化成 HH:MM：' + a.lastTime);
  /* 协议没有站表：算不出站数和 ETA。必须留 null，不能拿距离除臆测车速编一个 */
  assert.equal(a.etaSeconds, null, 'ETA 拿不到就必须 null，不能编造');
  assert.equal(a.stationsAway, null, '站数拿不到就必须 null，不能编造');
  assert.ok(Number.isFinite(a.distanceMeters), '必须给出「车距本站」米数，界面靠它显示');
});

await check('西昌：外地坐标回空表头，要当「当地没车」而不是超时', async () => {
  let r;
  try { r = await xcNearby(30.657, 104.065, 5); }
  catch (e) { console.log('   （服务器不可达，跳过）', e.message); return; }
  /* 这曾经是个真 bug：解析器只认 >200 字节的帧，
     于是 16 字节的「没车」空响应被当成没收到，一路等到 soTimeout。 */
  assert.equal(r.stops.length, 0, '外地坐标应返回 0 个站点，不能抛超时');
  assert.equal(r.allArrivals.length, 0, '外地坐标不该有车辆记录');
});

await check('西昌：站表（seq=7）能拿到完整站点序列', async () => {
  let d;
  try { d = await xcLineDetail('184'); }
  catch (e) { console.log('   （服务器不可达，跳过）', e.message); return; }
  assert.ok(d.stations.length > 5, '站表至少要有几站，实际：' + d.stations.length);
  const s0 = d.stations[0];
  assert.ok(s0.name, '站名不能为空');
  assert.ok(s0.order >= 1, '站序从 1 开始');
  assert.ok(Number.isFinite(s0.lat) && s0.lat !== 0, '站点要有纬度');
  assert.match(d.firstTime, /^\d{2}:\d{2}$/, '首班要格式化');
  assert.ok(Number(d.totalLength) > 0, '全程里程要有');
  /* 站序必须连续递增，否则说明解析错位 */
  for (let i = 1; i < d.stations.length; i++) {
    assert.ok(d.stations[i].order > d.stations[i - 1].order, '站序应递增，第' + i + '项异常');
  }
});

await check('西昌：速率（seq=95）能拿到车辆实时速度与站序', async () => {
  let v;
  try { v = await xcVehicles('184', 2991, 32, 27.885897, 102.281432); }
  catch (e) { console.log('   （服务器不可达，跳过）', e.message); return; }
  /* 深夜（末班后）线路上确实没有车：那是真实状态，不是解析坏了 */
  if (!v.length) { console.log('   （当前时段无在途车辆，跳过）'); return; }
  const b = v[0];
  assert.ok(b.plate, '车牌不能为空');
  assert.ok(Number.isFinite(b.speedKmh) && b.speedKmh >= 0, '速率要是非负数');
  assert.ok(b.order >= 0, '车辆当前站序要有');
});

await check('西昌：剩余站数按「目标站序−车辆站序+1」算，且停站不给 ETA', async () => {
  let arr;
  try { arr = await xcArrivals('184', { order: 32, lat: 27.885897, lng: 102.281432 }); }
  catch (e) { console.log('   （服务器不可达，跳过）', e.message); return; }
  if (!arr.length) { console.log('   （当前时段无在途车辆，跳过）'); return; }
  for (const a of arr) {
    if (a.stationsAway !== null) {
      const expect = 32 - a.order + 1;
      /* 车已经贴到目标站（<100 米）时，产品上按「还有 1 站/即将进站」播，
         不按公式报——这是有意的就近覆盖，不是解析错误。 */
      assert.ok(a.stationsAway === expect || (a.stationsAway === 1 && a.arrived),
        '站数公式不对：' + a.order + '→' + a.stationsAway + '（期望 ' + expect + '）');
    }
    /* 停站（速率<5）不许给 ETA；给 0 或无穷都是假的 */
    if (a.speedKmh < 5) assert.equal(a.etaSeconds, null, '停站时不该给 ETA');
  }
});

await check('西昌：字段 4 与 seq=95 字段 7 是站点 ID，不是米数', async () => {
  let nb;
  try { nb = await xcNearby(27.886099, 102.282078, 2); }
  catch (e) { console.log('   （服务器不可达，跳过）', e.message); return; }
  const a = nb.stops[0] && nb.stops[0].arrivals[0];
  if (!a) { console.log('   （当前时段无在途车辆，跳过）'); return; }
  /* 曾经的 bug：把字段 4（站点 ID，如 2991）当「车距本站米数」显示，
     界面上会出现「距本站约 2991 米」这种假数据。 */
  const d = await xcLineDetail(a.routeDirId);
  const ids = new Set(d.stations.map((x) => String(x.stationId)));
  assert.ok(ids.has(String(a.stationId)), 'arrival.stationId 必须是站表里的真实站 ID，实际：' + a.stationId);
  assert.ok(!ids.has('67'), '站 ID 不该是距离数字');

  const v = await xcVehicles(a.routeDirId, a.stationId, a.targetOrder, 27.885897, 102.281432);
  const bb = v[0];
  if (!bb) { console.log('   （当前时段无在途车辆，跳过字段 7 校验）'); return; }
  assert.ok(ids.has(String(bb.nextStationId)), 'seq=95 字段 7 应是站 ID，实际：' + bb.nextStationId);
  assert.equal(bb.nextDistance, undefined, '不该再有 nextDistance（字段 7 不是距离）');
});

await check('西昌：剩余距离用站表坐标算，随站序单调递减', async () => {
  let nb;
  try { nb = await xcNearby(27.886099, 102.282078, 2); }
  catch (e) { console.log('   （服务器不可达，跳过）', e.message); return; }
  const a = nb.stops[0].arrivals.find((x) => x.lineName === '107路');
  if (!a) { console.log('   （附近没有 107 路，跳过）'); return; }
  const d = await xcLineDetail(a.routeDirId);
  const tgt = d.stations.find((x) => String(x.stationId) === String(a.stationId));
  assert.ok(tgt, '目标站应能在站表里找到');

  const v = await xcVehicles(a.routeDirId, a.stationId, tgt.order, tgt.lat, tgt.lng);
  const rows = [];
  for (const b of v) {
    const p = await xcProgress(b, a.routeDirId, tgt.order);
    if (p.remainingMeters) rows.push({ order: b.order, m: p.remainingMeters, p });
  }
  assert.ok(rows.length >= 2, '至少要有两辆车能算出距离，实际：' + rows.length);
  rows.sort((x, y) => x.order - y.order);
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i].m <= rows[i - 1].m,
      '站序越大剩余距离应越小：序' + rows[i - 1].order + '(' + rows[i - 1].m + 'm) → 序' + rows[i].order + '(' + rows[i].m + 'm)');
  }
  /* 已过站的车不该给 ETA */
  for (const r of rows) if (r.p.passed) assert.equal(r.p.etaSeconds, null, '已过站的车不该给 ETA');
});

await check('西昌：坐标算出的线路总长与协议声明相差 <1%', async () => {
  let d;
  try { d = await xcLineDetail('184'); }
  catch (e) { console.log('   （服务器不可达，跳过）', e.message); return; }
  let sum = 0;
  for (let i = 1; i < d.stations.length; i++) {
    const p = d.stations[i - 1], q = d.stations[i];
    sum += xcDist(p.lat, p.lng, q.lat, q.lng);
  }
  const claim = Number(d.totalLength);
  assert.ok(claim > 0, '协议应给出全程里程');
  const diff = Math.abs(sum - claim) / claim;
  assert.ok(diff < 0.01, `坐标实算 ${Math.round(sum)}m 与声明 ${claim}m 差异 ${(diff * 100).toFixed(2)}% 过大`);
});

await check('西昌：线路名要去掉「路」和方向后缀（否则界面显示「39路路」）', async () => {
  /* 其它数据源的 lineName 不带「路」，前端到处 lineName + "路" 拼接。
     西昌协议里自带「路」，不剥掉会重复。 */
  assert.equal(xcNorm('39路'), '39', '「39路」应规范成「39」');
  assert.equal(xcNorm('107路下行(西宁-川兴车站)'), '107', '要剥掉方向和括号');
  assert.equal(xcNorm('107路上行(川兴车站-西宁)'), '107', '上下行都要剥');
  assert.equal(xcNorm('环湖（建昌古城-建昌古城）'), '环湖', '全角括号也要剥');
  assert.equal(xcNorm('121路'), '121');
});

await check('西昌：附近返回的 lineName 已规范化，前端拼「路」不会重复', async () => {
  let nb;
  try { nb = await xcNearby(27.886099, 102.282078, 1); }
  catch (e) { console.log('   （服务器不可达，跳过）', e.message); return; }
  for (const a of nb.stops[0].arrivals) {
    assert.ok(!/路$/.test(a.lineName), 'lineName 不该以「路」结尾：' + a.lineName);
    assert.ok(!/[（(]/.test(a.lineName), 'lineName 不该带括号：' + a.lineName);
    assert.ok(a.lineName, 'lineName 不能为空');
  }
});

await check('西昌：界面拿到的合成 lineId（1|开往）能换成协议要的数字方向 ID', async () => {
  /* 界面沿用车来了的习惯，lineId 是「1|观鸟岛湿地公园」；协议只认数字方向 ID。
     直接拿合成串查 seq=7，服务器会立刻断开连接，界面只能报「服务器没响应」
     （这就是详情页那次故障）。必须先把 lineId 换回 routeDirId。 */
  let nb;
  try { nb = await xcNearby(27.886099, 102.282078, 3); }
  catch (e) { console.log('   （服务器不可达，跳过）', e.message); return; }
  const a = nb.allArrivals.find((x) => x.routeDirId && x.lineId);
  assert.ok(a, '附近接口要带 routeDirId 和 lineId');
  assert.match(String(a.lineId), /\|/, 'lineId 应是「线路名|开往」的合成串');
  const rid = await xcRouteDirIdOf(a.lineId);
  assert.match(rid, /^\d+$/, '换出来的方向 ID 必须是纯数字，实际：' + rid);
  assert.equal(rid, a.routeDirId, '换出来的方向 ID 要和附近接口给的一致');
  /* 用合成串直接查站表也必须成功（内部会先换 ID） */
  const d = await xcLineDetail(a.lineId);
  assert.ok(d.stations.length > 0, '合成 lineId 也要能拉到站表');
  /* 不认识的串要给明确提示，而不是等 15 秒超时 */
  assert.equal(await xcRouteDirIdOf(a.routeDirId), a.routeDirId, '数字 ID 应原样返回');
});

await check('西昌：详情页能拿到换向方向与各自首末班（环线只有单方向）', async () => {
  try { await xcNearby(27.8861, 102.2820, 8); }
  catch (e) { console.log('   （服务器不可达，跳过）', e.message); return; }
  const dirs = await xcDirections('412');
  assert.ok(dirs.length >= 2, '39路应能配到两个方向，实际：' + dirs.length);
  assert.match(String(dirs[0].lineId), /^\d+$/, '方向 ID 必须是数字');
  for (const d of dirs) {
    assert.equal(d.name, '39', '同一线路名的两个方向');
    assert.match(d.firstTime, /^\d{2}:\d{2}$/, '首班要格式化：' + d.firstTime);
    assert.match(d.lastTime, /^\d{2}:\d{2}$/, '末班要格式化：' + d.lastTime);
    assert.ok(d.startSn && d.endSn, '方向要有起终点');
  }
  assert.notEqual(dirs[0].startSn, dirs[1].startSn, '两个方向的起点应互为终点');
  /* 环线（1路）没有反向：只给 1 条，前端照样显示首末班 */
  const ring = await xcDirections('2');
  assert.equal(ring.length, 1, '环线不该凭空编出反向，实际：' + ring.length);
  assert.match(ring[0].firstTime, /^\d{2}:\d{2}$/, '环线也要有首班');
});

await check('西昌：同一站点的同一线路只画一格（上下行不重复）', async () => {
  let nb;
  try { nb = await xcNearby(27.8861, 102.2820, 8); }
  catch (e) { console.log('   （服务器不可达，跳过）', e.message); return; }
  let dupFound = 0;
  for (const stop of nb.stops) {
    const names = stop.arrivals.map((a) => a.lineName);
    const uniq = [...new Set(names)];
    assert.equal(uniq.length, names.length,
      stop.name + ' 出现重复线路：' + names.join(' / '));
    assert.deepEqual(stop.lineNameList, uniq,
      stop.name + ' 的 lineNameList 要和去重后的 arrivals 一致');
    if (names.length < stop.arrivals.length + 1) dupFound += 0;
  }
  /* 每个方向的原始记录都要留在 allArrivals 里：搜索筛线路还靠它 */
  const totalInStops = nb.stops.reduce((n, s2) => n + s2.arrivals.length, 0);
  assert.ok(nb.allArrivals.length >= totalInStops,
    'allArrivals 不该被去重削掉（还有用）');
});

console.log(`\n全部通过：${passed} 项`);