package com.chengdu.bus;

import android.Manifest;
import android.app.Activity;
import android.graphics.Color;
import android.os.Bundle;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * 单页壳：界面全部在 assets/index.html 里，Java 只负责网络、解密、播报和定位。
 */
public final class MainActivity extends Activity {

    /** 供前台服务判断：界面当前是否可见（可见时由页面自己播，服务不抢）。 */
    public static volatile boolean VISIBLE = false;

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
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setSupportZoom(false);
        settings.setMediaPlaybackRequiresUserGesture(false);
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

        web.setWebViewClient(new WebViewClient());

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

    @Override
    public void onBackPressed() {
        // 返回键一律交给页面：页面自己维护视图栈，栈底时才回退退出
        if (web != null) {
            web.evaluateJavascript("window.cdBusBackView && window.cdBusBackView()", null);
            return;
        }
        super.onBackPressed();
    }

    @Override
    protected void onResume() {
        super.onResume();
        VISIBLE = true;
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