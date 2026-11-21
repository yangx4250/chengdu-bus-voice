package com.chengdu.bus;

import android.content.Context;
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
    private final ChelaileClient client = new ChelaileClient();
    private final ExecutorService pool = Executors.newFixedThreadPool(4);
    private final ConcurrentHashMap<String, Task> tasks = new ConcurrentHashMap<>();
    private final AtomicLong sequence = new AtomicLong();
    private volatile String currentView = "home";

    private static final class Task {
        volatile String state = "running";
        volatile String data;
        volatile String error;
    }

    BusBridge(MainActivity activity, Speech speech) {
        this.activity = activity;
        this.speech = speech;
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
        speech.speak("成都公交播报，语音测试。", new Speech.Callback() {
            @Override
            public void onResult(boolean spoken, String detail) {
                Log.i(TAG, "测试播报：" + spoken + " " + detail);
            }
        });
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
        switch (method) {
            case "lines":
                return client.searchLines(args.optString("key"));
            case "detail":
                return client.lineDetail(args.optString("lineId"));
            case "arrivals":
                return client.arrivals(args.optString("lineId"), args.getJSONObject("station"));
            case "synth": {
                String base64 = speech.synthesizeBase64(args.optString("text"));
                return new JSONObject().put("base64", base64).put("bytes", base64.length());
            }
            case "synthwav": {
                String base64 = speech.synthesizeWavBase64(args.optString("text"));
                return new JSONObject().put("base64", base64).put("bytes", base64.length());
            }
            case "matrix":
                return client.stationMatrix(
                        args.optString("lineId"),
                        args.optInt("fromOrder", 1),
                        args.optInt("window", 10));
            case "nearby":
                return client.nearby(args.optDouble("lat"), args.optDouble("lng"), args.optInt("limit", 5));
            case "location": {
                long timeout = args.optLong("timeout", 12000);
                Locator.Fix fix = Locator.current(activity, timeout);
                return Locator.toJson(fix);
            }
            case "permissions":
                return new JSONObject().put("location", Locator.hasPermission(activity));
            case "city":
                return client.assertChengdu(args.optDouble("lat"), args.optDouble("lng"));
            default:
                throw new IllegalArgumentException("未知方法 " + method);
        }
    }
}