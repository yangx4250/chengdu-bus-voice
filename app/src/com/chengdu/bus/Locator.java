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
 * 旧实现只看 getLastKnownLocation：手机刚开机/刚关过定位时它通常是 null 或者几个小时前的位置，
 * 于是 App 静默退回天府广场，看起来就是「定位有问题」。
 *
 * 现在的顺序：
 *   1. 有 2 分钟内的 lastKnown → 直接用（秒回）；
 *   2. 否则同时向 GPS / NETWORK / PASSIVE 请求一次定位，最多等 timeoutMs；
 *      精度 ≤50 米就提前结束，否则取这段时间里最准的一条；
 *   3. 还拿不到，退回最旧的 lastKnown（并标记 stale）。
 */
public final class Locator {

    private static final String TAG = "CdBusLocator";
    private static final long FRESH_MS = 2 * 60 * 1000;
    private static final float GOOD_ACCURACY = 50f;

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
        if (lastKnown != null && System.currentTimeMillis() - lastKnown.getTime() < FRESH_MS) {
            return toFix(lastKnown, false);
        }

        final Location[] best = new Location[1];
        final CountDownLatch latch = new CountDownLatch(1);
        LocationListener listener = new LocationListener() {
            @Override
            public void onLocationChanged(Location location) {
                if (best[0] == null || location.getAccuracy() < best[0].getAccuracy()) {
                    best[0] = location;
                }
                if (location.getAccuracy() <= GOOD_ACCURACY) latch.countDown();
            }

            @Override
            public void onStatusChanged(String provider, int status, Bundle extras) {}

            @Override
            public void onProviderEnabled(String provider) {}

            @Override
            public void onProviderDisabled(String provider) {}
        };

        int requested = 0;
        for (String provider : new String[]{LocationManager.NETWORK_PROVIDER, LocationManager.GPS_PROVIDER}) {
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

        Location fix = best[0] != null ? best[0] : lastKnown;
        if (fix == null) throw new IllegalStateException("定位超时（户外或信号差时多等几秒再试）");
        return toFix(fix, best[0] == null);
    }

    private static Location bestLastKnown(LocationManager manager) {
        Location best = null;
        try {
            List<String> providers = manager.getProviders(true);
            for (String provider : providers) {
                Location location = manager.getLastKnownLocation(provider);
                if (location == null) continue;
                if (best == null || location.getTime() > best.getTime()) best = location;
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