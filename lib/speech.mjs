/**
 * 语音播报后端。按可用性自动降级，永远不因为「没装 TTS」而让主流程失败。
 *
 *   1. termux   —— Termux:API 的 termux-tts-speak（离线、秒出，Android 首选）
 *   2. system   —— macOS say / Linux espeak-ng / spd-say
 *   3. online   —— Google 翻译 TTS 合成 mp3，再用本机播放器播放
 *   4. silent   —— 只输出文字
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdir, access, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const TTS_URL = 'https://translate.google.com/translate_tts';
const MAX_CHUNK = 180;

function hasCommand(name) {
  const probe = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' });
  return probe.status === 0 && probe.stdout.trim().length > 0;
}

function run(command, args, { timeoutMs = 20000 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(command, args, { stdio: 'ignore' });
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGKILL');
        resolve({ ok: false, reason: 'timeout' });
      }
    }, timeoutMs);
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, reason: err.message });
    });
    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, reason: code === 0 ? undefined : `exit ${code}` });
    });
  });
}

/** 长文本按标点切块（Google TTS 单次上限约 200 字符）。 */
export function splitForSpeech(text, size = MAX_CHUNK) {
  const chunks = [];
  const sentences = text.split(/(?<=[。；！？,，])/).filter((part) => part.trim());
  let buffer = '';
  for (const sentence of sentences) {
    if ((buffer + sentence).length > size && buffer) {
      chunks.push(buffer);
      buffer = '';
    }
    if (sentence.length > size) {
      for (let i = 0; i < sentence.length; i += size) chunks.push(sentence.slice(i, i + size));
    } else {
      buffer += sentence;
    }
  }
  if (buffer) chunks.push(buffer);
  return chunks.length ? chunks : [text.slice(0, size)];
}

async function synthesizeMp3(text, outDir) {
  await mkdir(outDir, { recursive: true });
  const buffers = [];
  for (const chunk of splitForSpeech(text)) {
    const url = new URL(TTS_URL);
    url.searchParams.set('ie', 'UTF-8');
    url.searchParams.set('client', 'tw-ob');
    url.searchParams.set('tl', 'zh-CN');
    url.searchParams.set('q', chunk);
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/132 Safari/537.36',
        'Referer': 'https://translate.google.com/',
      },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`TTS HTTP ${res.status}`);
    buffers.push(Buffer.from(await res.arrayBuffer()));
  }
  const file = path.join(outDir, `cdbus-${Date.now()}.mp3`);
  await writeFile(file, Buffer.concat(buffers));
  return file;
}

async function playFile(file) {
  if (hasCommand('termux-media-player')) {
    const r = await run('termux-media-player', ['play', file]);
    if (r.ok) return { ok: true, player: 'termux-media-player' };
  }
  if (hasCommand('am')) {
    // Android：交给系统默认音频播放器（Termux:API 未装时的兜底）
    const r = await run('am', ['start', '-a', 'android.intent.action.VIEW', '-d', `file://${file}`, '-t', 'audio/mpeg']);
    if (r.ok) return { ok: true, player: 'am' };
  }
  for (const player of [['mpv', ['--no-video']], ['ffplay', ['-nodisp', '-autoexit']], ['afplay', []], ['aplay', []]]) {
    const [cmd, preArgs] = player;
    if (!hasCommand(cmd)) continue;
    const r = await run(cmd, [...preArgs, file]);
    if (r.ok) return { ok: true, player: cmd };
  }
  return { ok: false };
}

export class Speaker {
  constructor({ mode = 'auto', language = 'zh-CN', rate = 1.0, cacheDir } = {}) {
    this.mode = mode;
    this.language = language;
    this.rate = rate;
    this.cacheDir = cacheDir ?? path.join(os.homedir(), '.cache', 'chengdu-bus');
    this.backend = this.#pickBackend();
    this.log = [];
  }

  #pickBackend() {
    const forced = this.mode;
    if (forced === 'off' || forced === 'none') return 'silent';
    if (forced === 'termux') return 'termux';
    if (forced === 'system') return hasCommand('say') ? 'say' : 'system';
    if (forced === 'online') return 'online';
    if (forced === 'auto') {
      if (hasCommand('termux-tts-speak')) return 'termux';
      if (hasCommand('say')) return 'say';
      if (hasCommand('espeak-ng')) return 'espeak';
      return 'online';
    }
    return forced;
  }

  describe() {
    return {
      termux: 'Termux:API 本机 TTS',
      say: 'macOS say',
      espeak: 'espeak-ng',
      system: '系统 TTS',
      online: '在线 TTS 合成 mp3',
      silent: '仅文字（不发声）',
    }[this.backend] ?? this.backend;
  }

  async speak(text) {
    const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (!clean) return { spoken: false, reason: 'empty' };

    if (this.backend === 'termux') {
      const r = await run('termux-tts-speak', ['-l', this.language, '-r', String(this.rate), clean], { timeoutMs: 60000 });
      return { spoken: r.ok, backend: 'termux', reason: r.reason };
    }
    if (this.backend === 'say') {
      const r = await run('say', ['-v', 'Tingting', clean], { timeoutMs: 60000 });
      return { spoken: r.ok, backend: 'say', reason: r.reason };
    }
    if (this.backend === 'espeak') {
      const r = await run('espeak-ng', ['-v', 'cmn', '-s', String(Math.round(160 * this.rate)), clean], { timeoutMs: 60000 });
      return { spoken: r.ok, backend: 'espeak', reason: r.reason };
    }
    if (this.backend === 'silent') {
      return { spoken: false, backend: 'silent', reason: '语音已关闭' };
    }

    // online：合成 mp3 再尝试本机播放
    try {
      const file = await synthesizeMp3(clean, this.cacheDir);
      const played = await playFile(file);
      return {
        spoken: played.ok,
        backend: 'online',
        file,
        player: played.player,
        reason: played.ok ? undefined : '已生成语音文件，但本机没有可自动调用的播放器（可手动打开该 mp3）',
      };
    } catch (err) {
      return { spoken: false, backend: 'online', reason: err.message };
    }
  }
}

export const speakerAvailable = { hasCommand };