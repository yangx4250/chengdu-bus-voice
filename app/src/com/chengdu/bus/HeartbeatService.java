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

import org.json.JSONObject;

/**
 * 后台心跳测试服务：每 30 秒播报一次「第 N 次心跳」。
 *
 * 用途是**诊断**，不是功能：用它判断锁屏/后台时到底还响不响。
 * 它走的是和真实盯站播报完全相同的路径 ——
 * 前台服务 + PARTIAL_WAKE_LOCK + Speech（系统 TTS / 在线合成）。
 *
 * 如果锁屏后这个也停，说明是系统把后台清了（去加电池优化白名单）；
 * 如果这个一直在报但真实盯站不报，说明问题在盯站逻辑而不是保活。
 */
public final class HeartbeatService extends Service {

    private static final String TAG = "CdBusHeartbeat";
    private static final String CHANNEL_ID = "cdbus_heartbeat";
    private static final String CHANNEL_NAME = "后台心跳测试";
    private static final int NOTIFICATION_ID = 1003;
    private static final long INTERVAL_MS = 30000;

    public static final String ACTION_START = "com.chengdu.bus.HEARTBEAT_START";
    public static final String ACTION_STOP = "com.chengdu.bus.HEARTBEAT_STOP";

    private static volatile boolean RUNNING = false;
    private static volatile int COUNT = 0;
    private static volatile long LAST_AT = 0;
    private static volatile String LAST_TEXT = "";
    private static volatile String LAST_RESULT = "";

    private final Handler handler = new Handler(Looper.getMainLooper());
    private WakeKeeper wake;
    private Speech speech;

    private final Runnable ticker = new Runnable() {
        @Override
        public void run() {
            if (wake != null) wake.acquire();   // 每轮续期，息屏也不冻结
            try {
                beat();
            } catch (Throwable e) {
                Log.w(TAG, "心跳异常", e);
            }
            handler.postDelayed(this, INTERVAL_MS);
        }
    };

    /** 给页面自检面板用。 */
    static String statusJson() {
        JSONObject out = new JSONObject();
        try {
            out.put("running", RUNNING);
            out.put("count", COUNT);
            out.put("lastAt", LAST_AT);
            out.put("lastText", LAST_TEXT);
            out.put("lastResult", LAST_RESULT);
        } catch (Exception ignored) {
        }
        return out.toString();
    }

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
        COUNT = 0;
        LAST_AT = 0;
        LAST_TEXT = "";
        LAST_RESULT = "";
        RUNNING = true;

        startForeground(NOTIFICATION_ID, buildNotification("心跳准备中…"));
        if (wake != null) wake.acquire();
        handler.removeCallbacks(ticker);
        handler.post(ticker);
        Log.i(TAG, "心跳服务已启动");
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacks(ticker);
        RUNNING = false;
        if (wake != null) wake.release();
        if (speech != null) speech.shutdown();
        Log.i(TAG, "心跳服务已停止");
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void beat() {
        COUNT += 1;
        LAST_AT = System.currentTimeMillis();
        final String text = "后台心跳第 " + COUNT + " 次";
        LAST_TEXT = text;
        Log.i(TAG, "心跳：" + text + "（界面可见=" + MainActivity.VISIBLE + "）");
        updateNotification(text + " · " + clockText());

        if (speech == null) return;
        speech.speak(text, new Speech.Callback() {
            @Override
            public void onResult(boolean spoken, String detail) {
                LAST_RESULT = (spoken ? "✅ " : "❌ ") + detail;
                Log.i(TAG, "心跳播报结果：" + LAST_RESULT);
            }
        });
    }

    private String clockText() {
        java.text.SimpleDateFormat fmt =
                new java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.CHINA);
        return fmt.format(new java.util.Date());
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (manager == null) return;
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID, CHANNEL_NAME, NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("每 30 秒播报一次，用来检测后台/锁屏播报");
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
                .setContentTitle("后台心跳测试")
                .setContentText(text)
                .setSmallIcon(android.R.drawable.ic_menu_compass)
                .setOngoing(true)
                .setContentIntent(pending)
                .setOnlyAlertOnce(true)
                .build();
    }

    private void updateNotification(String text) {
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (manager == null) return;
        manager.notify(NOTIFICATION_ID, buildNotification(text));
    }
}
