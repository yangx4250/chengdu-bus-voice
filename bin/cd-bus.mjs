#!/usr/bin/env node
/**
 * cd-bus —— 成都公交实时到站语音播报
 *
 *   cd-bus near                     附近站点实时到站（默认天府广场坐标）
 *   cd-bus line 1路 --stop 大业路    指定线路 + 站点，播报还有几站/几分钟
 *   cd-bus stations 1路              看这条线沿途所有站点
 *   cd-bus watch 1路 --stop 大业路   持续盯站，车快到时自动播报
 *
 * 只支持成都。数据来自车来了小程序接口，仅供个人出行参考。
 */

import { parseArgs } from 'node:util';
import { BusClient, BusApiError, CHENGDU } from '../lib/chelaile.mjs';
import {
  buildNearbyAnnouncement,
  buildStationAnnouncement,
  describeBus,
  formatEta,
  isUrgent,
} from '../lib/announce.mjs';
import { Speaker } from '../lib/speech.mjs';

const DEFAULT_LAT = Number(process.env.CD_BUS_LAT ?? 30.657);
const DEFAULT_LNG = Number(process.env.CD_BUS_LNG ?? 104.065);

const USAGE = `cd-bus —— 成都公交到站语音播报

用法:
  cd-bus near   [--lat 30.657 --lng 104.065] [--limit 4]   附近站点实时到站
  cd-bus line   <线路号> [--stop <站名>] [--dir 0|1]        指定线路到站信息
  cd-bus stations <线路号> [--dir 0|1]                      线路沿途站点
  cd-bus watch  <线路号> --stop <站名> [--every 30]         盯站并自动播报
  cd-bus say    <文字>                                     试听语音后端

通用参数:
  --speak / --no-speak     是否发声（默认 line/near 不发声，watch 发声）
  --voice <auto|termux|online|system|off>   语音后端（默认 auto）
  --json                   输出原始 JSON，便于二次处理
  --lat/--lng              坐标（默认天府广场，可用 CD_BUS_LAT / CD_BUS_LNG）

示例:
  cd-bus line 1路 --stop 大业路 --speak
  cd-bus watch 16路 --stop 天府广场南 --every 90
`;

function parse() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      lat: { type: 'string' },
      lng: { type: 'string' },
      stop: { type: 'string' },
      dir: { type: 'string' },
      order: { type: 'string' },
      limit: { type: 'string', default: '4' },
      every: { type: 'string', default: '30' },
      voice: { type: 'string', default: 'auto' },
      speak: { type: 'boolean' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  return { values, positionals };
}

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const c = {
  dim: paint(2),
  bold: paint(1),
  cyan: paint(36),
  yellow: paint(33),
  green: paint(32),
  red: paint(31),
};

const clock = () => new Date().toLocaleTimeString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });

/** 中文字符占两个显示宽度，用 padEnd 对齐会歪，这里按显示宽度补空格。 */
const isWide = (ch) => /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch);
const displayWidth = (value) => [...String(value)].reduce((w, ch) => w + (isWide(ch) ? 2 : 1), 0);
const padRight = (value, width) => {
  const gap = width - displayWidth(value);
  return gap > 0 ? value + ' '.repeat(gap) : value;
};

async function resolveLine(client, keyword, dir) {
  const lines = await client.searchLines(keyword);
  if (!lines.length) throw new BusApiError(`成都没有查到线路「${keyword}」。`);
  const exact = lines.filter((line) => String(line.name) === String(keyword).replace(/路$/, ''));
  const pool = exact.length ? exact : lines;
  const wanted = dir == null ? pool[0] : pool.find((line) => String(line.direction) === String(dir)) ?? pool[0];
  return { picked: wanted, all: lines };
}

function resolveStation(stations, wanted) {
  if (!wanted) {
    throw new BusApiError(`请用 --stop 指定站点，可选：${stations.slice(0, 6).map((s) => s.name).join('、')} …`);
  }
  const exact = stations.find((st) => st.name === wanted);
  if (exact) return exact;
  const fuzzy = stations.filter((st) => st.name.includes(wanted) || wanted.includes(st.name));
  if (fuzzy.length === 1) return fuzzy[0];
  if (fuzzy.length > 1) {
    throw new BusApiError(`站名「${wanted}」匹配到多个：${fuzzy.map((st) => st.name).join('、')}`);
  }
  throw new BusApiError(`该线路没有「${wanted}」站。可选：${stations.slice(0, 8).map((s) => s.name).join('、')} …`);
}

async function speakOrPrint(speaker, text, { enabled }) {
  console.log(`\n${c.bold('🔊 播报文案：')}${c.cyan(text)}`);
  if (!enabled) return;
  const result = await speaker.speak(text);
  if (result.spoken) {
    console.log(c.green(`   ✓ 已用「${speaker.describe()}」播报${result.player ? `（播放器：${result.player}）` : ''}`));
  } else {
    console.log(c.yellow(`   ⚠ 未发声：${result.reason ?? '未知原因'}`));
    if (result.file) console.log(c.dim(`   语音文件：${result.file}`));
  }
}

async function cmdNear(client, values, positionals) {
  const lat = Number(values.lat ?? DEFAULT_LAT);
  const lng = Number(values.lng ?? DEFAULT_LNG);
  await client.assertChengdu({ lat, lng });

  const { stops, allArrivals } = await client.nearby(lat, lng, { limit: Number(values.limit) });
  if (values.json) {
    console.log(JSON.stringify({ city: CHENGDU.name, lat, lng, stops, allArrivals }, null, 2));
    return;
  }

  console.log(c.bold(`成都 · 附近站点（${clock()}，坐标 ${lat},${lng}）`));
  for (const stop of stops) {
    console.log(`\n${c.cyan(`【${stop.name}】`)} ${c.dim(`距你约 ${stop.distanceMeters} 米`)}`);
    if (!stop.arrivals.length) {
      console.log(c.dim('  暂无实时车辆'));
      continue;
    }
    for (const arrival of stop.arrivals.slice(0, 4)) {
      const label = arrival.arrived ? c.red('即将进站') : describeBus(arrival);
      const name = padRight(`${arrival.lineName}路`, 7);
      console.log(`  ${name} 往 ${padRight(arrival.toward ?? '-', 16)} ${c.yellow(label)}`);
    }
  }

  const text = buildNearbyAnnouncement(stops, { maxStops: 3 });
  await speakOrPrint(new Speaker({ mode: values.voice }), text, { enabled: Boolean(values.speak) });
}

async function cmdLine(client, values, positionals) {
  const keyword = positionals[1];
  if (!keyword) throw new BusApiError('用法：cd-bus line <线路号> [--stop 站名]');

  const { picked, all } = await resolveLine(client, keyword, values.dir);
  const detail = await client.lineDetail(picked.lineId);
  if (values.json && !values.stop) {
    console.log(JSON.stringify({ line: detail }, null, 2));
    return;
  }

  if (values.stop == null && values.order == null) {
    console.log(c.bold(`${detail.name}路  ${detail.startSn} → ${detail.endSn}`));
    console.log(c.dim(`首班 ${detail.firstTime} · 末班 ${detail.lastTime} · 票价 ${detail.price || '-'} · ${detail.stations.length} 站`));
    if (all.length > 1) {
      console.log(c.dim(`同名其它走向：${all.filter((l) => l.lineId !== picked.lineId).map((l) => `${l.startSn} → ${l.endSn}(--dir ${l.direction})`).join('；')}`));
    }
    console.log(c.bold('\n沿途站点:'));
    detail.stations.forEach((st, i) => {
      console.log(`  ${String(i + 1).padStart(2)}. ${st.name}`);
    });
    console.log(c.dim('\n提示：加 --stop <站名> 查看该站实时到站。'));
    return;
  }

  const station = values.order != null
    ? detail.stations.find((st) => String(st.order) === String(values.order))
    : resolveStation(detail.stations, values.stop);
  if (!station) throw new BusApiError(`没有 order=${values.order} 的站点。`);

  const rows = await renderArrivals(client, detail, station, values.json);
  const text = buildStationAnnouncement({
    lineName: detail.name,
    toward: detail.endSn,
    stationName: station.name,
    buses: rows.map((row) => ({ stationsAway: row.stationsAway, etaSeconds: row.etaSeconds, arrived: row.arrived })),
  });
  await speakOrPrint(new Speaker({ mode: values.voice }), text, { enabled: Boolean(values.speak) });
}

async function renderArrivals(client, detail, station, asJson = false) {
  const { buses } = await client.arrivals(detail.lineId, station);
  if (asJson) {
    console.log(JSON.stringify({ line: detail.name, station: station.name, buses }, null, 2));
    return buses;
  }
  console.log(`\n${c.bold(`${detail.name}路 · ${station.name}站`)} ${c.dim(`（${clock()} 实时）`)}`);
  if (!buses.length) {
    console.log(c.dim('  暂无即将到站的车辆（可能已收班或区间调度中）'));
    return [];
  }
  buses.slice(0, 4).forEach((bus, i) => {
    const tag = bus.arrived ? c.red('即将进站') : bus.stationsAway <= 2 ? c.red(describeBus(bus)) : c.yellow(describeBus(bus));
    console.log(`  ${i === 0 ? '最近' : `第${i + 1}辆`}  还有 ${String(bus.stationsAway).padStart(2)} 站 · 约 ${bus.distanceMeters} 米 · ${tag} · ETA ${formatEta(bus.etaSeconds)}`);
  });
  return buses;
}

async function cmdWatch(client, values, positionals) {
  const keyword = positionals[1];
  if (!keyword || !values.stop) throw new BusApiError('用法：cd-bus watch <线路号> --stop <站名> [--every 60]');

  const { picked } = await resolveLine(client, keyword, values.dir);
  const detail = await client.lineDetail(picked.lineId);
  const station = resolveStation(detail.stations, values.stop);
  const intervalMs = Math.max(20, Number(values.every)) * 1000;
  const speaker = new Speaker({ mode: values.voice });
  const speakEnabled = values.speak !== false; // watch 默认发声

  console.log(c.bold(`盯站中：${detail.name}路 → ${station.name}站`));
  console.log(c.dim(`每 ${intervalMs / 1000} 秒刷新一次；车 ≤2 站或 ≤3 分钟时自动播报。Ctrl+C 结束。\n`));

  let lastSpoken = { text: '', at: 0 };
  let wasUrgent = false;

  const tick = async () => {
    try {
      const { buses } = await client.arrivals(detail.lineId, station);
      const first = buses[0];
      const line = first
        ? `${detail.name}路 还有 ${first.stationsAway} 站，${formatEta(first.etaSeconds)}`
        : `${detail.name}路 暂无车辆`;
      process.stdout.write(`${c.dim(clock())}  ${line}\n`);

      const urgent = isUrgent(first);
      const text = buildStationAnnouncement({
        lineName: detail.name,
        toward: detail.endSn,
        stationName: station.name,
        buses,
      });
      const now = Date.now();
      const shouldSpeak =
        speakEnabled &&
        buses.length > 0 &&
        ((urgent && !wasUrgent) || now - lastSpoken.at > 5 * 60 * 1000);

      if (shouldSpeak) {
        lastSpoken = { text, at: now };
        await speakOrPrint(speaker, text, { enabled: true });
      }
      wasUrgent = urgent;
    } catch (err) {
      console.log(c.yellow(`  ! ${clock()} 刷新失败：${err.message}`));
    }
  };

  await tick();
  const timer = setInterval(tick, intervalMs);
  const stop = () => {
    clearInterval(timer);
    console.log(c.dim('\n已停止盯站。'));
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

async function cmdStations(client, values, positionals) {
  const keyword = positionals[1];
  if (!keyword) throw new BusApiError('用法：cd-bus stations <线路号> [--dir 0|1]');
  const { picked, all } = await resolveLine(client, keyword, values.dir);
  const detail = await client.lineDetail(picked.lineId);
  if (values.json) {
    console.log(JSON.stringify(detail, null, 2));
    return;
  }
  console.log(c.bold(`${detail.name}路  ${detail.startSn} → ${detail.endSn}`));
  console.log(c.dim(`首班 ${detail.firstTime} · 末班 ${detail.lastTime} · ${detail.stations.length} 站`));
  detail.stations.forEach((st, i) => console.log(`  ${String(i + 1).padStart(2)}. ${st.name}`));
  if (all.length > 1) {
    console.log(c.dim(`\n同名其它走向：${all.filter((l) => l.lineId !== picked.lineId).map((l) => `${l.startSn} → ${l.endSn}（--dir ${l.direction}）`).join('；')}`));
  }
}

async function main() {
  const { values, positionals } = parse();
  if (values.help || positionals.length === 0) {
    console.log(USAGE);
    return;
  }

  const command = positionals[0];
  const client = new BusClient();

  try {
    switch (command) {
      case 'near':
        await cmdNear(client, values, positionals);
        break;
      case 'line':
        await cmdLine(client, values, positionals);
        break;
      case 'stations':
        await cmdStations(client, values, positionals);
        break;
      case 'watch':
        await cmdWatch(client, values, positionals);
        break;
      case 'say': {
        const text = positionals.slice(1).join(' ');
        if (!text) throw new BusApiError('用法：cd-bus say <文字>');
        const speaker = new Speaker({ mode: values.voice });
        console.log(c.dim(`语音后端：${speaker.describe()}`));
        const result = await speaker.speak(text);
        console.log(result.spoken ? c.green('✓ 已播报') : c.yellow(`⚠ 未发声：${result.reason ?? ''}`));
        if (result.file) console.log(c.dim(`文件：${result.file}`));
        break;
      }
      default:
        console.log(USAGE);
        process.exitCode = 1;
    }
  } catch (err) {
    if (err instanceof BusApiError) {
      console.error(c.red(`✗ ${err.message}`));
      process.exitCode = 2;
    } else {
      console.error(c.red(`✗ ${err.stack ?? err.message}`));
      process.exitCode = 1;
    }
  }
}

main();