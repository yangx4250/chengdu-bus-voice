package com.chengdu.bus;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.pm.PackageManager;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Bundle;
import android.os.Looper;
import android.util.Log;

import org.json.JSONObject;

import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * 取一次「当前」位置。
 *
 * 精度优先，而不是「快」优先。旧实现有三个会让人明显感觉「定位不准」的问题：
 *
 *   1. 只要 2 分钟内的 lastKnown 就直接用，根本不看精度 —— 城市里 NETWORK 的
 *      lastKnown 偏差几百米很常见，于是你明明在 A 站，App 认成 B 站。
 *   2. lastKnown 取的是「时间最新」的那条，而不是「最准」的那条。
 *   3. 精度门槛 50 米就提前收工，GPS 还没来得及收敛。
 *
 * 现在的顺序：
 *   1. 30 秒内、精度 ≤ 50 米的 lastKnown → 直接用（秒回，且确实准）；
 *   2. 否则同时向 GPS / NETWORK 请求实时定位，最多等 timeoutMs：
 *      拿到 ≤ 30 米就立刻用；到时间就取这段时间里精度最好的那条；
 *   3. 实时没拿到，退回 lastKnown 里最准的那条（标记 stale）。
 */
public final class Locator {

    private static final String TAG = "CdBusLocator";

    /** lastKnown 只有这么新、这么准才允许直接返回 */
    private static final long TRUST_AGE_MS = 30 * 1000;
    private static final float TRUST_ACCURACY = 50f;

    /** 实时定位拿到这个精度就收工 */
    private static final float GOOD_ACCURACY = 30f;

    /** 精度未知时的惩罚值（当作很差） */
    private static final float UNKNOWN_ACCURACY = 5000f;

    public static final class Fix {
        public double lat;
        public double lng;
        public float accuracy;
        public String provider;
        public boolean stale;
        public long ageMs;
    }

    private Locator() {}

    public static boolean hasPermission(Context context) {
        return context.checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION)
                == PackageManager.PERMISSION_GRANTED
                || context.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION)
                == PackageManager.PERMISSION_GRANTED;
    }

    public static Fix current(Activity activity, long timeoutMs) throws Exception {
        LocationManager manager = (LocationManager) activity.getSystemService(Context.LOCATION_SERVICE);
        if (manager == null) throw new IllegalStateException("系统没有定位服务");
        if (!hasPermission(activity)) throw new SecurityException("没有定位权限");

        boolean gpsEnabled = manager.isProviderEnabled(LocationManager.GPS_PROVIDER);
        boolean netEnabled = manager.isProviderEnabled(LocationManager.NETWORK_PROVIDER);
        if (!gpsEnabled && !netEnabled) throw new IllegalStateException("系统定位开关是关闭的");

        Location lastKnown = bestLastKnown(manager);
        long age = lastKnown == null ? Long.MAX_VALUE
                : System.currentTimeMillis() - lastKnown.getTime();
        /* 又新又准才敢直接信它；否则宁可多等几秒去拿一个真的 */
        if (lastKnown != null && age < TRUST_AGE_MS
                && accuracyOf(lastKnown) <= TRUST_ACCURACY) {
            return toFix(lastKnown, false);
        }

        final Location[] best = new Location[1];
        final CountDownLatch latch = new CountDownLatch(1);
        LocationListener listener = new LocationListener() {
            @Override
            public void onLocationChanged(Location location) {
                if (best[0] == null || accuracyOf(location) < accuracyOf(best[0])) {
                    best[0] = location;
                }
                if (accuracyOf(location) <= GOOD_ACCURACY) latch.countDown();
            }

            @Override
            public void onStatusChanged(String provider, int status, Bundle extras) {}

            @Override
            public void onProviderEnabled(String provider) {}

            @Override
            public void onProviderDisabled(String provider) {}
        };

        int requested = 0;
        /* GPS 先注册：它收敛慢但最准，早一点开始等 */
        for (String provider : new String[]{LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER}) {
            try {
                if (!manager.isProviderEnabled(provider)) continue;
                manager.requestLocationUpdates(provider, 0L, 0f, listener, Looper.getMainLooper());
                requested++;
            } catch (SecurityException e) {
                Log.w(TAG, "provider 无权限：" + provider);
            }
        }
        if (requested == 0) {
            if (lastKnown != null) return toFix(lastKnown, true);
            throw new IllegalStateException("没有可用的定位 provider");
        }

        try {
            latch.await(timeoutMs, TimeUnit.MILLISECONDS);
        } finally {
            try {
                manager.removeUpdates(listener);
            } catch (Exception ignored) {
            }
        }

        Location fix = best[0];
        /* 实时结果太差（比如 1 公里外的基站定位）而 lastKnown 更准时，用 lastKnown */
        if (fix != null && lastKnown != null
                && accuracyOf(fix) > 200f && accuracyOf(lastKnown) < accuracyOf(fix)) {
            return toFix(lastKnown, true);
        }
        if (fix == null) fix = lastKnown;
        if (fix == null) throw new IllegalStateException("定位超时（户外或信号差时多等几秒再试）");
        return toFix(fix, best[0] == null);
    }

    /** 精度未知按很差处理，避免「没写精度」的定位被当成好点 */
    private static float accuracyOf(Location location) {
        return location.hasAccuracy() ? location.getAccuracy() : UNKNOWN_ACCURACY;
    }

    /**
     * 取最准的一条 lastKnown，而不是最新的一条。
     * 同一台设备上 NETWORK 的 lastKnown 往往是几十秒前的基站定位（偏差几百米），
     * GPS 的可能是十分钟前的（但只有十几米）——后者对「离哪个站最近」更有用。
     */
    private static Location bestLastKnown(LocationManager manager) {
        Location best = null;
        try {
            List<String> providers = manager.getProviders(true);
            for (String provider : providers) {
                Location location;
                try {
                    location = manager.getLastKnownLocation(provider);
                } catch (SecurityException e) {
                    continue;
                }
                if (location == null) continue;
                if (best == null || accuracyOf(location) < accuracyOf(best)) {
                    best = location;
                } else if (accuracyOf(location) == accuracyOf(best)
                        && location.getTime() > best.getTime()) {
                    best = location;
                }
            }
        } catch (SecurityException ignored) {
        }
        return best;
    }

    private static Fix toFix(Location location, boolean stale) {
        Fix fix = new Fix();
        fix.lat = location.getLatitude();
        fix.lng = location.getLongitude();
        fix.accuracy = location.hasAccuracy() ? location.getAccuracy() : -1;
        fix.provider = location.getProvider();
        fix.stale = stale;
        fix.ageMs = Math.max(0, System.currentTimeMillis() - location.getTime());
        return fix;
    }

    public static JSONObject toJson(Fix fix) throws Exception {
        JSONObject out = new JSONObject();
        out.put("lat", fix.lat);
        out.put("lng", fix.lng);
        out.put("accuracy", fix.accuracy);
        out.put("provider", fix.provider);
        out.put("stale", fix.stale);
        out.put("ageSeconds", fix.ageMs / 1000);
        return out;
    }
}
