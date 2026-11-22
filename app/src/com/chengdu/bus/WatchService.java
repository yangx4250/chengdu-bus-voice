package com.chengdu.bus;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 盯站前台服务：App 退到后台后继续每 30 秒查一次，按 10 分钟 / 5 分钟 / 2 站三个节点各播一次。
 *
 * 为什么必须放原生：WebView 的 JS 定时器在后台会被系统挂起，靠 JS 是盯不住的。
 */
public final class WatchService extends Service {

    private static final String TAG = "CdBusWatch";
    private static final String CHANNEL_ID = "cdbus_watch";
    private static final String CHANNEL_NAME = "公交盯站";
    private static final int NOTIFICATION_ID = 1001;
    private static final long INTERVAL_MS = 30000;

    public static final String ACTION_START = "com.chengdu.bus.WATCH_START";
    public static final String ACTION_STOP = "com.chengdu.bus.WATCH_STOP";

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ChelaileClient client = new ChelaileClient();
    private WakeKeeper wake;
    private Speech speech;

    private String lineId = "";
    private String lineName = "";
    private String stationId = "";
    private String stationName = "";
    private String toward = "";
    private int order = 1;
    private double lat = 0;
    private double lng = 0;

    private String currentBusId = "";
    private boolean spoke10m = false;
    private boolean spoke5m = false;
    private boolean spoke2s = false;
    private boolean spokeArrived = false;
    private String lastMessage = "准备开始盯站…";

    /* 给「后台播报自检」面板用的运行状态 */
    private static volatile boolean RUNNING = false;
    private static volatile String LAST_SPEAK = "还没播过";
    private static volatile long LAST_TICK_AT = 0;
    private static volatile long LAST_SPEAK_AT = 0;
    private static volatile boolean WAKE_HELD = false;
    /** 诊断模式：每次轮询都出声，用来确认服务到底有没有在跑。 */
    private static volatile boolean DIAG_SPEAK = false;
    private static volatile int diagCount = 0;

    /** 切换诊断模式（每轮轮询都出声）。 */
    static boolean toggleDiag() {
        DIAG_SPEAK = !DIAG_SPEAK;
        diagCount = 0;
        return DIAG_SPEAK;
    }

    /** 服务运行状态 JSON，供页面自检面板显示。 */
    static String statusJson() {
        JSONObject out = new JSONObject();
        try {
            out.put("running", RUNNING);
            out.put("lastMessage", LAST_SPEAK);
            out.put("lastTickAt", LAST_TICK_AT);
            out.put("lastSpeakAt", LAST_SPEAK_AT);
            out.put("wakeHeld", WAKE_HELD);
            out.put("diag", DIAG_SPEAK);
        } catch (Exception ignored) {
        }
        return out.toString();
    }

    private final Runnable ticker = new Runnable() {
        @Override
        public void run() {
            /* 每轮续一次唤醒锁，保证下一轮 tick 之前 CPU 不会睡 */
            if (wake != null) { wake.acquire(); WAKE_HELD = wake.held(); }
            LAST_TICK_AT = System.currentTimeMillis();
            try {
                poll();
            } catch (Throwable e) {
                Log.w(TAG, "tick 异常（继续跑）", e);
            }
            /* 诊断模式：每轮都念一句，用来区分「服务没跑」和「服务跑了但没触发播报」 */
            if (DIAG_SPEAK && speech != null) {
                speech.speak("盯站服务第 " + (++diagCount) + " 次轮询", new Speech.Callback() {
                    @Override
                    public void onResult(boolean spoken, String detail) {
                        LAST_SPEAK = (spoken ? "✅ " : "❌ ") + detail;
                    }
                });
            }
            handler.postDelayed(this, INTERVAL_MS);
        }
    };

    @Override
    public void onCreate() {
        super.onCreate();
        speech = new Speech(this);
        wake = new WakeKeeper(this);
        createChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopSelf();
            return START_NOT_STICKY;
        }
        if (intent == null || intent.getStringExtra("lineId") == null) {
            // 服务被系统重启时 Intent 可能是空的：从 SharedPreferences 恢复
            loadTarget();
        } else {
            lineId = intent.getStringExtra("lineId");
            lineName = intent.getStringExtra("lineName");
            stationId = intent.getStringExtra("stationId");
            stationName = intent.getStringExtra("stationName");
            toward = intent.getStringExtra("toward");
            order = intent.getIntExtra("order", 1);
            lat = intent.getDoubleExtra("lat", 0);
            lng = intent.getDoubleExtra("lng", 0);
            if (lineId == null) lineId = "";
            if (lineName == null) lineName = "";
            if (stationId == null) stationId = "";
            if (stationName == null) stationName = "";
            if (toward == null) toward = "";
            saveTarget();
        }

        currentBusId = "";
        spoke10m = false;
        spoke5m = false;
        spoke2s = false;
        spokeArrived = false;
        lastMessage = lineName + "路 · " + stationName + " · 盯站中";

        startForeground(NOTIFICATION_ID, buildNotification(lastMessage));
        /* 息屏后 CPU 休眠会冻结 Handler 定时器 → 拿唤醒锁保活 */
        if (wake != null) { wake.acquire(); WAKE_HELD = wake.held(); }
        RUNNING = true;
        handler.removeCallbacks(ticker);
        handler.post(ticker);
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacks(ticker);
        RUNNING = false;
        WAKE_HELD = false;
        if (wake != null) wake.release();
        if (speech != null) speech.shutdown();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void saveTarget() {
        getSharedPreferences("cdbus_watch", MODE_PRIVATE).edit()
                .putString("lineId", lineId)
                .putString("lineName", lineName)
                .putString("stationId", stationId)
                .putString("stationName", stationName)
                .putString("toward", toward)
                .putInt("order", order)
                .putFloat("lat", (float) lat)
                .putFloat("lng", (float) lng)
                .apply();
    }

    private void loadTarget() {
        android.content.SharedPreferences p = getSharedPreferences("cdbus_watch", MODE_PRIVATE);
        lineId = p.getString("lineId", "");
        lineName = p.getString("lineName", "");
        stationId = p.getString("stationId", "");
        stationName = p.getString("stationName", "");
        toward = p.getString("toward", "");
        order = p.getInt("order", 1);
        lat = p.getFloat("lat", 0);
        lng = p.getFloat("lng", 0);
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (manager == null) return;
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID, CHANNEL_NAME, NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("盯站时在后台刷新到站并播报");
        channel.enableVibration(false);
        channel.setSound(null, null);
        manager.createNotificationChannel(channel);
    }

    private Notification buildNotification(String text) {
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent pending = PendingIntent.getActivity(this, 0, open, flags);

        Notification.Builder builder;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            builder = new Notification.Builder(this, CHANNEL_ID);
        } else {
            builder = new Notification.Builder(this);
        }
        return builder
                .setContentTitle(lineName + "路 · " + stationName)
                .setContentText(text)
                .setSmallIcon(android.R.drawable.ic_menu_directions)   // 用系统图标，避免依赖生成的 R
                .setOngoing(true)
                .setContentIntent(pending)
                .setOnlyAlertOnce(true)
                .build();
    }

    private void updateNotification(String text) {
        lastMessage = text;
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (manager == null) return;
        manager.notify(NOTIFICATION_ID, buildNotification(text));
    }

    private void poll() {
        LAST_TICK_AT = System.currentTimeMillis();
        /* 参数不全时把原因写进通知，而不是静默 return —— 否则界面看起来「在盯站」，
           实际上一次都没查过，用户完全无从判断。 */
        if (lineId.isEmpty() || stationId.isEmpty()) {
            updateNotification("⚠ 盯站参数缺失（线路=" + (lineId.isEmpty() ? "空" : "有")
                    + " 站点=" + (stationId.isEmpty() ? "空" : "有") + "），请重新点 📌");
            Log.w(TAG, "poll 参数缺失：lineId=" + lineId + " stationId=" + stationId);
            return;
        }
        JSONObject station = new JSONObject();
        try {
            station.put("stationId", stationId);
            station.put("order", order);
            station.put("name", stationName);
            station.put("lat", lat);
            station.put("lng", lng);
        } catch (Exception e) {
            updateNotification("⚠ 构造查询参数失败：" + e.getMessage());
            return;
        }

        try {
            JSONArray buses = client.arrivals(lineId, station);
            if (buses.length() == 0) {
                updateNotification("当前没有在途车辆");
                return;
            }
            JSONObject bus = buses.getJSONObject(0);
            String busId = bus.optString("busId", "");
            if (!busId.equals(currentBusId)) {
                currentBusId = busId;
                spoke10m = false;
                spoke5m = false;
                spoke2s = false;
                spokeArrived = false;
            }

            int away = bus.optInt("stationsAway", -1);
            int eta = bus.isNull("etaSeconds") ? -1 : bus.optInt("etaSeconds", -1);
            String detail = away >= 0 ? ("还有 " + away + " 站") : "";
            if (eta > 0) {
                detail += (detail.isEmpty() ? "" : "，") + Math.max(1, Math.round(eta / 60f)) + " 分钟";
            }
            updateNotification(detail.isEmpty() ? "等待车辆" : detail);

            /* 播报规则（v9.26 重置）：**只有四个节点，各播一次，绝不重复**
                 ① 10 分钟：0 < eta <= 600
                 ② 5 分钟 ：0 < eta <= 300
                 ③ 2 站   ：0 < away <= 2
                 ④ 已到站 ：away == 0 或 eta == 0
               注意 ③ 用 away > 0（不含 0），避免和 ④ 连播两句「马上进站」+「已到站」。
               阈值只决定「什么时候播」，文案用实际 ETA。 */
            boolean arrivedNow = (away == 0) || (eta == 0);

            if (arrivedNow) {
                /* 到站优先：一旦到站就只播「已到站」，不再补播前面的节点 */
                if (!spokeArrived) {
                    spokeArrived = true;
                    spoke10m = true;   // 标记为已播，防止后续 tick 再补
                    spoke5m = true;
                    spoke2s = true;
                    updateNotification(stationName + " · 已到站");
                    announce("已到站");
                }
            } else {
                if (eta > 0 && eta <= 600 && !spoke10m) {
                    spoke10m = true;
                    announce(etaWords(eta));
                }
                if (eta > 0 && eta <= 300 && !spoke5m) {
                    spoke5m = true;
                    announce(etaWords(eta));
                }
                if (away > 0 && away <= 2 && !spoke2s) {
                    spoke2s = true;
                    announce("还有 " + away + " 站到站");
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "盯站刷新失败", e);
            updateNotification("⚠ 查询失败：" + (e.getMessage() == null ? e.toString() : e.getMessage()));
            LAST_SPEAK = "查询失败：" + (e.getMessage() == null ? e.toString() : e.getMessage());
        }
    }

    /** 把秒数说成中文：「大约 6 分 30 秒」/「大约 10 分钟」/「30 秒内」。 */
    private static String etaWords(int seconds) {
        if (seconds <= 0) return "即将到站";
        int half = Math.round(seconds / 30f);
        if (half <= 1) return "30 秒内到站";
        int m = half / 2;
        int r = half % 2;
        return "大约 " + (r == 1 ? m + " 分 30 秒" : m + " 分钟") + "到站";
    }

    private void announce(String what) {
        /* 分工：**页面负责前台播报**（页面定时器只在亮屏前台跑），
           服务负责**后台/息屏**播报。用 isInteractive() 判断屏幕，
           而不是只看 VISIBLE —— 息屏时 Activity 仍 resumed，VISIBLE 恒为 true。
           之前用 frontAndScreenOn（要求亮屏）导致息屏时服务也不播，
           而页面又因 document.hidden 不播 → 死结。现在：
             亮屏前台 → 页面播（服务跳过，避免重复）
             息屏/后台 → 服务播（页面定时器不跑）
           两者条件互斥，任何时刻只有一方播。 */
        if (MainActivity.frontAndScreenOn(this)) {
            Log.i(TAG, "亮屏前台，由页面播报（服务跳过避免重复）");
            return;
        }
        String text = lineName + "路，" + stationName + "站，" + what + "。";
        Log.i(TAG, "后台/息屏播报：" + text);
        LAST_SPEAK = text;
        LAST_SPEAK_AT = System.currentTimeMillis();
        if (speech != null) {
            speech.speak(text, new Speech.Callback() {
                @Override
                public void onResult(boolean spoken, String detail) {
                    Log.i(TAG, "播报结果：" + spoken + " " + detail);
                    LAST_SPEAK = (spoken ? "✅ " : "❌ ") + detail;
                }
            });
        }
    }
}