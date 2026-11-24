package com.chengdu.bus;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 下车提醒前台服务：持续拿手机定位，算出离终点站还剩几站。
 * 到站前两站播一次、到站再播一次；界面可见时交给页面播，避免同一句念两遍。
 *
 * 为什么必须放原生：WebView 的定位和定时器在后台会被系统挂起。
 */
public final class AlightService extends Service implements LocationListener {

    private static final String TAG = "CdBusAlight";
    private static final String CHANNEL_ID = "cdbus_alight";
    private static final String CHANNEL_NAME = "下车提醒";
    private static final int NOTIFICATION_ID = 1002;
    private static final String PREFS = "cdbus_alight";
    private static final long TICK_MS = 15000;
    /** 离终点站这么近就算「到站」。 */
    private static final float ARRIVE_METERS = 250f;

    public static final String ACTION_START = "com.chengdu.bus.ALIGHT_START";
    public static final String ACTION_STOP = "com.chengdu.bus.ALIGHT_STOP";

    /** 服务是否在跑，以及给页面轮询用的状态 JSON。 */
    private static volatile boolean RUNNING = false;
    private static volatile String STATUS = "{\"running\":false}";

    private final Handler handler = new Handler(Looper.getMainLooper());
    private WakeKeeper wake;
    private Speech speech;
    private LocationManager locator;

    private String lineName = "";
    private String toward = "";
    private String destName = "";
    private int destOrder = 1;
    private double destLat = 0;
    private double destLng = 0;
    private JSONArray stations = new JSONArray();

    private boolean spokeTwo = false;
    private boolean spokeArrive = false;
    private boolean autoCancelScheduled = false;
    private int event = 0;
    private String eventText = "";
    private double lastDistance = -1;
    private int lastRemaining = -1;
    private long lastFixAt = 0;
    private String lastMessage = "正在获取定位…";
    private boolean listening = false;

    private final Runnable ticker = new Runnable() {
        @Override
        public void run() {
            if (wake != null) wake.acquire();   // 息屏保活：每轮续期
            if (!spokeArrive && lastFixAt > 0
                    && System.currentTimeMillis() - lastFixAt > 120000) {
                lastMessage = "定位信号弱，正在重试…";
            }
            publishStatus();
            updateNotification(lastMessage);
            handler.postDelayed(this, TICK_MS);
        }
    };

    public static String statusJson() {
        if (!RUNNING) return "{\"running\":false}";
        return STATUS;
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
            // 手动取消：持久化数据一并清掉，页面别再恢复出一条旧提醒
            getSharedPreferences(PREFS, MODE_PRIVATE).edit().clear().apply();
            stopSelf();
            return START_NOT_STICKY;
        }
        if (intent == null || intent.getStringExtra("destName") == null) {
            loadTarget();
        } else {
            lineName = safe(intent.getStringExtra("lineName"));
            toward = safe(intent.getStringExtra("toward"));
            destName = safe(intent.getStringExtra("destName"));
            destOrder = intent.getIntExtra("destOrder", 1);
            destLat = intent.getDoubleExtra("destLat", 0);
            destLng = intent.getDoubleExtra("destLng", 0);
            stations = parseStations(intent.getStringExtra("stations"));
            saveTarget();
        }

        spokeTwo = false;
        spokeArrive = false;
        autoCancelScheduled = false;   // 新一轮提醒：取消之前调度过的自动收尾
        event = 0;
        eventText = "";
        lastDistance = -1;
        lastRemaining = -1;
        lastFixAt = 0;
        lastMessage = "前往 " + destName + "，正在获取定位…";

        startForeground(NOTIFICATION_ID, buildNotification(lastMessage));
        if (wake != null) wake.acquire();   // 息屏后定位回调与 tick 都靠它保活
        startListening();
        handler.removeCallbacks(ticker);
        handler.post(ticker);
        RUNNING = true;
        publishStatus();
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacks(ticker);
        stopListening();
        RUNNING = false;
        STATUS = "{\"running\":false}";
        if (wake != null) wake.release();
        if (speech != null) speech.shutdown();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    /* ------------------------------------------------------- 定位 */

    private void startListening() {
        if (listening) return;
        if (Build.VERSION.SDK_INT >= 23) {
            if (checkSelfPermission(android.Manifest.permission.ACCESS_FINE_LOCATION)
                    != PackageManager.PERMISSION_GRANTED
                    && checkSelfPermission(android.Manifest.permission.ACCESS_COARSE_LOCATION)
                    != PackageManager.PERMISSION_GRANTED) {
                lastMessage = "没有定位权限，无法提醒";
                updateNotification(lastMessage);
                return;
            }
        }
        locator = (LocationManager) getSystemService(LOCATION_SERVICE);
        if (locator == null) {
            lastMessage = "定位服务不可用";
            updateNotification(lastMessage);
            return;
        }
        try {
            Location last = locator.getLastKnownLocation(LocationManager.GPS_PROVIDER);
            Location net = locator.getLastKnownLocation(LocationManager.NETWORK_PROVIDER);
            if (net != null && (last == null || net.getTime() > last.getTime())) last = net;
            if (last != null) handle(last);
        } catch (Exception e) {
            Log.w(TAG, "读最后位置失败", e);
        }
        String[] providers = new String[]{LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER};
        for (String provider : providers) {
            try {
                if (locator.isProviderEnabled(provider)) {
                    locator.requestLocationUpdates(provider, 5000L, 10f, this, Looper.getMainLooper());
                    listening = true;
                }
            } catch (Exception e) {
                Log.w(TAG, "订阅 " + provider + " 失败", e);
            }
        }
        if (!listening) {
            lastMessage = "定位已关闭，请在系统设置里打开";
            updateNotification(lastMessage);
        }
    }

    private void stopListening() {
        if (!listening || locator == null) return;
        try {
            locator.removeUpdates(this);
        } catch (Exception e) {
            Log.w(TAG, "取消定位订阅失败", e);
        }
        listening = false;
    }

    @Override
    public void onLocationChanged(Location location) {
        if (location != null) handle(location);
    }

    @Override
    public void onStatusChanged(String provider, int status, Bundle extras) {
    }

    @Override
    public void onProviderEnabled(String provider) {
    }

    @Override
    public void onProviderDisabled(String provider) {
    }

    /* ------------------------------------------------------- 判定 */

    private void handle(Location location) {
        lastFixAt = System.currentTimeMillis();
        double lat = location.getLatitude();
        double lng = location.getLongitude();

        double toDest = distance(lat, lng, destLat, destLng);
        lastDistance = toDest;

        int nearestOrder = -1;
        double nearest = Double.MAX_VALUE;
        for (int i = 0; i < stations.length(); i++) {
            JSONObject station = stations.optJSONObject(i);
            if (station == null) continue;
            double d = distance(lat, lng, station.optDouble("lat", 0), station.optDouble("lng", 0));
            if (d < 0) continue;                      // 没有坐标的站点跳过
            if (d < nearest) {
                nearest = d;
                nearestOrder = station.optInt("order", -1);
            }
        }

        int remaining;
        if (nearestOrder > 0) {
            remaining = destOrder - nearestOrder;
            if (remaining < 0) remaining = 0;
        } else {
            remaining = (toDest > 0 && toDest <= ARRIVE_METERS) ? 0 : -1;
        }
        lastRemaining = remaining;

        boolean hasDest = toDest > 0;
        if (remaining > 0) {
            lastMessage = "离 " + destName + " 还有 " + remaining + " 站";
            if (hasDest) lastMessage += " · " + Math.round(toDest) + " 米";
        } else if (remaining == 0) {
            lastMessage = "已到 " + destName;
        } else if (hasDest) {
            lastMessage = "离 " + destName + " 约 " + Math.round(toDest) + " 米";
        } else {
            lastMessage = "正在定位…";
        }

        if (!spokeTwo && remaining > 0 && remaining <= 2) {
            spokeTwo = true;
            fire(remaining >= 2 ? "还有两站就下车，请提前准备" : "下一站就下车，请提前准备");
        }
        if (!spokeArrive && (remaining == 0 || (hasDest && toDest <= ARRIVE_METERS))) {
            if (!spokeTwo) {
                spokeTwo = true;
            }
            spokeArrive = true;
            fire("到站了，请下车");
        }
        if (spokeArrive) {
            // 已经到站：播完「到站了，请下车」就收尾。
            // 保留一个很短的宽限期（3 秒）让这句语音完整播出去，
            // 之后清存储、停服务、通知消失 —— 页面那边到站时也会立刻自己收尾。
            if (listening) stopListening();
            handler.removeCallbacks(ticker);
            lastMessage = "已到 " + destName + "，提醒结束";
            updateNotification(lastMessage);
            publishStatus();
            finishAndAutoCancel(3 * 1000);
            return;
        }

        updateNotification(lastMessage);
        publishStatus();
    }

    /**
     * 到站后的自动收尾：延迟几秒（让「已到站」的语音和通知被看到），
     * 然后清掉本地存储、停掉前台服务 —— 页面下次 alightPoll 会拿到
     * running=false，提醒条和首页卡片随之消失，不用用户手动点取消。
     */
    private void finishAndAutoCancel(long delayMs) {
        if (autoCancelScheduled) return;   // 防止重复调度
        autoCancelScheduled = true;
        Log.i(TAG, "到站收尾：" + delayMs + "ms 后自动取消提醒");
        handler.postDelayed(new Runnable() {
            @Override
            public void run() {
                // 1) 清掉持久化数据，页面下次恢复时不会再弹旧提醒
                getSharedPreferences(PREFS, MODE_PRIVATE).edit().clear().apply();
                // 2) 停前台服务（通知随之消失）
                RUNNING = false;
                STATUS = "{\"running\":false}";
                stopForeground(true);
                stopSelf();
                Log.i(TAG, "下车提醒已自动结束");
            }
        }, delayMs);
    }

    private void fire(String what) {
        event += 1;
        eventText = what;
        announce(what);
    }

    private void announce(String what) {
        /* 分工同盯站：亮屏前台由页面播（页面轮询在跑），后台/息屏由服务播。
           两者条件互斥，不会重复也不会都没声。 */
        if (MainActivity.frontAndScreenOn(this)) {
            Log.i(TAG, "亮屏前台，由页面播报（服务跳过避免重复）");
            return;
        }
        String text = what + "。" + destName + "站。";
        if (!lineName.isEmpty()) text = lineName + "路，" + text;
        Log.i(TAG, "下车提醒播报：" + text + "（界面可见=" + MainActivity.VISIBLE + "）");
        /* 锁屏通知（v1.0.44）：和盯站一样，后台/息屏时把这条提醒显示在锁屏上。 */
        Notify.post(this, (lineName.isEmpty() ? "" : lineName + "路 · ") + "下车提醒",
                what + "（" + destName + "站）");
        if (speech != null) {
            speech.speak(text, new Speech.Callback() {
                @Override
                public void onResult(boolean spoken, String detail) {
                    Log.i(TAG, "播报结果：" + spoken + " " + detail);
                }
            });
        }
    }

    private void publishStatus() {
        JSONObject out = new JSONObject();
        try {
            out.put("running", RUNNING);
            out.put("destName", destName);
            out.put("lineName", lineName);
            out.put("toward", toward);
            out.put("remaining", lastRemaining);
            out.put("distance", lastDistance < 0 ? JSONObject.NULL : Math.round(lastDistance));
            out.put("arrived", spokeArrive);
            out.put("event", event);
            out.put("eventText", eventText);
            out.put("message", lastMessage);
            out.put("fresh", lastFixAt > 0 && System.currentTimeMillis() - lastFixAt < 120000);
        } catch (Exception e) {
            Log.w(TAG, "状态序列化失败", e);
        }
        STATUS = out.toString();
    }

    private static double distance(double lat1, double lng1, double lat2, double lng2) {
        if (lat2 == 0 && lng2 == 0) return -1;
        float[] result = new float[1];
        Location.distanceBetween(lat1, lng1, lat2, lng2, result);
        return result[0];
    }

    /* ------------------------------------------------------- 持久化 */

    private static String safe(String value) {
        return value == null ? "" : value;
    }

    private JSONArray parseStations(String raw) {
        try {
            return raw == null || raw.isEmpty() ? new JSONArray() : new JSONArray(raw);
        } catch (Exception e) {
            return new JSONArray();
        }
    }

    private void saveTarget() {
        getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                .putString("lineName", lineName)
                .putString("toward", toward)
                .putString("destName", destName)
                .putInt("destOrder", destOrder)
                .putFloat("destLat", (float) destLat)
                .putFloat("destLng", (float) destLng)
                .putString("stations", stations.toString())
                .apply();
    }

    private void loadTarget() {
        SharedPreferences p = getSharedPreferences(PREFS, MODE_PRIVATE);
        lineName = p.getString("lineName", "");
        toward = p.getString("toward", "");
        destName = p.getString("destName", "");
        destOrder = p.getInt("destOrder", 1);
        destLat = p.getFloat("destLat", 0);
        destLng = p.getFloat("destLng", 0);
        stations = parseStations(p.getString("stations", "[]"));
    }

    /* ------------------------------------------------------- 通知 */

    private void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (manager == null) return;
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID, CHANNEL_NAME, NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("下车提醒时在后台持续定位并播报");
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
                .setContentTitle("下车提醒 · " + destName)
                .setContentText(text)
                .setSmallIcon(android.R.drawable.ic_menu_mylocation)
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
