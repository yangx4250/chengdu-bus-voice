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
    private String lastMessage = "准备开始盯站…";

    private final Runnable ticker = new Runnable() {
        @Override
        public void run() {
            poll();
            handler.postDelayed(this, INTERVAL_MS);
        }
    };

    @Override
    public void onCreate() {
        super.onCreate();
        speech = new Speech(this);
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
        lastMessage = lineName + "路 · " + stationName + " · 盯站中";

        startForeground(NOTIFICATION_ID, buildNotification(lastMessage));
        handler.removeCallbacks(ticker);
        handler.post(ticker);
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacks(ticker);
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
        if (lineId.isEmpty() || stationId.isEmpty()) return;
        JSONObject station = new JSONObject();
        try {
            station.put("stationId", stationId);
            station.put("order", order);
            station.put("name", stationName);
            station.put("lat", lat);
            station.put("lng", lng);
        } catch (Exception e) {
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
            }

            int away = bus.optInt("stationsAway", -1);
            int eta = bus.isNull("etaSeconds") ? -1 : bus.optInt("etaSeconds", -1);
            String detail = away >= 0 ? ("还有 " + away + " 站") : "";
            if (eta > 0) {
                detail += (detail.isEmpty() ? "" : "，") + Math.max(1, Math.round(eta / 60f)) + " 分钟";
            }
            updateNotification(detail.isEmpty() ? "等待车辆" : detail);

            // 三个节点各播一次
            if (eta > 0 && eta <= 600 && !spoke10m) {
                spoke10m = true;
                announce("大约 10 分钟到站");
            }
            if (eta > 0 && eta <= 300 && !spoke5m) {
                spoke5m = true;
                announce("大约 5 分钟到站");
            }
            if (away >= 0 && away <= 2 && !spoke2s) {
                spoke2s = true;
                announce(away <= 0 ? "马上就要进站" : "还有 2 站到站");
            }
        } catch (Exception e) {
            Log.w(TAG, "盯站刷新失败", e);
        }
    }

    private void announce(String what) {
        String text = lineName + "路，" + stationName + "站，" + what + "。";
        Log.i(TAG, "播报：" + text);
        if (speech != null) {
            speech.speak(text, new Speech.Callback() {
                @Override
                public void onResult(boolean spoken, String detail) {
                    Log.i(TAG, "播报结果：" + spoken + " " + detail);
                }
            });
        }
    }
}