package com.chengdu.bus;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.util.Log;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * 在线更新：查最新版本 → 下载 APK → 校验 → 交给系统安装器。
 *
 * <p><b>为什么不走 GitHub API</b>：未认证请求限流 60 次/小时/IP，实测直接被
 * 403 拒掉。改用 `releases/latest` 的 302 重定向 —— Location 里就是最新 tag，
 * 不限流、不需要 token。下载用 `releases/latest/download/<文件名>` 固定地址，
 * 永远指向最新版，版本升级后也不用改代码。</p>
 *
 * <p>安装流程（Android 8+）：</p>
 * <ol>
 *   <li>必须有 REQUEST_INSTALL_PACKAGES 权限声明；</li>
 *   <li>用户要为**本应用**单独授权「安装未知应用」，没授权就跳系统设置页；</li>
 *   <li>APK 放在私有目录，通过自写的 ApkProvider 转成 content:// URI，</li>
 * </ol>
 *
 * <p>另外：整个过程不弹 Toast 骚扰，进度通过 {@link Listener} 回调给页面，
 * 由页面自己渲染进度条。</p>
 */
public final class Updater {

    private static final String TAG = "CdBusUpdate";

    /** 仓库地址。改仓库时只改这两行。 */
    private static final String REPO = "yangx4250/chengdu-bus-voice";
    private static final String APK_NAME = "chengdu-bus-latest.apk";

    private static final String LATEST_PAGE =
            "https://github.com/" + REPO + "/releases/latest";
    /** 固定地址：GitHub 会自动跳到最新 release 的该文件名。 */
    private static final String DOWNLOAD_URL =
            "https://github.com/" + REPO + "/releases/latest/download/" + APK_NAME;

    /** 下载超时。整包 700KB 左右，30 秒足够；慢网也不至于卡死。 */
    private static final int CONNECT_TIMEOUT = 15000;
    private static final int READ_TIMEOUT = 30000;

    /** 进度回调（在后台线程调用，页面自己转主线程）。 */
    public interface Listener {
        void onState(String state, JSONObject data);
    }

    private final Activity activity;
    private final ExecutorService pool = Executors.newSingleThreadExecutor();
    private final AtomicBoolean busy = new AtomicBoolean(false);
    private volatile boolean cancelled = false;

    public Updater(Activity activity) {
        this.activity = activity;
    }

    public void shutdown() {
        cancelled = true;
        try { pool.shutdownNow(); } catch (Throwable ignored) {}
    }

    /** 当前安装的 versionCode。 */
    public int currentVersionCode() {
        try {
            PackageInfo info = activity.getPackageManager()
                    .getPackageInfo(activity.getPackageName(), 0);
            if (Build.VERSION.SDK_INT >= 28) return (int) info.getLongVersionCode();
            return info.versionCode;
        } catch (Exception e) {
            return 0;
        }
    }

    public String currentVersionName() {
        try {
            PackageInfo info = activity.getPackageManager()
                    .getPackageInfo(activity.getPackageName(), 0);
            return info.versionName == null ? "" : info.versionName;
        } catch (Exception e) {
            return "";
        }
    }

    /**
     * 把版本字符串解析成可比较数字。
     *
     * <p><b>必须用 versionName，不能用 versionCode</b>：本项目的历史 versionCode
     * 是自增序号（160、170…189），和 tag 解析出来的 10208 完全不是一个量纲，
     * 混着比会永远判成「有新版」。所以统一把 versionName（1.2.8）解析成
     * 10208 再比。</p>
     */
    static int normalize(String v) {
        if (v == null) return 0;
        String s = v.trim();
        if (s.startsWith("v") || s.startsWith("V")) s = s.substring(1);
        String[] parts = s.split("\\.");
        int[] nums = new int[3];
        for (int i = 0; i < parts.length && i < 3; i++) {
            try {
                nums[i] = Integer.parseInt(parts[i].replaceAll("[^0-9].*$", ""));
            } catch (NumberFormatException e) {
                nums[i] = 0;
            }
        }
        return nums[0] * 10000 + nums[1] * 100 + nums[2];
    }

    /** 把 "v1.2.9" 解析成 10209 这样的可比较数字。解析不出来返回 0。 */
    static int parseVersionCode(String tag) {
        if (tag == null) return 0;
        String s = tag.trim();
        if (s.startsWith("v") || s.startsWith("V")) s = s.substring(1);
        String[] parts = s.split("\\.");
        int[] nums = new int[3];
        for (int i = 0; i < parts.length && i < 3; i++) {
            try {
                nums[i] = Integer.parseInt(parts[i].replaceAll("[^0-9].*$", ""));
            } catch (NumberFormatException e) {
                nums[i] = 0;
            }
        }
        return nums[0] * 10000 + nums[1] * 100 + nums[2];
    }

    /**
     * 检查是否有新版。<b>不联网也能安全失败</b>：任何异常都当作「没有更新」，
     * 绝不能因为网络问题影响 App 正常使用。
     *
     * @param silent true 表示启动时的静默检查（没新版就什么都不做）
     */
    public void check(final boolean silent, final Listener listener) {
        if (!busy.compareAndSet(false, true)) {
            emit(listener, "busy", null);
            return;
        }
        cancelled = false;
        pool.execute(new Runnable() {
            @Override
            public void run() {
                try {
                    String tag = fetchLatestTag();
                    if (tag == null) {
                        emit(listener, "error", msg("检查更新失败：拿不到版本信息"));
                        return;
                    }
                    /* 统一用 versionName 比较 —— versionCode 是自增序号，
                       和语义版本号不同量纲，混比会误判（见 normalize 的注释）。 */
                    int remote = normalize(tag);
                    int local = normalize(currentVersionName());
                    JSONObject data = new JSONObject();
                    data.put("latest", tag);
                    data.put("current", currentVersionName());
                    data.put("currentCode", local);
                    data.put("latestCode", remote);
                    data.put("hasUpdate", remote > local);
                    data.put("url", DOWNLOAD_URL);
                    emit(listener, "checked", data);
                } catch (Throwable e) {
                    Log.w(TAG, "检查更新失败", e);
                    emit(listener, "error", msg("检查更新失败：" + e.getMessage()));
                } finally {
                    busy.set(false);
                }
            }
        });
    }

    /**
     * 读最新 tag。
     *
     * <p>用 HEAD 请求跟随重定向太脆（有些 CDN 不返回 HEAD），这里用 GET 但
     * 只读响应头、不下载正文：看到 30x 的 Location 就立刻断开，
     * 拿到 /releases/tag/vX.Y.Z 里的字符串。</p>
     */
    private String fetchLatestTag() {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(LATEST_PAGE).openConnection();
            conn.setInstanceFollowRedirects(false);
            conn.setConnectTimeout(CONNECT_TIMEOUT);
            conn.setReadTimeout(READ_TIMEOUT);
            conn.setRequestMethod("GET");
            conn.setRequestProperty("User-Agent", "cdbus-updater");
            int code = conn.getResponseCode();
            String location = conn.getHeaderField("Location");
            if (code >= 300 && code < 400 && location != null) {
                int idx = location.indexOf("/releases/tag/");
                if (idx >= 0) {
                    String tag = location.substring(idx + "/releases/tag/".length());
                    int cut = tag.indexOf('?');
                    if (cut > 0) tag = tag.substring(0, cut);
                    return tag.trim();
                }
            }
            /* 没有重定向：说明 latest 已经是当前页，直接用最终 URL 里解析 */
            String finalUrl = conn.getURL().toString();
            int idx2 = finalUrl.indexOf("/releases/tag/");
            if (idx2 >= 0) return finalUrl.substring(idx2 + "/releases/tag/".length()).trim();
            return null;
        } catch (Throwable e) {
            Log.w(TAG, "取最新版本失败", e);
            return null;
        } finally {
            if (conn != null) {
                try { conn.disconnect(); } catch (Throwable ignored) {}
            }
        }
    }

    /**
     * 下载并准备安装。失败/取消都会回调 state。
     *
     * @param listener 进度回调：downloading(percent) / verifying / ready / error
     */
    public void downloadAndInstall(final Listener listener) {
        if (!busy.compareAndSet(false, true)) {
            emit(listener, "busy", null);
            return;
        }
        cancelled = false;
        pool.execute(new Runnable() {
            @Override
            public void run() {
                File part = null;
                try {
                    File dir = ApkProvider.dir(activity);
                    File apk = new File(dir, APK_NAME);
                    part = new File(dir, APK_NAME + ".part");
                    if (part.exists()) {
                        //noinspection ResultOfMethodCallIgnored
                        part.delete();
                    }

                    HttpURLConnection conn = (HttpURLConnection) new URL(DOWNLOAD_URL).openConnection();
                    conn.setInstanceFollowRedirects(true);
                    conn.setConnectTimeout(CONNECT_TIMEOUT);
                    conn.setReadTimeout(READ_TIMEOUT);
                    conn.setRequestProperty("User-Agent", "cdbus-updater");
                    int code = conn.getResponseCode();
                    if (code != 200) {
                        emit(listener, "error", msg("下载失败：HTTP " + code));
                        return;
                    }
                    long total = conn.getContentLength();
                    InputStream in = conn.getInputStream();
                    FileOutputStream out = new FileOutputStream(part);
                    byte[] buf = new byte[8192];
                    long done = 0;
                    int lastPercent = -1;
                    long lastEmit = 0;
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        if (cancelled) {
                            out.close();
                            in.close();
                            //noinspection ResultOfMethodCallIgnored
                            part.delete();
                            conn.disconnect();
                            emit(listener, "error", msg("已取消"));
                            return;
                        }
                        out.write(buf, 0, n);
                        done += n;
                        if (total > 0) {
                            int percent = (int) (done * 100 / total);
                            long now = System.currentTimeMillis();
                            /* 进度别刷太勤：变化 >=1% 且间隔 >=200ms 才回调一次 */
                            if (percent != lastPercent && (now - lastEmit >= 200 || percent == 100)) {
                                lastPercent = percent;
                                lastEmit = now;
                                JSONObject d = new JSONObject();
                                d.put("percent", percent);
                                d.put("done", done);
                                d.put("total", total);
                                emit(listener, "downloading", d);
                            }
                        }
                    }
                    out.flush();
                    out.close();
                    in.close();
                    conn.disconnect();

                    /* 大小校验：Content-Length 和实际字节数对不上就是半截包 */
                    long size = part.length();
                    if (total > 0 && size != total) {
                        //noinspection ResultOfMethodCallIgnored
                        part.delete();
                        emit(listener, "error", msg("下载不完整：" + size + "/" + total + " 字节"));
                        return;
                    }
                    /* 粗校验：APK 是 zip，前两个字节必须是 PK */
                    if (!isZip(part)) {
                        //noinspection ResultOfMethodCallIgnored
                        part.delete();
                        emit(listener, "error", msg("下载的文件不是有效安装包"));
                        return;
                    }

                    JSONObject vd = new JSONObject();
                    vd.put("size", size);
                    emit(listener, "verifying", vd);

                    /* 换名：先删旧的，再把 .part 挪正 */
                    if (apk.exists()) {
                        //noinspection ResultOfMethodCallIgnored
                        apk.delete();
                    }
                    if (!part.renameTo(apk)) {
                        emit(listener, "error", msg("安装包保存失败"));
                        return;
                    }

                    JSONObject rd = new JSONObject();
                    rd.put("path", apk.getAbsolutePath());
                    rd.put("size", apk.length());
                    rd.put("sha256", sha256(apk));
                    emit(listener, "ready", rd);
                } catch (Throwable e) {
                    Log.w(TAG, "下载失败", e);
                    if (part != null && part.exists()) {
                        //noinspection ResultOfMethodCallIgnored
                        part.delete();
                    }
                    emit(listener, "error", msg("下载失败：" + e.getMessage()));
                } finally {
                    busy.set(false);
                }
            }
        });
    }

    /** 取消当前下载。 */
    public void cancel() {
        cancelled = true;
    }

    private static boolean isZip(File f) {
        InputStream in = null;
        try {
            in = new java.io.FileInputStream(f);
            int a = in.read();
            int b = in.read();
            return a == 'P' && b == 'K';
        } catch (Throwable e) {
            return false;
        } finally {
            if (in != null) try { in.close(); } catch (Throwable ignored) {}
        }
    }

    /** 算 SHA-256，供页面显示、也方便用户核对 GitHub 上公布的哈希。 */
    static String sha256(File f) {
        InputStream in = null;
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            in = new java.io.FileInputStream(f);
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) md.update(buf, 0, n);
            StringBuilder sb = new StringBuilder();
            for (byte b : md.digest()) sb.append(String.format("%02x", b));
            return sb.toString();
        } catch (Throwable e) {
            return "";
        } finally {
            if (in != null) try { in.close(); } catch (Throwable ignored) {}
        }
    }

    /** 本应用是否被允许安装未知来源应用。 */
    public boolean canInstall() {
        if (Build.VERSION.SDK_INT < 26) return true;   // 8.0 之前没有这个开关
        try {
            return activity.getPackageManager().canRequestPackageInstalls();
        } catch (Throwable e) {
            return false;
        }
    }

    /** 跳到「安装未知应用」授权页。返回后需要重新检查 canInstall()。 */
    public void openInstallPermission() {
        if (Build.VERSION.SDK_INT < 26) return;
        try {
            Intent i = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + activity.getPackageName()));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            activity.startActivity(i);
        } catch (Throwable e) {
            Log.w(TAG, "打开安装权限页失败", e);
        }
    }

    /**
     * 触发系统安装界面。
     *
     * <p>用自写 ApkProvider 生成 content:// URI，并临时授予该包读取权限 ——
     * Android 7+ 不允许 file://，否则抛 FileUriExposedException。</p>
     *
     * @return 是否成功发起
     */
    public boolean install() {
        File dir = ApkProvider.dir(activity);
        File apk = new File(dir, APK_NAME);
        if (!apk.exists()) {
            Log.w(TAG, "安装包不存在");
            return false;
        }
        try {
            Uri uri = ApkProvider.uriFor(activity, apk);
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(uri, "application/vnd.android.package-archive");
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            activity.startActivity(intent);
            return true;
        } catch (Throwable e) {
            Log.w(TAG, "发起安装失败", e);
            return false;
        }
    }

    /** 当前已下载的安装包信息（有就返回）。 */
    public JSONObject downloadedApk() {
        try {
            File apk = new File(ApkProvider.dir(activity), APK_NAME);
            if (!apk.exists()) return null;
            JSONObject o = new JSONObject();
            o.put("path", apk.getAbsolutePath());
            o.put("size", apk.length());
            o.put("mtime", apk.lastModified());
            return o;
        } catch (Throwable e) {
            return null;
        }
    }

    private static JSONObject msg(String text) {
        try {
            return new JSONObject().put("message", text == null ? "" : text);
        } catch (Throwable e) {
            return new JSONObject();
        }
    }

    private void emit(Listener l, String state, JSONObject data) {
        if (l == null) return;
        try {
            l.onState(state, data);
        } catch (Throwable e) {
            Log.w(TAG, "回调异常", e);
        }
    }
}
