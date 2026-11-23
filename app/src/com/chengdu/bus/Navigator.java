package com.chengdu.bus;

import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.net.URLEncoder;
import java.util.ArrayList;
import java.util.List;

/**
 * 调起手机里已装的导航 App，导航到指定站点。
 *
 * 各家的 URI scheme 与坐标系都不同（传错坐标系终点会偏几百米）：
 *   高德 / 腾讯 / 图吧 …… GCJ-02
 *   百度 ……………………… BD-09
 *   谷歌地图 ………………… WGS84（境外/自带底图）
 *   通用 geo: ………………… WGS84
 */
public final class Navigator {

    private static final String TAG = "CdBusNavigator";

    /** 一个可选的地图 App。 */
    private static final class Target {
        final String id;          // 给 JS 用的标识
        final String label;       // 界面上显示的名字
        final String pkg;         // 用于判断是否安装
        final int coord;          // 0=GCJ-02  1=BD-09  2=WGS84
        final String name;

        Target(String id, String label, String pkg, int coord) {
            this.id = id;
            this.label = label;
            this.pkg = pkg;
            this.coord = coord;
            this.name = id;
        }
    }

    private static final int GCJ = 0, BD = 1, WGS = 2;

    /** v1.0.33 起导航一律走步行，不再按距离切换驾车（原来 500 米内步行、更远驾车）。 */

    /** 按优先级排列：越靠前越优先（国内用户更可能装高德/百度）。 */
    private static final Target[] TARGETS = new Target[]{
            new Target("amap", "高德地图", "com.autonavi.minimap", GCJ),
            new Target("baidu", "百度地图", "com.baidu.BaiduMap", BD),
            new Target("tencent", "腾讯地图", "com.tencent.map", GCJ),
            new Target("google", "谷歌地图", "com.google.android.apps.maps", WGS),
            new Target("here", "Here 地图", "com.here.app.maps", WGS),
            new Target("petal", "花瓣地图", "com.huawei.maps.app", GCJ),
    };

    private final MainActivity activity;

    Navigator(MainActivity activity) {
        this.activity = activity;
    }

    private boolean installed(String pkg) {
        try {
            activity.getPackageManager().getPackageInfo(pkg, 0);
            return true;
        } catch (PackageManager.NameNotFoundException e) {
            return false;
        } catch (Exception e) {
            return false;
        }
    }

    /** 列出已安装的导航 App（给页面画按钮用）。 */
    JSONObject list() throws Exception {
        JSONArray arr = new JSONArray();
        for (Target t : TARGETS) {
            if (!installed(t.pkg)) continue;
            arr.put(new JSONObject()
                    .put("id", t.id)
                    .put("label", t.label)
                    .put("pkg", t.pkg));
        }
        JSONObject out = new JSONObject();
        out.put("apps", arr);
        // 一个都没装时，页面退回到「通用 geo:」按钮
        out.put("fallback", arr.length() == 0);
        return out;
    }

    /**
     * 导航到某点。
     *
     * @param appId  目标 App 的 id；空/未知则用第一个已装的，全没装就用 geo:
     * @param lat    站点纬度（WGS84，来自车来了接口）
     * @param lng    站点经度（WGS84）
     * @param name   终点名称（站点名）
     * @param fromLat 我的当前位置纬度（WGS84，可传 NaN 表示不知道）
     * @param fromLng 我的当前位置经度（WGS84）
     */
    JSONObject navigate(String appId, double lat, double lng, String name,
                        double fromLat, double fromLng) throws Exception {
        Target target = null;
        for (Target t : TARGETS) {
            if (t.id.equals(appId) && installed(t.pkg)) { target = t; break; }
        }
        if (target == null) {
            for (Target t : TARGETS) {
                if (installed(t.pkg)) { target = t; break; }
            }
        }

        if (target == null) {
            // 一个地图 App 都没装：走系统通用 geo:（多数 ROM 会弹选择器）
            return openGeo(lat, lng, name);
        }

        /* 一律步行导航：公交站通常就在步行范围内，之前超过 500 米会变成驾车，不合用。 */
        boolean walk = true;
        int distance = distanceMeters(fromLat, fromLng, lat, lng);

        double[] c;
        switch (target.coord) {
            case BD: c = Geo.wgsToBd(lat, lng); break;
            case WGS: c = new double[]{lat, lng}; break;
            default: c = Geo.wgsToGcj(lat, lng); break;
        }

        String encName = URLEncoder.encode(name == null ? "目的地" : name, "UTF-8");
        Uri uri = null;
        try {
            switch (target.id) {
                case "amap":
                    // 高德：t=0 驾车 / t=2 步行；坐标顺序是 经度,纬度
                    uri = Uri.parse("androidamap://navi?sourceApplication=chengdubus&lat=" + c[0]
                            + "&lon=" + c[1] + "&poiname=" + encName
                            + "&dev=0&style=2&t=" + (walk ? 2 : 0));
                    break;
                case "baidu":
                    // 百度：location=纬度,经度（顺序与高德相反）；
                    // mode=walking / driving，交通方式用 mode 指定
                    uri = Uri.parse("baidumap://map/navi?location=" + c[0] + "," + c[1]
                            + "&query=" + encName + "&src=chengdubus"
                            + "&mode=" + (walk ? "walking" : "driving"));
                    break;
                case "tencent":
                    // 腾讯：coord_type=gcj02；type=drive / walk
                    uri = Uri.parse("qqmap://map/routeplan?type=" + (walk ? "walk" : "drive")
                            + "&to=" + encName
                            + "&tocoord=" + c[0] + "," + c[1] + "&referer=chengdubus&coord_type=gcj02");
                    break;
                case "google":
                    // 谷歌：mode=w 步行 / d 驾车
                    uri = Uri.parse("google.navigation:q=" + c[0] + "," + c[1]
                            + "&mode=" + (walk ? "w" : "d"));
                    break;
                case "here":
                    uri = Uri.parse("here-destination://lat=" + c[0] + ";lon=" + c[1]
                            + ";name=" + encName + ";mode=" + (walk ? "pedestrian" : "car"));
                    break;
                case "petal":
                    uri = Uri.parse("androidamap://navi?sourceApplication=chengdubus&lat=" + c[0]
                            + "&lon=" + c[1] + "&poiname=" + encName + "&dev=0&t=" + (walk ? 2 : 0));
                    break;
                default:
                    return openGeo(lat, lng, name);
            }
        } catch (Exception e) {
            return openGeo(lat, lng, name);
        }

        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, uri);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            if (target.pkg != null) intent.setPackage(target.pkg);
            activity.startActivity(intent);
            return new JSONObject()
                    .put("ok", true)
                    .put("app", target.id)
                    .put("label", target.label)
                    .put("mode", walk ? "walk" : "drive")
                    .put("distance", distance);
        } catch (Exception e) {
            Log.w(TAG, "调起 " + target.id + " 失败：" + e.getMessage());
            // scheme 调不起来（版本差异/未装对应组件）→ 退回 geo:
            JSONObject fallback = openGeo(lat, lng, name);
            fallback.put("fallbackFrom", target.id);
            return fallback;
        }
    }

    /** 两点距离（米）；没有有效起点时返回 -1。 */
    static int distanceMeters(double lat1, double lng1, double lat2, double lng2) {
        if (Double.isNaN(lat1) || Double.isNaN(lng1)) return -1;
        if (Math.abs(lat1) < 1e-9 && Math.abs(lng1) < 1e-9) return -1;   // 0,0 视为没有定位
        double R = 6371000;
        double dLat = Math.toRadians(lat2 - lat1);
        double dLng = Math.toRadians(lng2 - lng1);
        double a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
                + Math.cos(Math.toRadians(lat1)) * Math.cos(Math.toRadians(lat2))
                * Math.sin(dLng / 2) * Math.sin(dLng / 2);
        return (int) Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
    }

    /** 系统通用地图 URI（WGS84 坐标）。 */
    private JSONObject openGeo(double lat, double lng, String name) throws Exception {
        String encName = URLEncoder.encode(name == null ? "目的地" : name, "UTF-8");
        Uri uri = Uri.parse("geo:" + lat + "," + lng + "?q=" + lat + "," + lng + "(" + encName + ")");
        Intent intent = new Intent(Intent.ACTION_VIEW, uri);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        activity.startActivity(intent);
        return new JSONObject().put("ok", true).put("app", "geo").put("label", "系统地图");
    }
}
