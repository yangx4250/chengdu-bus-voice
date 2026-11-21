#!/usr/bin/env node
/**
 * 冒烟测试：不打桩，直接打真实接口（成都）。网络不通时会被跳过并提示。
 */

import assert from 'node:assert/strict';
import { BusClient, BusApiError, CHENGDU } from '../lib/chelaile.mjs';
import {
  buildNearbyAnnouncement,
  buildStationAnnouncement,
  describeBus,
  isUrgent,
} from '../lib/announce.mjs';
import { splitForSpeech } from '../lib/speech.mjs';

let passed = 0;
const check = async (name, fn) => {
  const value = await fn();
  passed += 1;
  console.log(`✓ ${name}`);
  return value;
};

const client = new BusClient({ retries: 1 });

await check('成都坐标被接受', async () => {
  const city = await client.assertChengdu({ lat: 30.657, lng: 104.065 });
  assert.equal(city.cityId, CHENGDU.cityId);
});

await check('外地坐标被拒绝', async () => {
  await assert.rejects(
    () => client.assertChengdu({ lat: 39.9042, lng: 116.4074 }),
    (err) => err instanceof BusApiError && /北京/.test(err.message),
  );
});

await check('都江堰坐标被接受', async () => {
  const city = await client.assertChengdu({ lat: 30.99, lng: 103.62 });
  assert.equal(city.name, '都江堰');
});

const lines = await check('线路搜索可用且不含地铁', async () => {
  const result = await client.searchLines('1路');
  assert.ok(result.length > 0, '没有搜到 1路');
  assert.ok(result.every((line) => !String(line.name).startsWith('地铁')), '出现了地铁');
  return result;
});

await check('都江堰线路可搜到', async () => {
  const result = await client.searchLines('都江堰1');
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

console.log(`\n全部通过：${passed} 项`);