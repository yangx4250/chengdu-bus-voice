package com.chengdu.bus;

import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.location.Location;
import android.location.LocationManager;
import android.util.Log;
import android.webkit.JavascriptInterface;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.List;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicLong;

/**
 * 给 WebView 里的 JS 用的桥：查询走后台线程，JS 轮询 poll 取结果，避免卡住界面。
 */
public final class BusBridge {

    private static final String TAG = "CdBusBridge";

    private final MainActivity activity;
    private final Speech speech;
    /**
     * 客户端按城市缓存：同一城市复用实例（省掉重复的 DNS/TLS 握手），
     * 换城市时从 map 里取，没有就新建一个。
     */
    private final ConcurrentHashMap<String, ChelaileClient> clients = new ConcurrentHashMap<>();
    /** 掌上公交客户端缓存（车来了没覆盖的城市）。 */
    private final ConcurrentHashMap<String, MyGolbsClient> mgClients = new ConcurrentHashMap<>();

    /** 从参数里解析出 cityId（mygolbs 城市返回 mg- 前缀，其余是车来了数字 id）。 */
    private String cityIdOf(JSONObject args) {
        String id = args.optString("cityId", "");
        if (id != null && !id.isEmpty()) return id;
        String name = args.optString("city", "");
        if (name != null && !name.isEmpty()) {
            String mg = MyGolbsClient.cityIdOfName(name);
            if (!mg.isEmpty()) return mg;
            String cl = ChelaileClient.cityIdOf(name);
            if (!cl.isEmpty()) return cl;
        }
        return ChelaileClient.CITY_ID;
    }

    private ChelaileClient clientFor(JSONObject args) {
        String want = cityIdOf(args);
        ChelaileClient cached = clients.get(want);
        if (cached == null) {
            cached = new ChelaileClient().setCity(want);
            ChelaileClient prev = clients.putIfAbsent(want, cached);
            if (prev != null) cached = prev;
        }
        return cached;
    }

    /** 掌上公交客户端（仅 mg- 城市调用）。 */
    private MyGolbsClient mgClientFor(JSONObject args) {
        String want = cityIdOf(args);
        MyGolbsClient cached = mgClients.get(want);
        if (cached == null) {
            cached = new MyGolbsClient(want);
            MyGolbsClient prev = mgClients.putIfAbsent(want, cached);
            if (prev != null) cached = prev;
        }
        return cached;
    }
    private final Navigator navigator;
    private final ExecutorService pool = Executors.newFixedThreadPool(4);
    private final ConcurrentHashMap<String, Task> tasks = new ConcurrentHashMap<>();
    private final AtomicLong sequence = new AtomicLong();
    private volatile String currentView = "home";

    /** 在线更新模块（由 MainActivity 注入）。 */
    private volatile Updater updater = null;
    /** 更新进度存在这里，页面用 updatePoll 拉（避免从后台线程回调 JS）。 */
    private volatile String updateState = "";
    private volatile String updateData = "";

    void setUpdater(Updater u) {
        this.updater = u;
    }

    private static final class Task {
        volatile String state = "running";
        volatile String data;
        volatile String error;
    }

    BusBridge(MainActivity activity, Speech speech) {
        this.activity = activity;
        this.speech = speech;
        this.navigator = new Navigator(activity);
    }

    @JavascriptInterface
    public String start(String method, String payload) {
        final String id = "t" + sequence.incrementAndGet();
        final Task task = new Task();
        tasks.put(id, task);

        final JSONObject args;
        try {
            args = payload == null || payload.isEmpty() ? new JSONObject() : new JSONObject(payload);
        } catch (Exception e) {
            task.state = "error";
            task.error = "参数解析失败：" + e.getMessage();
            return id;
        }

        final String targetMethod = method;
        pool.execute(new Runnable() {
            @Override
            public void run() {
                try {
                    Object result = dispatch(targetMethod, args);
                    task.data = result instanceof JSONArray ? result.toString() : String.valueOf(result);
                    task.state = "ok";
                } catch (Exception e) {
                    Log.w(TAG, "查询失败 " + targetMethod, e);
                    task.error = e.getMessage() == null ? e.toString() : e.getMessage();
                    task.state = "error";
                }
            }
        });
        return id;
    }

    @JavascriptInterface
    public String poll(String id) {
        Task task = tasks.get(id);
        if (task == null) return "{\"state\":\"error\",\"error\":\"任务不存在\"}";
        String state = task.state;
        if ("running".equals(state)) return "{\"state\":\"running\"}";
        tasks.remove(id);
        if ("ok".equals(state)) return "{\"state\":\"ok\",\"data\":" + task.data + "}";
        try {
            JSONObject out = new JSONObject();
            out.put("state", "error");
            out.put("error", task.error == null ? "未知错误" : task.error);
            return out.toString();
        } catch (Exception e) {
            return "{\"state\":\"error\",\"error\":\"结果序列化失败\"}";
        }
    }

    @JavascriptInterface
    public void speak(String text) {
        speech.speak(text, new Speech.Callback() {
            @Override
            public void onResult(boolean spoken, String detail) {
                Log.i(TAG, "播报：" + spoken + " " + detail);
            }
        });
    }

    /** 语音环境状态（TTS 引擎、媒体音量、最近一次播报结果），同步返回 JSON。 */
    @JavascriptInterface
    public String status() {
        try {
            return speech.diag().toString();
        } catch (Exception e) {
            return "{\"error\":\"" + e.getMessage() + "\"}";
        }
    }

    @JavascriptInterface
    public void testTone() {
        speech.playTone(new Speech.Callback() {
            @Override
            public void onResult(boolean spoken, String detail) {
                Log.i(TAG, "测试音：" + spoken + " " + detail);
            }
        });
    }

    @JavascriptInterface
    public String appInfo() {
        JSONObject out = new JSONObject();
        try {
            android.content.pm.PackageInfo info = activity.getPackageManager()
                    .getPackageInfo(activity.getPackageName(), 0);
            out.put("version", info.versionName == null ? "" : info.versionName);
            long code;
            if (android.os.Build.VERSION.SDK_INT >= 28) {
                code = info.getLongVersionCode();
            } else {
                code = info.versionCode;
            }
            out.put("code", code);
            out.put("pkg", activity.getPackageName());
            out.put("android", android.os.Build.VERSION.RELEASE);
            out.put("sdk", android.os.Build.VERSION.SDK_INT);
            out.put("device", (android.os.Build.MANUFACTURER + " " + android.os.Build.MODEL).trim());
        } catch (Exception e) {
            Log.w(TAG, "读取版本失败", e);
        }
        return out.toString();
    }

    /* ------------------------------------------------------------ 在线更新 */

    /**
     * 检查更新。
     *
     * @param silent 启动时的静默检查：没有新版就什么都不做
     * 结果用 updatePoll() 拉，因为后台线程不能直接回调 JS。
     */
    @JavascriptInterface
    public void updateCheck(final boolean silent) {
        final Updater u = updater;
        if (u == null) {
            pushUpdate("error", "{\"message\":\"更新模块不可用\"}");
            return;
        }
        pushUpdate("checking", "{\"silent\":" + silent + "}");
        u.check(silent, new Updater.Listener() {
            @Override
            public void onState(String state, org.json.JSONObject data) {
                /* 静默检查时，「没新版」不需要推给页面 */
                if (silent && "checked".equals(state) && data != null
                        && !data.optBoolean("hasUpdate", false)) {
                    pushUpdate("idle", "{}");
                    return;
                }
                pushUpdate(state, data == null ? "{}" : data.toString());
            }
        });
    }

    @JavascriptInterface
    public void updateDownload() {
        final Updater u = updater;
        if (u == null) {
            pushUpdate("error", "{\"message\":\"更新模块不可用\"}");
            return;
        }
        pushUpdate("downloading", "{\"percent\":0}");
        u.downloadAndInstall(new Updater.Listener() {
            @Override
            public void onState(String state, org.json.JSONObject data) {
                pushUpdate(state, data == null ? "{}" : data.toString());
            }
        });
    }

    @JavascriptInterface
    public void updateCancel() {
        if (updater != null) updater.cancel();
    }

    /** 是否已安装「未知来源」权限。没权限时页面引导用户去开。 */
    @JavascriptInterface
    public boolean updateCanInstall() {
        return updater != null && updater.canInstall();
    }

    @JavascriptInterface
    public void updateOpenInstallPermission() {
        if (updater != null) updater.openInstallPermission();
    }

    /** 发起安装（要求已下载且已授权）。返回是否成功发起。 */
    @JavascriptInterface
    public boolean updateInstall() {
        return updater != null && updater.install();
    }

    /** 页面轮询更新进度。返回 {state, data} 的 JSON 字符串。 */
    @JavascriptInterface
    public String updatePoll() {
        String st = updateState;
        String dt = updateData;
        if ("ready".equals(st) || "error".equals(st) || "idle".equals(st)) {
            /* 终态只交付一次，避免页面反复处理 */
            updateState = "";
            updateData = "";
        }
        try {
            org.json.JSONObject o = new org.json.JSONObject();
            o.put("state", st == null ? "" : st);
            o.put("data", new org.json.JSONObject(dt == null || dt.isEmpty() ? "{}" : dt));
            return o.toString();
        } catch (Exception e) {
            return "{\"state\":\"\",\"data\":{}}";
        }
    }

    /** 当前已下载的安装包信息（没有则 null）。 */
    @JavascriptInterface
    public String updateDownloaded() {
        if (updater == null) return "";
        org.json.JSONObject o = updater.downloadedApk();
        return o == null ? "" : o.toString();
    }

    /** 当前版本（页面显示用）。 */
    @JavascriptInterface
    public String updateVersion() {
        if (updater == null) return "{}";
        try {
            return new org.json.JSONObject()
                    .put("name", updater.currentVersionName())
                    .put("code", updater.currentVersionCode())
                    .toString();
        } catch (Exception e) {
            return "{}";
        }
    }

    private void pushUpdate(String state, String data) {
        updateState = state == null ? "" : state;
        updateData = data == null ? "{}" : data;
    }

    @JavascriptInterface
    public void startWatchService(String payload) {
        try {
            JSONObject args = new JSONObject(payload == null ? "{}" : payload);
            android.content.Intent intent = new android.content.Intent(activity, WatchService.class);
            intent.setAction(WatchService.ACTION_START);
            intent.putExtra("lineId", args.optString("lineId"));
            intent.putExtra("lineName", args.optString("lineName"));
            intent.putExtra("stationId", args.optString("stationId"));
            intent.putExtra("stationName", args.optString("stationName"));
            intent.putExtra("toward", args.optString("toward"));
            intent.putExtra("order", args.optInt("order", 1));
            intent.putExtra("lat", args.optDouble("lat", 0));
            intent.putExtra("lng", args.optDouble("lng", 0));
            // 盯站要跨城市：把当前城市带进去，服务重启后也能恢复
            String cityId = args.optString("cityId", "");
            if (cityId.isEmpty()) {
                String cityName = args.optString("city", "");
                if (!cityName.isEmpty()) cityId = ChelaileClient.cityIdOf(cityName);
            }
            if (!cityId.isEmpty()) intent.putExtra("cityId", cityId);
            if (android.os.Build.VERSION.SDK_INT >= 26) activity.startForegroundService(intent);
            else activity.startService(intent);
        } catch (Exception e) {
            Log.w(TAG, "启动盯站服务失败", e);
        }
    }

    @JavascriptInterface
    public void stopWatchService() {
        try {
            android.content.Intent intent = new android.content.Intent(activity, WatchService.class);
            intent.setAction(WatchService.ACTION_STOP);
            activity.startService(intent);
            activity.stopService(new android.content.Intent(activity, WatchService.class));
        } catch (Exception e) {
            Log.w(TAG, "停止盯站服务失败", e);
        }
    }

    /** 盯站服务的运行状态（自检面板用）。 */
    @JavascriptInterface
    public String watchStatus() {
        return WatchService.statusJson();
    }

    /** 切换盯站诊断模式：开启后每次轮询都念一句，用来确认服务是否在跑。 */
    @JavascriptInterface
    public boolean toggleWatchDiag() {
        return WatchService.toggleDiag();
    }

    /** 锁屏通知开关：关掉后盯站/下车提醒只在后台播报，不弹锁屏通知。 */
    @JavascriptInterface
    public void setLockNotify(boolean on) {
        Notify.setEnabled(activity, on);
    }

    /** 锁屏通知当前是否开启（默认开）。 */
    @JavascriptInterface
    public boolean lockNotifyOn() {
        return Notify.enabled(activity);
    }

    /** 立刻发一条锁屏通知，供设置页「试一下」按钮使用。 */
    @JavascriptInterface
    public void testLockNotify() {
        Notify.post(activity, Notify.appLabel(activity) + " · 锁屏通知测试", "如果你在锁屏上看到这条，说明锁屏通知可用");
    }

    /** 锁屏通知自检：把开关、权限、通道重要度、锁屏可见性一次返回，便于排查「锁屏看不到」。 */
    @JavascriptInterface
    public String lockNotifyDiag() {
        return Notify.diagnose(activity);
    }

    /** 补申请通知权限（Android 13+ 之前拒绝过的话，只能引导到系统设置）。 */
    @JavascriptInterface
    public void askNotificationPermission() {
        try {
            activity.askNotificationPermission();
        } catch (Throwable e) {
            Log.w(TAG, "补申请通知权限失败", e);
        }
    }

    /** 申请「忽略电池优化」，让息屏后后台服务不被系统清掉。 */
    @JavascriptInterface
    public void requestIgnoreBatteryOptimization() {
        try {
            activity.requestIgnoreBatteryOptimization();
        } catch (Exception e) {
            Log.w(TAG, "申请电池优化白名单失败", e);
        }
    }

    /** 启动/停止后台心跳测试（每 30 秒播一次）。返回最新状态 JSON。 */
    @JavascriptInterface
    public String startHeartbeat() {
        try {
            boolean running = HeartbeatService.statusJson().contains("\"running\":true");
            Intent intent = new Intent(activity, HeartbeatService.class);
            if (running) {
                intent.setAction(HeartbeatService.ACTION_STOP);
                activity.startService(intent);
                activity.stopService(new Intent(activity, HeartbeatService.class));
            } else {
                intent.setAction(HeartbeatService.ACTION_START);
                if (android.os.Build.VERSION.SDK_INT >= 26) activity.startForegroundService(intent);
                else activity.startService(intent);
            }
        } catch (Exception e) {
            Log.w(TAG, "切换心跳服务失败", e);
        }
        return HeartbeatService.statusJson();
    }

    /** 心跳服务状态（自检面板显示用）。 */
    @JavascriptInterface
    public String heartbeatStatus() {
        return HeartbeatService.statusJson();
    }

    /** 是否已在电池优化白名单里。 */
    @JavascriptInterface
    public boolean ignoringBatteryOptimizations() {
        try {
            if (android.os.Build.VERSION.SDK_INT < 23) return true;
            android.os.PowerManager pm = (android.os.PowerManager)
                    activity.getSystemService(Context.POWER_SERVICE);
            return pm != null && pm.isIgnoringBatteryOptimizations(activity.getPackageName());
        } catch (Exception e) {
            return false;
        }
    }

    /** 启动下车提醒：目的地站名/站序/坐标 + 该线路全部站点（用来算还剩几站）。 */
    @JavascriptInterface
    public void startAlightService(String payload) {
        try {
            JSONObject args = new JSONObject(payload == null ? "{}" : payload);
            android.content.Intent intent = new android.content.Intent(activity, AlightService.class);
            intent.setAction(AlightService.ACTION_START);
            intent.putExtra("lineName", args.optString("lineName"));
            intent.putExtra("toward", args.optString("toward"));
            intent.putExtra("destName", args.optString("destName"));
            intent.putExtra("destOrder", args.optInt("destOrder", 1));
            intent.putExtra("destLat", args.optDouble("destLat", 0));
            intent.putExtra("destLng", args.optDouble("destLng", 0));
            /* 到站半径：地铁在地下只有基站/WiFi 定位，精度几百米，页面会传大一点 */
            intent.putExtra("arriveMeters", (float) args.optDouble("arriveMeters", 250));
            intent.putExtra("stations", args.optString("stations"));
            if (android.os.Build.VERSION.SDK_INT >= 26) activity.startForegroundService(intent);
            else activity.startService(intent);
        } catch (Exception e) {
            Log.w(TAG, "启动下车提醒失败", e);
        }
    }

    @JavascriptInterface
    public void stopAlightService() {
        try {
            android.content.Intent intent = new android.content.Intent(activity, AlightService.class);
            intent.setAction(AlightService.ACTION_STOP);
            activity.startService(intent);
            activity.stopService(new android.content.Intent(activity, AlightService.class));
        } catch (Exception e) {
            Log.w(TAG, "停止下车提醒失败", e);
        }
    }

    /** 下车提醒的实时状态（剩余站数 / 距离 / 是否已到站），同步返回 JSON。 */
    @JavascriptInterface
    public String alightStatus() {
        return AlightService.statusJson();
    }

    /**
     * 页面视图栈已经到底了：退回桌面，但不结束进程。
     * 用 moveTaskToBack 而不是 finish()，这样从桌面点图标回来时页面状态还在，
     * 盯站/下车提醒等后台服务也不受影响。
     */
    @JavascriptInterface
    public void exitApp() {
        activity.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                activity.moveTaskToBack(true);
            }
        });
    }

    @JavascriptInterface
    public void note(String text) {
        speech.note(text);
    }

    @JavascriptInterface
    public void setVolume(int percent) {
        speech.setMediaVolume(percent);
    }

    @JavascriptInterface
    public void testPcm() {
        speech.playPcmTone(new Speech.Callback() {
            @Override
            public void onResult(boolean spoken, String detail) {
                Log.i(TAG, "PCM 直出：" + spoken + " " + detail);
            }
        });
    }

    @JavascriptInterface
    public void testSysTone() {
        speech.playSystemTone(new Speech.Callback() {
            @Override
            public void onResult(boolean spoken, String detail) {
                Log.i(TAG, "系统音效：" + spoken + " " + detail);
            }
        });
    }

    @JavascriptInterface
    public void testSpeak() {
        speech.speak("公交播报，语音测试。", new Speech.Callback() {
            @Override
            public void onResult(boolean spoken, String detail) {
                Log.i(TAG, "测试播报：" + spoken + " " + detail);
            }
        });
    }

    /** 页面把当前明暗模式告诉原生：状态栏/导航栏的颜色和图标亮暗要跟着变。 */
    @JavascriptInterface
    public void setUiMode(String mode) {
        try {
            activity.setUiMode(!"dark".equalsIgnoreCase(mode == null ? "" : mode.trim()));
        } catch (Exception e) {
            Log.w(TAG, "设置系统栏失败", e);
        }
    }

    /** 页面当前在哪个视图（home / detail），供返回键判断。 */
    @JavascriptInterface
    public void setView(String name) {
        currentView = name == null ? "home" : name;
    }

    String currentView() {
        return currentView;
    }

    @JavascriptInterface
    public String backend() {
        return speech.backendName();
    }

    /** 已安装的导航 App 列表（页面用它决定显示哪个导航按钮）。 */
    @JavascriptInterface
    public String navApps() {
        try {
            return navigator.list().toString();
        } catch (Exception e) {
            Log.w(TAG, "读取导航 App 失败：" + e.getMessage());
            return "{\"apps\":[],\"fallback\":true}";
        }
    }

    /**
     * 导航到某站。
     *
     * @param appId   目标 App（amap/baidu/tencent/google/…），空则自动挑一个
     * @param lat     站点纬度（WGS84）
     * @param lng     站点经度（WGS84）
     * @param name    终点名称
     * @param fromLat 我的位置纬度（WGS84，传 NaN 表示没有）
     * @param fromLng 我的位置经度（WGS84）
     */
    @JavascriptInterface
    public String navigate(String appId, double lat, double lng, String name,
                           double fromLat, double fromLng) {
        try {
            return navigator.navigate(appId, lat, lng, name, fromLat, fromLng).toString();
        } catch (Exception e) {
            Log.w(TAG, "导航失败：" + e.getMessage());
            try {
                return new JSONObject().put("ok", false)
                        .put("error", e.getMessage() == null ? "导航失败" : e.getMessage()).toString();
            } catch (Exception ignored) {
                return "{\"ok\":false,\"error\":\"导航失败\"}";
            }
        }
    }

    /** 同步拿「最后一次已知位置」，只用于界面先显示；要新定位请调 start("location")。 */
    @JavascriptInterface
    public String location() {
        try {
            if (!Locator.hasPermission(activity)) return "";
            android.location.LocationManager manager =
                    (android.location.LocationManager) activity.getSystemService(Context.LOCATION_SERVICE);
            if (manager == null) return "";
            android.location.Location best = null;
            java.util.List<String> providers = manager.getProviders(true);
            for (String provider : providers) {
                android.location.Location location = manager.getLastKnownLocation(provider);
                if (location == null) continue;
                if (best == null || location.getTime() > best.getTime()) best = location;
            }
            if (best == null) return "";
            return best.getLatitude() + "," + best.getLongitude();
        } catch (Exception e) {
            return "";
        }
    }

    private Object dispatch(String method, JSONObject args) throws Exception {
        /* 按城市分流：掌上公交城市（mg-）走 MyGolbsClient，其余走车来了。
           两家输出 JSON 结构一致，页面无需感知数据源。 */
        final boolean mg = MyGolbsClient.isMine(cityIdOf(args));
        switch (method) {
            case "lines":
                return mg ? mgClientFor(args).searchLines(args.optString("key"))
                          : clientFor(args).searchLines(args.optString("key"));
            case "stations":
                return mg ? mgClientFor(args).searchStations(args.optString("key"))
                          : clientFor(args).searchStations(args.optString("key"));
            case "pois":
                if (mg) return new JSONArray();   // 掌上公交没有 POI 搜索
                return clientFor(args).searchPois(args.optString("key"));
            case "transit": {
                if (mg) throw new IllegalArgumentException("该城市暂不支持跨城换乘规划");
                JSONObject from = args.optJSONObject("from");
                JSONObject dest = args.optJSONObject("dest");
                if (from == null || dest == null) throw new IllegalArgumentException("缺少起点或终点");
                return clientFor(args).transit(
                        from.optDouble("lat"), from.optDouble("lng"), from.optString("name"),
                        dest.optDouble("lat"), dest.optDouble("lng"), dest.optString("name"),
                        args.optString("strategy", "0"));
            }
            case "detail":
                return mg ? mgClientFor(args).lineDetail(args.optString("lineId"))
                          : clientFor(args).lineDetail(args.optString("lineId"));
            case "arrivals":
                return mg ? mgClientFor(args).arrivals(args.optString("lineId"), args.getJSONObject("station"))
                          : clientFor(args).arrivals(args.optString("lineId"), args.getJSONObject("station"));
            case "synth": {
                String base64 = speech.synthesizeBase64(args.optString("text"));
                return new JSONObject().put("base64", base64).put("bytes", base64.length());
            }
            case "synthwav": {
                String base64 = speech.synthesizeWavBase64(args.optString("text"));
                return new JSONObject().put("base64", base64).put("bytes", base64.length());
            }
            case "matrix":
                return mg ? mgClientFor(args).stationMatrix(
                        args.optString("lineId"), args.optInt("fromOrder", 1), args.optInt("window", 10))
                          : clientFor(args).stationMatrix(
                        args.optString("lineId"), args.optInt("fromOrder", 1), args.optInt("window", 10));
            case "nearby":
                return mg ? mgClientFor(args).nearby(args.optDouble("lat"), args.optDouble("lng"), args.optInt("limit", 5))
                          : clientFor(args).nearby(args.optDouble("lat"), args.optDouble("lng"), args.optInt("limit", 5));
            case "location": {
                long timeout = args.optLong("timeout", 12000);
                Locator.Fix fix = Locator.current(activity, timeout);
                return Locator.toJson(fix);
            }
            case "permissions":
                return new JSONObject().put("location", Locator.hasPermission(activity));
            case "city": {
                JSONObject info = clientFor(args).assertCity(args.optDouble("lat"), args.optDouble("lng"));
                /* 车来了没覆盖的市州（德阳/广元/广安/甘孜/阿坝），若掌上公交有数据，
                   就转成 mg- 城市，让定位到这些地方的人也能查车。凉山维持无数据。 */
                boolean covered;
                try { covered = info.optBoolean("covered", true); }
                catch (Exception e) { covered = true; }
                if (!covered) {
                    String cityName = info.optString("city", "");
                    String mgId = MyGolbsClient.cityIdOfName(cityName);
                    /* 甘孜州车来了返回的名字可能是「甘孜藏族自治州」或「甘孜」 */
                    if (mgId.isEmpty() && cityName.contains("甘孜")) mgId = "mg-ganzi";
                    if (mgId.isEmpty() && cityName.contains("阿坝")) mgId = "mg-aba";
                    if (mgId.isEmpty() && cityName.contains("德阳")) mgId = "mg-deyang";
                    if (mgId.isEmpty() && cityName.contains("广元")) mgId = "mg-guangyuan";
                    if (mgId.isEmpty() && cityName.contains("广安")) mgId = "mg-guangan";
                    if (!mgId.isEmpty()) {
                        JSONObject out = new JSONObject();
                        out.put("cityId", mgId);
                        out.put("city", cityName);
                        out.put("covered", true);
                        out.put("source", "mygolbs");
                        return out;
                    }
                }
                return info;
            }
            case "citytable": {
                /* 城市选择器：车来了城市 + 掌上公交补充城市合并 */
                JSONArray all = ChelaileClient.cityTable();
                JSONArray extra = MyGolbsClient.cityTable();
                for (int i = 0; i < extra.length(); i++) all.put(extra.opt(i));
                return all;
            }
            default:
                throw new IllegalArgumentException("未知方法 " + method);
        }
    }
}