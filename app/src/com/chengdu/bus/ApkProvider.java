package com.chengdu.bus;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import android.util.Log;

import java.io.File;
import java.io.FileNotFoundException;

/**
 * 极简 FileProvider：把 App 私有目录里的安装包暴露成 content:// URI。
 *
 * <p>为什么自己写而不是用 androidx.core.content.FileProvider：
 * 这个项目是「javac + aapt + r8」手工构建，零第三方依赖。引入 androidx 会
 * 破坏构建方式、还要处理 R 资源和 AAR 合并，代价远大于自己实现这几十行。</p>
 *
 * <p>Android 7+ 不允许把 file:// URI 交给系统安装器（FileUriExposedException），
 * 必须用 content:// 并临时授权。这里只开放一个目录（cacheDir/update），
 * 且只允许读取，路径经过规范化校验，防止 ../ 穿越到别的目录。</p>
 */
public final class ApkProvider extends ContentProvider {

    private static final String TAG = "CdBusApk";

    /** 与 AndroidManifest 里的 authorities 一致。 */
    public static final String AUTHORITY = "com.chengdu.bus.apkprovider";

    /** 安装包存放的子目录（在 cacheDir 下）。 */
    public static final String DIR = "update";

    @Override
    public boolean onCreate() {
        return true;
    }

    /** 取安装包目录；不存在就建出来。 */
    public static File dir(Context context) {
        File d = new File(context.getCacheDir(), DIR);
        if (!d.exists()) {
            //noinspection ResultOfMethodCallIgnored
            d.mkdirs();
        }
        return d;
    }

    /** 给某个文件生成 content:// URI。 */
    public static Uri uriFor(Context context, File file) {
        return new Uri.Builder()
                .scheme("content")
                .authority(AUTHORITY)
                .appendPath(file.getName())
                .build();
    }

    /** 从 URI 反解出文件，并确认它确实落在安装包目录里。 */
    private File resolve(Uri uri) throws FileNotFoundException {
        String name = uri.getLastPathSegment();
        if (name == null || name.isEmpty()) throw new FileNotFoundException("缺少文件名");
        // 只允许单纯的文文件名，不允许带路径分隔符或 ..
        if (name.contains("/") || name.contains("\\") || name.contains("..")) {
            throw new FileNotFoundException("非法文件名");
        }
        Context ctx = getContext();
        if (ctx == null) throw new FileNotFoundException("没有上下文");
        File dir = dir(ctx);
        File f = new File(dir, name);
        try {
            // 规范化后再比对，double check 没跑出目录
            String base = dir.getCanonicalPath() + File.separator;
            if (!f.getCanonicalPath().startsWith(base)) {
                throw new FileNotFoundException("越界路径");
            }
        } catch (java.io.IOException e) {
            throw new FileNotFoundException("路径解析失败");
        }
        if (!f.exists()) throw new FileNotFoundException("文件不存在：" + name);
        return f;
    }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        if (mode != null && !mode.contains("r")) {
            // 只读，防止外部写入覆盖安装包
            throw new FileNotFoundException("只允许读取");
        }
        File f = resolve(uri);
        return ParcelFileDescriptor.open(f, ParcelFileDescriptor.MODE_READ_ONLY);
    }

    /** 让系统的「打开方式」等客户端能拿到文件名和大小。 */
    @Override
    public Cursor query(Uri uri, String[] projection, String selection,
                        String[] selectionArgs, String sortOrder) {
        File f;
        try {
            f = resolve(uri);
        } catch (FileNotFoundException e) {
            return null;
        }
        String[] cols = projection != null ? projection
                : new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE};
        MatrixCursor cursor = new MatrixCursor(cols, 1);
        Object[] row = new Object[cols.length];
        for (int i = 0; i < cols.length; i++) {
            if (OpenableColumns.DISPLAY_NAME.equals(cols[i])) row[i] = f.getName();
            else if (OpenableColumns.SIZE.equals(cols[i])) row[i] = f.length();
            else row[i] = null;
        }
        cursor.addRow(row);
        return cursor;
    }

    @Override
    public String getType(Uri uri) {
        return "application/vnd.android.package-archive";
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        return null;
    }

    @Override
    public int delete(Uri uri, String selection, String[] selectionArgs) {
        return 0;
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) {
        return 0;
    }

    static void log(String msg) {
        Log.i(TAG, msg);
    }
}
