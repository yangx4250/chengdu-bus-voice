package com.chengdu.bus;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.util.Log;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.view.View;
import android.view.WindowInsetsController;
import android.webkit.WebViewClient;

/**
 * 单页壳：界面全部在 assets/index.html 里，Java 只负责网络、解密、播报和定位。
 */
public final class MainActivity extends Activity {

    /** 供前台服务判断：界面当前是否可见（可见时由页面自己播，服务不抢）。 */
    public static volatile boolean VISIBLE = false;

    /**
     * 界面在前台 **并且屏幕亮着** 时，才交给页面自己播。
     *
     * 息屏时 Activity 仍然是 resumed（onPause 不触发），VISIBLE 还是 true，
     * 但 WebView 的 JS 定时器已经被系统冻结 —— 此时如果把播报交给页面，
     * 结果是「谁都没念」。所以要额外看屏幕状态。
     */
    public static boolean frontAndScreenOn(Context context) {
        if (!VISIBLE) return false;
        try {
            PowerManager pm = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
            if (pm == null) return true;
            if (Build.VERSION.SDK_INT >= 20) return pm.isInteractive();
            return pm.isScreenOn();
        } catch (Throwable e) {
            return true;   // 判断不了就当亮屏，避免漏播
        }
    }

    private WebView web;
    private Speech speech;
    private BusBridge bridge;
    private Updater updater;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);

        speech = new Speech(this);

        /* 先按上次的明暗把系统栏刷一次，避免启动瞬间状态栏是黑的、页面却是白的 */
        applySystemBar(isLightModeSaved());

        web = new WebView(this);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(true);
        /* 页面本身就是 file:///android_asset/index.html，所以 AllowFileAccess 必须开；
           但下面两个「file:// 页面能不能跨源读本地文件」的开关必须关——
           万一页面被替换/注入，也没法把 /data 下的私有文件读出来。
           （setAllowUniversalAccessFromFileURLs 默认是 true，是个已知的坑） */
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setAllowContentAccess(false);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setSupportZoom(false);
        settings.setMediaPlaybackRequiresUserGesture(false);
        /* 不跟随系统字体大小：固定 textZoom=100，让 rem 基准保持稳定。
           字号改由 App 内「设置 → 字体大小」控制（页面用 CSS 变量 --font-scale），
           这样系统「字体大小」滑块调大调小都不会影响本 App 的排版。 */
        settings.setTextZoom(100);
        web.setBackgroundColor(barColor(isLightModeSaved()));

        // 长按不选文字、不弹菜单（页面里只用到点按）
        web.setLongClickable(false);
        web.setHapticFeedbackEnabled(false);
        web.setOnLongClickListener(new android.view.View.OnLongClickListener() {
            @Override
            public boolean onLongClick(android.view.View v) {
                return true;
            }
        });

        /* 只允许留在本地页面里。任何 http(s)/其它 scheme 的跳转一律交给系统处理，
           避免 WebView 被导航到外部页面后仍然带着 JS 桥（AndroidBus）活着。 */
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                if (url != null && url.startsWith("file:///android_asset/")) {
                    return false;
                }
                try {
                    Intent it = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
                    it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    startActivity(it);
                } catch (Exception e) {
                    Log.w("CdBus", "无法处理跳转: " + url, e);
                }
                return true;
            }
        });

        updater = new Updater(this);
        bridge = new BusBridge(this, speech);
        bridge.setUpdater(updater);
        web.addJavascriptInterface(bridge, "AndroidBus");

        setContentView(web);
        web.loadUrl("file:///android_asset/index.html");

        /* 首次启动：把「定位 + 通知」合并成一次权限请求。
           以前是申请定位后紧接着申请通知，Android 不允许连续弹两个权限框，
           第二个会被系统直接忽略 —— 表现就是「第一次打开只弹定位，
           第二次打开才弹通知」。一次申请全部，首次就能拿到通知权限。 */
        java.util.List<String> need = new java.util.ArrayList<String>();
        boolean needLoc = !Locator.hasPermission(this);
        if (needLoc) {
            need.add(Manifest.permission.ACCESS_FINE_LOCATION);
            need.add(Manifest.permission.ACCESS_COARSE_LOCATION);
        }
        boolean needNotify = android.os.Build.VERSION.SDK_INT >= 33 && !hasNotificationPermission();
        if (needNotify) need.add(Manifest.permission.POST_NOTIFICATIONS);

        if (!need.isEmpty()) {
            requestPermissions(need.toArray(new String[0]), 1001);
        } else {
            notifyPermission(true);
        }
        /* 已有通知权限（老用户升级 / 之前已授权）：也预热一次渠道，
           让系统通知设置里出现这两个渠道，用户能去开「锁屏显示」。 */
        if (hasNotificationPermission() && !notificationPrimed()) {
            setNotificationPrimed();
            if (bridge != null) bridge.primeNotificationChannels();
        }
    }

    /**
     * 补申请通知权限。
     *
     * <p>Android 13+ 的 POST_NOTIFICATIONS 如果被拒绝过两次，系统不会再弹窗，
     * 只能跳设置页手动开。这里先尝试直接申请（刚装的机器一般还能弹），
     * 拿不到就把 App 的通知设置页打开。</p>
     */
    void askNotificationPermission() {
        try {
            if (android.os.Build.VERSION.SDK_INT < 33) return;
            if (hasNotificationPermission()) {
                toastOnUi("通知权限已经有了");
                return;
            }
            if (shouldShowRequestPermissionRationale(Manifest.permission.POST_NOTIFICATIONS)) {
                requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 1002);
            } else {
                Intent intent = new Intent(
                        android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS);
                intent.putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, getPackageName());
                intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(intent);
                toastOnUi("请在系统设置里打开「允许通知」");
            }
        } catch (Throwable e) {
            android.util.Log.w("CdBusMain", "申请通知权限失败", e);
        }
    }

    /**
     * 直接打开「盯站通知」渠道的设置页。
     *
     * <p>小米/荣耀的「在锁定屏幕上显示通知」是 ROM 级的渠道开关，
     * Android API 没法替用户打开（不是运行时权限）。能做的是把用户
     * 一步带到这个渠道的设置页，而不是笼统的应用通知页——
     * 用户不用自己在长列表里翻「公交盯站（锁屏常驻）」这一条。</p>
     *
     * @param channelId 渠道 ID（盯站/下车提醒/到站提醒/心跳）
     */
    void openChannelSettings(String channelId) {
        try {
            Intent intent = new Intent(android.provider.Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS);
            intent.putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, getPackageName());
            intent.putExtra(android.provider.Settings.EXTRA_CHANNEL_ID, channelId);
            intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(intent);
            toastOnUi("请在本页打开「锁屏显示」，并允许声音/震动");
        } catch (Throwable e) {
            /* 个别 ROM 不认这个 action，退回应用通知设置页 */
            android.util.Log.w("CdBusMain", "打开渠道设置失败，退回应用通知页", e);
            try {
                Intent intent = new Intent(android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS);
                intent.putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, getPackageName());
                intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(intent);
            } catch (Throwable ignored) {
            }
        }
    }

    /**
     * 引导用户把本应用加入「电池优化白名单」。
     *
     * 国产 ROM（HyperOS/EMUI/ColorOS…）默认会在息屏后清理后台，
     * 前台服务也拦不住 —— 这是「锁屏就不播报」最常见的根因。
     * 用系统标准弹窗申请（用户点一次即可），不做静默申请。
     */
    void requestIgnoreBatteryOptimization() {
        try {
            if (android.os.Build.VERSION.SDK_INT < 23) return;
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm != null && pm.isIgnoringBatteryOptimizations(getPackageName())) {
                toastOnUi("已经在电池优化白名单里");
                return;
            }
            Intent intent = new Intent(android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
            intent.setData(android.net.Uri.parse("package:" + getPackageName()));
            startActivity(intent);
        } catch (Exception e) {
            // 有些 ROM 不支持这个 Action，退回打开电池优化列表
            try {
                startActivity(new Intent(android.provider.Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
            } catch (Exception ignored) {
            }
        }
    }

    private void toastOnUi(final String text) {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                android.widget.Toast.makeText(MainActivity.this, text, android.widget.Toast.LENGTH_SHORT).show();
            }
        });
    }

    private boolean hasNotificationPermission() {
        if (android.os.Build.VERSION.SDK_INT < 33) return true;
        return checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                == android.content.pm.PackageManager.PERMISSION_GRANTED;
    }

    /** 授权结果回传页面，让 JS 拿到权限后立刻重新定位。 */
    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode == 1002) return;   // 单独补申请的通知权限，不影响页面
        if (requestCode != 1001) return;
        /* 现在 1001 里可能有定位权限和通知权限混在一起。
           页面只关心定位：两个定位权限都拿到才通知页面去定位。
           通知权限由 WatchService/前台服务自己读，不靠这个回调。 */
        boolean locGranted = Locator.hasPermission(this);
        notifyPermission(locGranted);
        /* 首次拿到通知权限：预热两个常驻通知渠道（发一次 3 秒自停的通知），
           让用户在系统设置里能看到这两个渠道、去开「锁屏显示」。
           只做一次，用 SharedPreferences 记住，避免每次启动都弹通知。 */
        if (hasNotificationPermission() && !notificationPrimed()) {
            setNotificationPrimed();
            if (bridge != null) bridge.primeNotificationChannels();
        }
    }

    private void notifyPermission(boolean granted) {
        if (web == null) return;
        web.post(new Runnable() {
            @Override
            public void run() {
                web.evaluateJavascript(
                        "window.cdBusPermission && window.cdBusPermission(" + granted + ")", null);
            }
        });
    }

    /** 是否已预热过通知渠道（只做一次）。 */
    private boolean notificationPrimed() {
        try {
            return getSharedPreferences("cdbus_notify", MODE_PRIVATE)
                    .getBoolean("primed", false);
        } catch (Throwable e) { return false; }
    }

    private void setNotificationPrimed() {
        try {
            getSharedPreferences("cdbus_notify", MODE_PRIVATE)
                    .edit().putBoolean("primed", true).apply();
        } catch (Throwable ignored) {
        }
    }

    /**
     * 系统字体大小变化时不做任何事：App 字号由内部「设置 → 字体大小」控制。
     * 保留该方法是为了把事件消化掉，避免 Activity 被重建、页面重新加载。
     */
    @Override
    public void onConfigurationChanged(android.content.res.Configuration cfg) {
        super.onConfigurationChanged(cfg);
    }

    @Override
    public void onBackPressed() {
        // 返回键一律交给页面：页面自己维护视图栈，栈底时 moveTaskToBack 退回桌面（不杀进程）
        if (web != null) {
            web.evaluateJavascript("window.cdBusBackView && window.cdBusBackView()", null);
            return;
        }
        // WebView 还没准备好时的兜底：同样退到后台，不要结束进程
        moveTaskToBack(true);
    }

    @Override
    protected void onResume() {
        super.onResume();
        VISIBLE = true;
        // 从后台回到前台：让页面立刻刷新一次当前页面（不管停在哪一页）
        notifyResume();
    }

    /**
     * 通知页面「回到前台了」。页面收到后按当前所在视图各刷一次：
     * 首页刷附近站点、线路页刷车辆位置+到站卡、详情页刷车辆矩阵……
     * 放在 web.post 里，避免 onResume 时 WebView 还没准备好。
     */
    private void notifyResume() {
        if (web == null) return;
        web.post(new Runnable() {
            @Override
            public void run() {
                web.evaluateJavascript(
                        "window.cdBusResume && window.cdBusResume()", null);
            }
        });
    }

    @Override
    protected void onPause() {
        VISIBLE = false;
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        if (updater != null) {
            try { updater.shutdown(); } catch (Throwable ignored) {}
        }
        if (speech != null) speech.shutdown();
        if (web != null) {
            web.removeJavascriptInterface("AndroidBus");
            web.destroy();
        }
        super.onDestroy();
    }

    /* ------------------------------------------------------------ 自适应状态栏

       页面支持深色/浅色两套界面，系统状态栏和导航栏必须跟着变：
         - 浅色界面：状态栏刷成页面底色 #F4F6F9，图标转成深色（否则白字贴白底看不见）；
         - 深色界面：状态栏 #0B1220，图标转成浅色。
       Android 11（API 30）起用 WindowInsetsController 的 appearance 位，
       更老的版本退回 setSystemUiVisibility 的 LIGHT_STATUS_BAR / LIGHT_NAVIGATION_BAR。
       上一次的选择存在 SharedPreferences，启动时先按它刷一遍，避免闪一下深色。 */

    private static final String PREFS = "cdbus";
    private static final String PREF_LIGHT = "light";

    private boolean isLightModeSaved() {
        try {
            return getSharedPreferences(PREFS, MODE_PRIVATE).getBoolean(PREF_LIGHT, true);
        } catch (Exception e) {
            return true;                      /* App 默认浅色 */
        }
    }

    private static int barColor(boolean light) {
        return Color.parseColor(light ? "#F4F6F9" : "#0B1220");
    }

    /** 把状态栏/导航栏刷成当前界面模式。必须在 UI 线程。 */
    public void applySystemBar(final boolean light) {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    int bg = barColor(light);
                    android.view.Window w = getWindow();
                    w.setStatusBarColor(bg);
                    w.setNavigationBarColor(bg);
                    if (web != null) web.setBackgroundColor(bg);

                    if (Build.VERSION.SDK_INT >= 30) {
                        WindowInsetsController c = w.getInsetsController();
                        if (c != null) {
                            int mask = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                                    | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                            c.setSystemBarsAppearance(light ? mask : 0, mask);
                        }
                    } else {
                        View decor = w.getDecorView();
                        int flags = decor.getSystemUiVisibility();
                        if (light) flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
                        else flags &= ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
                        if (Build.VERSION.SDK_INT >= 26) {
                            if (light) flags |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
                            else flags &= ~View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
                        }
                        decor.setSystemUiVisibility(flags);
                    }
                } catch (Throwable t) {
                    Log.w("CdBus", "设置系统栏失败", t);
                }
            }
        });
    }

    /** 页面切明暗时调这里：立即生效并记下来，下次启动直接用。 */
    public void setUiMode(boolean light) {
        try {
            getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean(PREF_LIGHT, light).apply();
        } catch (Exception e) {
            Log.w("CdBus", "保存明暗模式失败", e);
        }
        applySystemBar(light);
    }
}