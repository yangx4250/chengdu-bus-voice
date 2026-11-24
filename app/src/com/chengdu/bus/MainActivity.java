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

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);

        speech = new Speech(this);

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
        web.setBackgroundColor(Color.parseColor("#0B1220"));

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

        bridge = new BusBridge(this, speech);
        web.addJavascriptInterface(bridge, "AndroidBus");

        setContentView(web);
        web.loadUrl("file:///android_asset/index.html");

        if (!Locator.hasPermission(this)) {
            requestPermissions(new String[]{
                    Manifest.permission.ACCESS_FINE_LOCATION,
                    Manifest.permission.ACCESS_COARSE_LOCATION
            }, 1001);
        } else {
            notifyPermission(true);
        }

        // Android 13+ 需要单独申请通知权限（前台服务通知要用）
        if (android.os.Build.VERSION.SDK_INT >= 33 && !hasNotificationPermission()) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 1002);
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
        if (requestCode == 1002) return;   // 通知权限，不影响页面
        if (requestCode != 1001) return;
        boolean granted = false;
        for (int result : results) {
            if (result == android.content.pm.PackageManager.PERMISSION_GRANTED) granted = true;
        }
        notifyPermission(granted);
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
        if (speech != null) speech.shutdown();
        if (web != null) {
            web.removeJavascriptInterface("AndroidBus");
            web.destroy();
        }
        super.onDestroy();
    }
}