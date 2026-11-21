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
    }

    /** 授权结果回传页面，让 JS 拿到权限后立刻重新定位。 */
    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
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
        // 详情页 / 地铁页里按返回：先回首页，而不是退出 App
        if (bridge != null && !"home".equals(bridge.currentView()) && web != null) {
            web.evaluateJavascript("window.cdBusBackView && window.cdBusBackView()", null);
            return;
        }
        if (web != null && web.canGoBack()) {
            web.goBack();
        } else {
            super.onBackPressed();
        }
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