package com.chengdu.bus;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioDeviceInfo;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioTrack;
import android.media.MediaCodec;
import android.media.MediaExtractor;
import android.media.MediaFormat;
import android.media.ToneGenerator;
import android.media.MediaPlayer;
import android.os.Handler;
import android.os.Looper;
import android.speech.tts.TextToSpeech;
import android.util.Log;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.io.File;
import java.io.FileOutputStream;
import java.io.FileInputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 播报输出。
 *
 *   1. 有中文系统 TTS → 直接念；
 *   2. 没有（或念失败）→ Google 翻译 TTS 合成 mp3，再用 MediaPlayer 播；
 *   3. 仍然失败 → 把「哪一步失败、为什么」回传给界面，绝不静默。
 *
 * 另外提供 diag() / playTone()，用来定位是引擎、网络、还是音量的问题。
 */
public final class Speech {

    public interface Callback {
        void onResult(boolean spoken, String detail);
    }

    private static final String TAG = "CdBusSpeech";
    private static final String TTS_URL = "https://translate.google.com/translate_tts";
    private static final int CHUNK = 170;

    private final Context context;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newSingleThreadExecutor();

    private TextToSpeech tts;
    private volatile boolean ttsReady = false;
    private volatile String lastResult = "还没播过";
    private MediaPlayer player;

    public Speech(Context context) {
        this.context = context.getApplicationContext();
        initTts();
    }

    private void initTts() {
        try {
            tts = new TextToSpeech(context, new TextToSpeech.OnInitListener() {
                @Override
                public void onInit(int status) {
                    if (status != TextToSpeech.SUCCESS) {
                        ttsReady = false;
                        lastResult = "系统 TTS 初始化失败（status=" + status + "），改用在线语音";
                        return;
                    }
                    int result = tts.setLanguage(Locale.SIMPLIFIED_CHINESE);
                    boolean ok = result != TextToSpeech.LANG_MISSING_DATA
                            && result != TextToSpeech.LANG_NOT_SUPPORTED;
                    ttsReady = ok;
                    lastResult = ok ? "系统 TTS 可用" : "系统没有中文 TTS，改用在线语音";
                }
            });
        } catch (Throwable e) {
            ttsReady = false;
            lastResult = "创建 TTS 失败：" + e.getMessage();
        }
    }

    public String backendName() {
        return ttsReady ? "系统语音" : "在线语音";
    }

    public String lastResult() {
        return lastResult;
    }

    /** 让页面把播放阶段的状态写进「最近结果」，方便一眼定位。 */
    public void note(String text) {
        lastResult = text;
        Log.i(TAG, "note: " + text);
    }

    /** 环境自检：引擎、音量、铃声模式，同步返回，界面直接显示。 */
    public JSONObject diag() {
        JSONObject out = new JSONObject();
        try {
            out.put("ttsReady", ttsReady);
            out.put("backend", backendName());
            out.put("lastResult", lastResult);
            try {
                StringBuilder names = new StringBuilder();
                List<TextToSpeech.EngineInfo> engines = tts == null ? null : tts.getEngines();
                if (engines == null || engines.isEmpty()) {
                    names.append("无");
                } else {
                    for (TextToSpeech.EngineInfo info : engines) {
                        if (names.length() > 0) names.append("; ");
                        names.append(info.name);
                    }
                }
                out.put("engines", names.toString());
            } catch (Throwable e) {
                out.put("engines", "读取失败：" + e.getMessage());
            }
            AudioManager audio = (AudioManager) context.getSystemService(Context.AUDIO_SERVICE);
            if (audio != null) {
                out.put("mediaVolume", audio.getStreamVolume(AudioManager.STREAM_MUSIC));
                out.put("mediaMax", audio.getStreamMaxVolume(AudioManager.STREAM_MUSIC));
                out.put("ringerMode", audio.getRingerMode());
                out.put("musicActive", audio.isMusicActive());
                out.put("bluetoothA2dp", audio.isBluetoothA2dpOn());
                out.put("wiredHeadset", audio.isWiredHeadsetOn());
                StringBuilder dev = new StringBuilder();
                try {
                    for (AudioDeviceInfo info : audio.getDevices(AudioManager.GET_DEVICES_OUTPUTS)) {
                        if (dev.length() > 0) dev.append(" / ");
                        dev.append(deviceName(info.getType()));
                    }
                } catch (Throwable e) {
                    dev.append("读取失败：").append(e.getMessage());
                }
                out.put("outputs", dev.toString());
            }
        } catch (Exception e) {
            Log.w(TAG, "diag 失败", e);
        }
        return out;
    }

    /** 播一段本地生成的测试音（不联网）：区分「音量/设备问题」和「语音链路问题」。 */
    public void playTone(final Callback callback) {
        io.execute(new Runnable() {
            @Override
            public void run() {
                try {
                    final File file = buildTone();
                    main.post(new Runnable() {
                        @Override
                        public void run() {
                            play(file, callback, "测试音");
                        }
                    });
                } catch (final Exception e) {
                    main.post(new Runnable() {
                        @Override
                        public void run() {
                            callback.onResult(false, "测试音生成失败：" + e.getMessage());
                        }
                    });
                }
            }
        });
    }

    /** 合成一段语音，返回 base64 的 mp3，交给 WebView 的 <audio> 播。 */
    public String synthesizeBase64(String text) throws Exception {
        File file = synthesize(text);
        byte[] bytes = new byte[(int) file.length()];
        try (FileInputStream in = new FileInputStream(file)) {
            int read = 0;
            while (read < bytes.length) {
                int n = in.read(bytes, read, bytes.length - read);
                if (n <= 0) break;
                read += n;
            }
        }
        return android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP);
    }

    /**
     * 把合成出来的 mp3 解码成 16bit PCM WAV。
     * 有些 ROM 的 WebView 缺 MP3 解码器（WAV 却能播），所以网页播 mp3 失败时降级成 WAV。
     */
    public String synthesizeWavBase64(String text) throws Exception {
        File mp3 = synthesize(text);
        byte[] pcm;
        int sampleRate = 22050;
        int channels = 1;

        MediaExtractor extractor = new MediaExtractor();
        MediaCodec codec = null;
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        try {
            extractor.setDataSource(mp3.getAbsolutePath());
            int track = -1;
            MediaFormat format = null;
            for (int i = 0; i < extractor.getTrackCount(); i++) {
                MediaFormat f = extractor.getTrackFormat(i);
                String mime = f.getString(MediaFormat.KEY_MIME);
                if (mime != null && mime.startsWith("audio/")) {
                    track = i;
                    format = f;
                    break;
                }
            }
            if (track < 0) throw new IllegalStateException("mp3 里没有音频轨道");
            extractor.selectTrack(track);

            String mime = format.getString(MediaFormat.KEY_MIME);
            sampleRate = format.getInteger(MediaFormat.KEY_SAMPLE_RATE);
            channels = format.getInteger(MediaFormat.KEY_CHANNEL_COUNT);

            codec = MediaCodec.createDecoderByType(mime);
            codec.configure(format, null, null, 0);
            codec.start();

            MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
            boolean inputDone = false;
            boolean outputDone = false;
            long deadline = System.currentTimeMillis() + 20000;  // 解码兜底超时，防止死等
            while (!outputDone && System.currentTimeMillis() < deadline) {
                if (!inputDone) {
                    int inIndex = codec.dequeueInputBuffer(10000);
                    if (inIndex >= 0) {
                        ByteBuffer buffer = codec.getInputBuffer(inIndex);
                        int size = buffer == null ? -1 : extractor.readSampleData(buffer, 0);
                        if (size < 0) {
                            codec.queueInputBuffer(inIndex, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM);
                            inputDone = true;
                        } else {
                            codec.queueInputBuffer(inIndex, 0, size, extractor.getSampleTime(), 0);
                            extractor.advance();
                        }
                    }
                }
                int outIndex = codec.dequeueOutputBuffer(info, 10000);
                if (outIndex >= 0) {
                    ByteBuffer buffer = codec.getOutputBuffer(outIndex);
                    if (buffer != null && info.size > 0) {
                        byte[] chunk = new byte[info.size];
                        buffer.position(info.offset);
                        buffer.get(chunk);
                        out.write(chunk);
                    }
                    codec.releaseOutputBuffer(outIndex, false);
                    if ((info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) outputDone = true;
                } else if (outIndex == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                    MediaFormat changed = codec.getOutputFormat();
                    if (changed.containsKey(MediaFormat.KEY_SAMPLE_RATE)) {
                        sampleRate = changed.getInteger(MediaFormat.KEY_SAMPLE_RATE);
                    }
                    if (changed.containsKey(MediaFormat.KEY_CHANNEL_COUNT)) {
                        channels = changed.getInteger(MediaFormat.KEY_CHANNEL_COUNT);
                    }
                } else if (outIndex == MediaCodec.INFO_TRY_AGAIN_LATER && inputDone) {
                    outputDone = true; // 防止死等
                }
            }
            pcm = out.toByteArray();
        } finally {
            if (codec != null) {
                try { codec.stop(); } catch (Throwable ignored) {}
                try { codec.release(); } catch (Throwable ignored) {}
            }
            extractor.release();
        }

        if (pcm.length < 2000) throw new IllegalStateException("解码结果只有 " + pcm.length + " 字节");

        int byteRate = sampleRate * channels * 2;
        ByteArrayOutputStream wav = new ByteArrayOutputStream(44 + pcm.length);
        wav.write("RIFF".getBytes());
        writeInt(wav, 36 + pcm.length);
        wav.write("WAVEfmt ".getBytes());
        writeInt(wav, 16);
        writeShort(wav, 1);
        writeShort(wav, channels);
        writeInt(wav, sampleRate);
        writeInt(wav, byteRate);
        writeShort(wav, channels * 2);
        writeShort(wav, 16);
        wav.write("data".getBytes());
        writeInt(wav, pcm.length);
        wav.write(pcm);

        return android.util.Base64.encodeToString(wav.toByteArray(), android.util.Base64.NO_WRAP);
    }

    /** 直接把媒体音量调到指定百分比（带系统音量条），用于「明明在播就是听不见」。 */
    public void setMediaVolume(int percent) {
        AudioManager audio = (AudioManager) context.getSystemService(Context.AUDIO_SERVICE);
        if (audio == null) return;
        int max = audio.getStreamMaxVolume(AudioManager.STREAM_MUSIC);
        int target = Math.max(1, Math.round(max * Math.min(100, Math.max(1, percent)) / 100f));
        try {
            audio.setStreamVolume(AudioManager.STREAM_MUSIC, target, AudioManager.FLAG_SHOW_UI);
            lastResult = "媒体音量已设为 " + target + " / " + max;
        } catch (Throwable e) {
            lastResult = "调音量失败：" + e.getMessage();
        }
    }

    /** 绕开 MediaPlayer，直接用 AudioTrack 写 PCM：判断是不是播放器/解码的问题。 */
    public void playPcmTone(final Callback callback) {
        AudioManager audio = (AudioManager) context.getSystemService(Context.AUDIO_SERVICE);
        if (audio != null) {
            try {
                audio.requestAudioFocus(null, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN);
            } catch (Throwable ignored) {
            }
        }
        AudioTrack track = null;
        try {
            int rate = 22050;
            int frames = rate * 2;
            short[] pcm = new short[frames];
            for (int i = 0; i < frames; i++) {
                double t = (double) i / rate;
                double fade = Math.min(1.0, Math.min(i / (rate * 0.05), (frames - i) / (rate * 0.15)));
                pcm[i] = (short) (Math.sin(2 * Math.PI * 660 * t) * 12000 * fade);
            }
            track = new AudioTrack.Builder()
                    .setAudioAttributes(new AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_MEDIA)
                            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                            .build())
                    .setAudioFormat(new AudioFormat.Builder()
                            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                            .setSampleRate(rate)
                            .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                            .build())
                    .setBufferSizeInBytes(pcm.length * 2)
                    .setTransferMode(AudioTrack.MODE_STATIC)
                    .build();
            int state = track.getState();
            if (state != AudioTrack.STATE_INITIALIZED) {
                lastResult = "AudioTrack 初始化失败 state=" + state;
                callback.onResult(false, lastResult);
                return;
            }
            track.write(pcm, 0, pcm.length);
            track.play();
            final AudioTrack playing = track;
            main.postDelayed(new Runnable() {
                @Override
                public void run() {
                    lastResult = "AudioTrack 直出 playState=" + playing.getPlayState();
                }
            }, 500);
            lastResult = "AudioTrack 直出已启动";
            callback.onResult(true, lastResult);
        } catch (Throwable e) {
            lastResult = "AudioTrack 失败：" + e.getMessage();
            callback.onResult(false, lastResult);
        }
    }

    /** 再用系统的 ToneGenerator 一声：这是第三条完全独立的播放路径。 */
    public void playSystemTone(final Callback callback) {
        try {
            final ToneGenerator tone = new ToneGenerator(AudioManager.STREAM_MUSIC, ToneGenerator.MAX_VOLUME);
            tone.startTone(ToneGenerator.TONE_PROP_BEEP2, 1200);
            main.postDelayed(new Runnable() {
                @Override
                public void run() {
                    try { tone.release(); } catch (Throwable ignored) {}
                }
            }, 2000);
            lastResult = "系统音效已触发";
            callback.onResult(true, lastResult);
        } catch (Throwable e) {
            lastResult = "系统音效失败：" + e.getMessage();
            callback.onResult(false, lastResult);
        }
    }

    private static String deviceName(int type) {
        switch (type) {
            case AudioDeviceInfo.TYPE_BUILTIN_EARPIECE: return "听筒";
            case AudioDeviceInfo.TYPE_BUILTIN_SPEAKER: return "扬声器";
            case AudioDeviceInfo.TYPE_WIRED_HEADSET: return "有线耳麦";
            case AudioDeviceInfo.TYPE_WIRED_HEADPHONES: return "有线耳机";
            case AudioDeviceInfo.TYPE_BLUETOOTH_A2DP: return "蓝牙A2DP";
            case AudioDeviceInfo.TYPE_BLUETOOTH_SCO: return "蓝牙SCO";
            case AudioDeviceInfo.TYPE_USB_DEVICE: return "USB音频";
            case AudioDeviceInfo.TYPE_USB_HEADSET: return "USB耳麦";
            case AudioDeviceInfo.TYPE_HEARING_AID: return "助听器";
            case AudioDeviceInfo.TYPE_BLE_HEADSET: return "BLE耳机";
            case AudioDeviceInfo.TYPE_BLE_SPEAKER: return "BLE音箱";
            default: return "设备(" + type + ")";
        }
    }

    public void speak(final String text, final Callback callback) {
        if (text == null || text.trim().isEmpty()) {
            callback.onResult(false, "没有要念的文字");
            return;
        }
        if (ttsReady) {
            try {
                int code = tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, "cdbus");
                if (code == TextToSpeech.SUCCESS) {
                    lastResult = "已交给系统 TTS";
                    callback.onResult(true, "系统 TTS");
                    return;
                }
                lastResult = "系统 TTS 调用失败（" + code + "），转在线合成";
                ttsReady = false;
            } catch (Throwable e) {
                lastResult = "系统 TTS 异常：" + e.getMessage() + "，转在线合成";
                ttsReady = false;
            }
        }

        io.execute(new Runnable() {
            @Override
            public void run() {
                try {
                    final File file = synthesize(text);
                    main.post(new Runnable() {
                        @Override
                        public void run() {
                            play(file, callback, "在线合成");
                        }
                    });
                } catch (final Exception e) {
                    Log.w(TAG, "合成失败", e);
                    lastResult = "在线合成失败：" + e.getMessage();
                    main.post(new Runnable() {
                        @Override
                        public void run() {
                            callback.onResult(false, lastResult);
                        }
                    });
                }
            }
        });
    }

    private File synthesize(String text) throws Exception {
        List<String> chunks = split(text);
        ByteArrayOutputStream all = new ByteArrayOutputStream();
        for (String chunk : chunks) {
            String url = TTS_URL + "?ie=UTF-8&client=tw-ob&tl=zh-CN&q=" + URLEncoder.encode(chunk, "UTF-8");
            HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setRequestMethod("GET");
            conn.setConnectTimeout(12000);
            conn.setReadTimeout(15000);
            conn.setRequestProperty("User-Agent",
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/132 Safari/537.36");
            conn.setRequestProperty("Referer", "https://translate.google.com/");
            int code = conn.getResponseCode();
            if (code != 200) throw new IllegalStateException("合成接口返回 HTTP " + code);
            try (InputStream in = conn.getInputStream()) {
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) > 0) all.write(buf, 0, n);
            }
            conn.disconnect();
        }
        byte[] bytes = all.toByteArray();
        if (bytes.length < 1000) {
            throw new IllegalStateException("合成结果只有 " + bytes.length + " 字节，不像有效音频");
        }
        File file = new File(context.getCacheDir(), "announce-" + System.currentTimeMillis() + ".mp3");
        try (FileOutputStream out = new FileOutputStream(file)) {
            out.write(bytes);
        }
        return file;
    }

    private static List<String> split(String text) {
        List<String> out = new ArrayList<>();
        StringBuilder buffer = new StringBuilder();
        for (String sentence : text.split("(?<=[。；！？,，])")) {
            if (sentence.isEmpty()) continue;
            if (buffer.length() + sentence.length() > CHUNK && buffer.length() > 0) {
                out.add(buffer.toString());
                buffer.setLength(0);
            }
            if (sentence.length() > CHUNK) {
                for (int i = 0; i < sentence.length(); i += CHUNK) {
                    out.add(sentence.substring(i, Math.min(sentence.length(), i + CHUNK)));
                }
            } else {
                buffer.append(sentence);
            }
        }
        if (buffer.length() > 0) out.add(buffer.toString());
        return out;
    }

    /** 生成 1.5 秒 660Hz 的 wav，用于「到底有没有声音」的判定。 */
    private File buildTone() throws Exception {
        int rate = 22050;
        int total = (int) (rate * 1.5);
        byte[] pcm = new byte[total * 2];
        for (int i = 0; i < total; i++) {
            double t = (double) i / rate;
            double fade = Math.min(1.0, Math.min(i / (rate * 0.05), (total - i) / (rate * 0.15)));
            short v = (short) (Math.sin(2 * Math.PI * 660 * t) * 12000 * fade);
            pcm[i * 2] = (byte) (v & 0xFF);
            pcm[i * 2 + 1] = (byte) ((v >> 8) & 0xFF);
        }
        File file = new File(context.getCacheDir(), "tone.wav");
        try (FileOutputStream out = new FileOutputStream(file)) {
            out.write("RIFF".getBytes());
            writeInt(out, 36 + pcm.length);
            out.write("WAVEfmt ".getBytes());
            writeInt(out, 16);
            writeShort(out, 1);
            writeShort(out, 1);
            writeInt(out, rate);
            writeInt(out, rate * 2);
            writeShort(out, 2);
            writeShort(out, 16);
            out.write("data".getBytes());
            writeInt(out, pcm.length);
            out.write(pcm);
        }
        return file;
    }

    private static void writeInt(java.io.OutputStream out, int value) throws Exception {
        out.write(value & 0xFF);
        out.write((value >> 8) & 0xFF);
        out.write((value >> 16) & 0xFF);
        out.write((value >> 24) & 0xFF);
    }

    private static void writeShort(java.io.OutputStream out, int value) throws Exception {
        out.write(value & 0xFF);
        out.write((value >> 8) & 0xFF);
    }

    private void play(File file, Callback callback, String source) {
        try {
            if (player != null) {
                try { player.release(); } catch (Exception ignored) {}
                player = null;
            }
            if (!file.exists() || file.length() < 1000) {
                lastResult = source + " 文件无效（" + file.length() + " 字节）";
                callback.onResult(false, lastResult);
                return;
            }
            player = new MediaPlayer();
            player.setAudioAttributes(new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build());
            player.setDataSource(file.getAbsolutePath());
            player.setOnCompletionListener(new MediaPlayer.OnCompletionListener() {
                @Override
                public void onCompletion(MediaPlayer mp) {
                    mp.release();
                    if (player == mp) player = null;
                }
            });
            player.setOnErrorListener(new MediaPlayer.OnErrorListener() {
                @Override
                public boolean onError(MediaPlayer mp, int what, int extra) {
                    lastResult = "播放器报错 what=" + what + " extra=" + extra;
                    try { mp.release(); } catch (Exception ignored) {}
                    if (player == mp) player = null;
                    return true;
                }
            });
            player.prepare();
            player.setVolume(1f, 1f);
            player.start();

            main.postDelayed(new Runnable() {
                @Override
                public void run() {
                    AudioManager audio = (AudioManager) context.getSystemService(Context.AUDIO_SERVICE);
                    int volume = audio == null ? -1 : audio.getStreamVolume(AudioManager.STREAM_MUSIC);
                    boolean playing = player != null && player.isPlaying();
                    int duration = -1;
                    try { duration = player == null ? -1 : player.getDuration(); } catch (Throwable ignored) {}
                    lastResult = source + " 已启动（音量 " + volume + "，playing=" + playing +
                            "，时长 " + duration + "ms）";
                    if (volume == 0) lastResult += " ⚠ 媒体音量为 0，请按音量键调大";
                }
            }, 600);

            lastResult = source + " 开始播放";
            callback.onResult(true, source);
        } catch (Exception e) {
            Log.w(TAG, "播放失败", e);
            lastResult = source + " 播放失败：" + e.getMessage();
            callback.onResult(false, lastResult);
        }
    }

    public void shutdown() {
        if (tts != null) tts.shutdown();
        if (player != null) {
            try { player.release(); } catch (Exception ignored) {}
            player = null;
        }
        io.shutdownNow();
    }
}