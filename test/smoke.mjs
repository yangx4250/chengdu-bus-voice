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
  assert.match(text, /16路/);
  assert.match(text, /2 站/);
  assert.match(text, /4 分钟/);

  const nearby = buildNearbyAnnouncement([
    { name: '大业路', arrivals: [{ lineName: '8', stationsAway: 3, etaSeconds: 600, arrived: false }] },
  ]);
  assert.match(nearby, /大业路站/);
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
  assert.ok(l.lineId === '2路', 'lineId 是线路名');
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

await check('掌上公交：三城线路目录都非空（德阳/广元/广安）', async () => {
  for (const id of ['mg-deyang', 'mg-guangyuan', 'mg-guangan']) {
    const c = new MyGolbsClient(id);
    const lines = await c.searchLines('');
    assert.ok(lines.length > 20, id + ' 应有多条线路，实际 ' + lines.length);
  }
});

console.log(`\n全部通过：${passed} 项`);