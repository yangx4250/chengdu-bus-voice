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

    /** 仓库。GitHub 与 Gitee 同名，改仓库时两处都要改。 */
    private static final String GH_REPO = "yangx4250/chengdu-bus-voice";
    private static final String GT_REPO = "yangxiao436426/chengdu-bus-voice";
    private static final String APK_NAME = "chengdu-bus-latest.apk";

    /**
     * 更新源，按顺序尝试。
     *
     * <p>为什么 Gitee 排第一：实测国内直连 github.com 会超时（12s 无响应），
     * 而 gitee.com 0.7s 可用。GitHub 直连放最后，给有梯子的场景用。</p>
     *
     * <p>代理（gh-proxy / ghfast）实测能完整取到 755666 字节的包，但它们
     * 是第三方公共服务，可能限速或投毒 —— 所以下载后必须做签名校验，
     * 见 {@link #verifyApkSignature(File)}。</p>
     */
    private static final String[] DOWNLOAD_SOURCES = {
        "https://gitee.com/" + GT_REPO + "/releases/download/LATEST_TAG/" + APK_NAME,
        "https://gh-proxy.com/https://github.com/" + GH_REPO + "/releases/latest/download/" + APK_NAME,
        "https://ghfast.top/https://github.com/" + GH_REPO + "/releases/latest/download/" + APK_NAME,
        "https://github.com/" + GH_REPO + "/releases/latest/download/" + APK_NAME,
    };

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
    /** 最近一次检查得到的下载地址（Gitee 的，带 tag，优先用）。 */
    private volatile String lastDownloadUrl = "";
    /** 最近一次检查到的 tag，用于拼 Gitee 的确定路径（检查没跑过则为空）。 */
    private volatile String lastTag = "";

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
                    Release rel = fetchLatest();
                    if (rel == null) {
                        emit(listener, "error", msg("检查更新失败：所有更新源都不可达"));
                        return;
                    }
                    /* 统一用 versionName 比较 —— versionCode 是自增序号，
                       和语义版本号不同量纲，混比会误判（见 normalize 的注释）。 */
                    int remote = normalize(rel.tag);
                    int local = normalize(currentVersionName());
                    JSONObject data = new JSONObject();
                    data.put("latest", rel.tag);
                    data.put("current", currentVersionName());
                    data.put("currentCode", local);
                    data.put("latestCode", remote);
                    data.put("hasUpdate", remote > local);
                    data.put("url", rel.downloadUrl);
                    data.put("source", rel.source);
                    /* 记住这次检查到的地址和 tag，下载时优先用 */
                    lastDownloadUrl = rel.downloadUrl;
                    lastTag = rel.tag;
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
     * 取最新版本信息，按源顺序尝试。
     *
     * <p>三个源各自的取法不同：</p>
     * <ul>
     *   <li><b>Gitee API</b>：`/repos/{owner}/{repo}/releases` 返回列表，
     *       取第一个的 tag_name。公开仓库不需要 token、不限流。</li>
     *   <li><b>GitHub 重定向</b>：`releases/latest` 的 302 Location 里是 tag。
     *       不用 API 是因为未认证 60 次/小时就被 403。</li>
     *   <li><b>代理</b>：代理转发 GitHub 的重定向，取法同 GitHub。</li>
     * </ul>
     *
     * @return {tag, downloadUrl} 或 null（全部失败）
     */
    private Release checkFromGitee() {
        HttpURLConnection conn = null;
        try {
            /* 注意：Gitee 的 releases 列表按创建时间**正序**返回（最老的排前面），
               和 GitHub 相反。实测 v1.3.1 排在 v1.3.2 之前，取 [0] 会拿到旧版本，
               用户就永远收不到更新。所以这里按版本号挑最大的。

               per_page 必须够大：本项目 release 已超过 20 条，用 20 时第一页只到
               v1.5.0，最新的 v1.6.x 全在第二页之后 —— 结果就是「最新版本 v1.5.0、
               当前 1.6.6 却显示已是最新」。Gitee 单页上限 100，当前 28 条一页够用。 */
            String url = "https://gitee.com/api/v5/repos/" + GT_REPO + "/releases?page=1&per_page=100";
            conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setConnectTimeout(CONNECT_TIMEOUT);
            conn.setReadTimeout(READ_TIMEOUT);
            conn.setRequestMethod("GET");
            conn.setRequestProperty("User-Agent", "cdbus-updater");
            if (conn.getResponseCode() != 200) return null;
            String body = readAll(conn.getInputStream());
            org.json.JSONArray arr = new org.json.JSONArray(body);
            if (arr.length() == 0) return null;

            /* 挑版本号最大的那条（跳过 prerelease） */
            org.json.JSONObject rel = null;
            int best = -1;
            for (int i = 0; i < arr.length(); i++) {
                org.json.JSONObject r = arr.getJSONObject(i);
                if (r.optBoolean("prerelease", false)) continue;
                String t = r.optString("tag_name", "");
                int v = normalize(t);
                if (v > best) { best = v; rel = r; }
            }
            if (rel == null) return null;
            String tag = rel.optString("tag_name", "");
            if (tag.isEmpty()) return null;
            /* 附件里找 APK */
            String url2 = "https://gitee.com/" + GT_REPO + "/releases/download/"
                    + tag + "/" + APK_NAME;
            /* 有 attach_files 就用它给的地址，否则用约定路径 */
            org.json.JSONArray assets = rel.optJSONArray("assets");
            if (assets != null) {
                for (int i = 0; i < assets.length(); i++) {
                    org.json.JSONObject a = assets.getJSONObject(i);
                    if (APK_NAME.equals(a.optString("name"))) {
                        String u2 = a.optString("browser_download_url", "");
                        if (!u2.isEmpty()) url2 = u2;
                        break;
                    }
                }
            }
            return new Release(tag, url2, "gitee");
        } catch (Throwable e) {
            Log.w(TAG, "Gitee 检查失败", e);
            return null;
        } finally {
            if (conn != null) try { conn.disconnect(); } catch (Throwable ignored) {}
        }
    }

    /** GitHub 的 latest 重定向（可经代理）。 */
    private Release checkFromGithubRedirect(String base) {
        HttpURLConnection conn = null;
        try {
            String url = base + "https://github.com/" + GH_REPO + "/releases/latest";
            conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setInstanceFollowRedirects(false);
            conn.setConnectTimeout(CONNECT_TIMEOUT);
            conn.setReadTimeout(READ_TIMEOUT);
            conn.setRequestMethod("GET");
            conn.setRequestProperty("User-Agent", "cdbus-updater");
            int code = conn.getResponseCode();
            String location = conn.getHeaderField("Location");
            String tag = null;
            if (code >= 300 && code < 400 && location != null) {
                int idx = location.indexOf("/releases/tag/");
                if (idx >= 0) {
                    tag = location.substring(idx + "/releases/tag/".length());
                    int cut = tag.indexOf('?');
                    if (cut > 0) tag = tag.substring(0, cut);
                    tag = tag.trim();
                }
            }
            if (tag == null || tag.isEmpty()) return null;
            String dl = base + "https://github.com/" + GH_REPO
                    + "/releases/latest/download/" + APK_NAME;
            return new Release(tag, dl, base.isEmpty() ? "github" : "proxy");
        } catch (Throwable e) {
            Log.w(TAG, "GitHub 检查失败（" + (base.isEmpty() ? "直连" : "代理") + "）", e);
            return null;
        } finally {
            if (conn != null) try { conn.disconnect(); } catch (Throwable ignored) {}
        }
    }

    /** 按 Gitee → 代理 → GitHub 直连的顺序检查。 */
    private Release fetchLatest() {
        /* 首次检测固定走 Gitee —— 国内直连可用（实测 0.5s），
           不依赖第三方代理，也不需要梯子。后面的代理/GitHub 只是兜底。 */
        Log.i(TAG, "首次检测：Gitee");
        Release r = checkFromGitee();
        if (r != null) {
            Log.i(TAG, "Gitee 命中：" + r.tag);
            return r;
        }
        Log.w(TAG, "Gitee 不可用，退到 GitHub 代理");

        r = checkFromGithubRedirect("https://gh-proxy.com/");
        if (r != null) return r;
        r = checkFromGithubRedirect("https://ghfast.top/");
        if (r != null) return r;
        return checkFromGithubRedirect("");
    }

    /** 版本检查结果。 */
    static final class Release {
        final String tag;
        final String downloadUrl;
        final String source;

        Release(String tag, String downloadUrl, String source) {
            this.tag = tag;
            this.downloadUrl = downloadUrl;
            this.source = source;
        }
    }

    private static String readAll(InputStream in) throws java.io.IOException {
        try {
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return out.toString("UTF-8");
        } finally {
            try { in.close(); } catch (Throwable ignored) {}
        }
    }

    /**
     * 下载并准备安装。
     *
     * <p>按 {@link #DOWNLOAD_SOURCES} 顺序尝试，任何一个成功就停。
     * 下完必须通过 {@link #verifyApkSignature(File)} —— 第三方代理由其
     * 不可信，签名校验是唯一能挡住「代理返回投毒包」的手段。</p>
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
                try {
                    /* 优先用检查阶段拿到的地址（Gitee 带 tag，最准）。
                       检查没跑过（lastDownloadUrl 空）时，DOWNLOAD_SOURCES 的第一条
                       就是 Gitee 的固定路径，所以仍会先试 Gitee。 */
                    /* 下载源顺序：Gitee 永远第一。
                       以前 DOWNLOAD_SOURCES 里 Gitee 那条带 "LATEST_TAG" 占位符，
                       会被下面的过滤条件跳过 —— 如果用户没先点「检查更新」就点下载，
                       Gitee 根本不会被尝试，直接跳到第三方代理。现在用真实 tag 拼。 */
                    java.util.List<String> urls = new java.util.ArrayList<>();
                    java.util.Set<String> seenUrl = new java.util.HashSet<>();

                    /* ① 检查阶段拿到的确切地址 */
                    String first = lastDownloadUrl;
                    if (first != null && !first.isEmpty() && seenUrl.add(first)) {
                        urls.add(first);
                    }
                    /* ② 用已知 tag 拼 Gitee 的确定路径（仓库名、文件名都是固定的） */
                    if (lastTag != null && !lastTag.isEmpty()) {
                        String giteeUrl = "https://gitee.com/" + GT_REPO
                                + "/releases/download/" + lastTag + "/" + APK_NAME;
                        if (seenUrl.add(giteeUrl)) urls.add(giteeUrl);
                    }
                    /* ③ 兜底：代理和 GitHub 直连 */
                    for (String u : DOWNLOAD_SOURCES) {
                        if (u == null || u.isEmpty() || u.contains("LATEST_TAG")) continue;
                        if (seenUrl.add(u)) urls.add(u);
                    }

                    File dir = ApkProvider.dir(activity);
                    File apk = new File(dir, APK_NAME);
                    File part = new File(dir, APK_NAME + ".part");

                    String lastErr = "";
                    for (int i = 0; i < urls.size(); i++) {
                        if (cancelled) {
                            emit(listener, "error", msg("已取消"));
                            return;
                        }
                        String url = urls.get(i);
                        try {
                            JSONObject d = new JSONObject();
                            d.put("source", url);
                            d.put("index", i);
                            emit(listener, "source", d);

                            if (part.exists()) {
                                //noinspection ResultOfMethodCallIgnored
                                part.delete();
                            }
                            long total = downloadOne(url, part, listener);
                            if (total < 0) {          // 取消
                                return;
                            }
                            if (total == 0) {
                                lastErr = "下载失败";
                                continue;
                            }

                            /* 大小校验 */
                            long size = part.length();
                            if (total > 0 && size != total) {
                                lastErr = "下载不完整 " + size + "/" + total;
                                continue;
                            }
                            if (!isZip(part)) {
                                lastErr = "不是有效安装包";
                                continue;
                            }

                            JSONObject vd = new JSONObject();
                            vd.put("size", size);
                            emit(listener, "verifying", vd);

                            /* 签名校验：必须和已安装的一致，否则装不上、也可能是投毒 */
                            String sigErr = verifyApkSignature(part);
                            if (sigErr != null) {
                                lastErr = sigErr;
                                continue;
                            }

                            if (apk.exists()) {
                                //noinspection ResultOfMethodCallIgnored
                                apk.delete();
                            }
                            if (!part.renameTo(apk)) {
                                lastErr = "保存失败";
                                continue;
                            }

                            JSONObject rd = new JSONObject();
                            rd.put("path", apk.getAbsolutePath());
                            rd.put("size", apk.length());
                            rd.put("sha256", sha256(apk));
                            rd.put("source", url);
                            emit(listener, "ready", rd);
                            return;
                        } catch (Throwable e) {
                            lastErr = e.getMessage() == null ? e.toString() : e.getMessage();
                            Log.w(TAG, "源失败：" + url, e);
                        }
                    }
                    emit(listener, "error", msg("所有更新源都失败：" + lastErr));
                } finally {
                    busy.set(false);
                }
            }
        });
    }

    /**
     * 从单个 URL 下载到 part 文件。
     *
     * @return 总字节数；0 表示这个源失败（调用方换下一个）；-1 表示用户取消
     */
    private long downloadOne(String url, File part, Listener listener) throws Exception {
        HttpURLConnection conn = null;
        FileOutputStream out = null;
        InputStream in = null;
        try {
            conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setInstanceFollowRedirects(true);
            conn.setConnectTimeout(CONNECT_TIMEOUT);
            conn.setReadTimeout(READ_TIMEOUT);
            conn.setRequestProperty("User-Agent", "cdbus-updater");
            int code = conn.getResponseCode();
            if (code != 200) {
                Log.w(TAG, "HTTP " + code + " @ " + url);
                return 0;
            }
            long total = conn.getContentLength();
            in = conn.getInputStream();
            out = new FileOutputStream(part);
            byte[] buf = new byte[8192];
            long done = 0;
            int lastPercent = -1;
            long lastEmit = 0;
            int n;
            while ((n = in.read(buf)) > 0) {
                if (cancelled) {
                    emit(listener, "error", msg("已取消"));
                    //noinspection ResultOfMethodCallIgnored
                    part.delete();
                    return -1;
                }
                out.write(buf, 0, n);
                done += n;
                if (total > 0) {
                    int percent = (int) (done * 100 / total);
                    long now = System.currentTimeMillis();
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
            return total > 0 ? total : part.length();
        } finally {
            if (out != null) try { out.close(); } catch (Throwable ignored) {}
            if (in != null) try { in.close(); } catch (Throwable ignored) {}
            if (conn != null) try { conn.disconnect(); } catch (Throwable ignored) {}
        }
    }

    /**
     * 校验下载到的 APK 签名是否与本机已安装的一致。
     *
     * <p>为什么用签名而不是硬编码 SHA-256：包每版都变，硬编码哈希要每版改代码。
     * 签名证书是固定的（本项目 keystore 不变），校验它既省事又能挡住投毒 ——
     * 第三方代理返回的假包签名必然不同。</p>
     *
     * @return null 表示通过；否则返回错误说明
     */
    private String verifyApkSignature(File apk) {
        try {
            android.content.pm.PackageManager pm = activity.getPackageManager();
            int flags = Build.VERSION.SDK_INT >= 28
                    ? android.content.pm.PackageManager.GET_SIGNING_CERTIFICATES
                    : android.content.pm.PackageManager.GET_SIGNATURES;

            /* 下载包的签名 */
            android.content.pm.PackageInfo remote = pm.getPackageArchiveInfo(apk.getAbsolutePath(), flags);
            if (remote == null) return "安装包无法解析";
            if (!activity.getPackageName().equals(remote.packageName)) {
                return "包名不符：" + remote.packageName;
            }

            /* 本机已安装的签名 */
            android.content.pm.PackageInfo local = pm.getPackageInfo(activity.getPackageName(), flags);
            String a = signatureOf(local);
            String b = signatureOf(remote);
            if (a == null || a.isEmpty()) return "读不到本机签名";
            if (b == null || b.isEmpty()) return "读不到安装包签名";
            if (!a.equals(b)) return "签名不一致（可能被篡改）";
            return null;
        } catch (Throwable e) {
            return "签名校验失败：" + e.getMessage();
        }
    }

    /** 取包信息的签名摘要（hex）。 */
    private static String signatureOf(android.content.pm.PackageInfo info) {
        try {
            byte[] bytes;
            if (Build.VERSION.SDK_INT >= 28) {
                android.content.pm.SigningInfo si = info.signingInfo;
                if (si == null) return null;
                android.content.pm.Signature[] sigs = si.getApkContentsSigners();
                if (sigs == null || sigs.length == 0) return null;
                bytes = sigs[0].toByteArray();
            } else {
                android.content.pm.Signature[] sigs = info.signatures;
                if (sigs == null || sigs.length == 0) return null;
                bytes = sigs[0].toByteArray();
            }
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            StringBuilder sb = new StringBuilder();
            for (byte x : md.digest(bytes)) sb.append(String.format("%02x", x));
            return sb.toString();
        } catch (Throwable e) {
            return null;
        }
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
