package com.chengdu.bus;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.util.Log;

/**
 * 锁屏通知：盯站 / 下车提醒的每个播报节点，除了念出来，还在锁屏上弹一条。
 *
 * <p>为什么要单独一条通道：前台服务自带的那条通知（{@code cdbus_watch} /
 * {@code cdbus_alight}）是 IMPORTANCE_LOW 的常驻通知，系统在锁屏上只会把它折叠成
 * 一行灰字，用户根本看不见。这里另开一条 IMPORTANCE_HIGH + VISIBILITY_PUBLIC 的
 * 通道，锁屏时会以卡片形式弹出，息屏状态下一眼就能看到「还有 2 站」。</p>
 *
 * <p>只在「后台/息屏」时发：亮屏前台由页面播报，这时候再弹通知只会挡视线。</p>
 */
final class Notify {

    private static final String TAG = "CdBusNotify";
    private static final String CHANNEL_ID = "cdbus_alert";
    private static final String CHANNEL_NAME = "到站提醒（锁屏显示）";
    private static final String PREFS = "cdbus_notify";
    private static final String KEY_ON = "lockOn";
    /** 固定 id：同一条覆盖更新，不会把锁屏刷满。 */
    private static final int ID = 2001;

    private Notify() {}

    static boolean enabled(Context context) {
        if (context == null) return false;
        try {
            SharedPreferences p = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            return p.getBoolean(KEY_ON, true);   // 默认开：用户要的就是锁屏也能看到
        } catch (Throwable e) {
            return false;
        }
    }

    static void setEnabled(Context context, boolean on) {
        if (context == null) return;
        try {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .edit().putBoolean(KEY_ON, on).apply();
            if (!on) cancel(context);
        } catch (Throwable e) {
            Log.w(TAG, "保存锁屏通知开关失败", e);
        }
    }

    private static void ensureChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager =
                (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID, CHANNEL_NAME, NotificationManager.IMPORTANCE_HIGH);
        channel.setDescription("息屏/锁屏时把到站进度显示在锁屏上");
        // 锁屏上要能看到正文，不能是「已隐藏内容」
        channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        // 播报已经由 TTS 负责，通知本身不再响，避免两声
        channel.enableVibration(false);
        channel.setSound(null, null);
        manager.createNotificationChannel(channel);
    }

    /**
     * 发一条锁屏通知。
     *
     * @param title 主标题，如「P36路 · 花园公交站」
     * @param text  正文，如「还有 2 站」
     */
    static void post(Context context, String title, String text) {
        if (context == null || !enabled(context)) return;
        try {
            ensureChannel(context);
            NotificationManager manager =
                    (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
            if (manager == null) return;

            Intent open = new Intent(context, MainActivity.class);
            open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_NEW_TASK);
            int flags = PendingIntent.FLAG_UPDATE_CURRENT;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                flags |= PendingIntent.FLAG_IMMUTABLE;
            }
            PendingIntent pending = PendingIntent.getActivity(context, 0, open, flags);

            Notification.Builder builder;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                builder = new Notification.Builder(context, CHANNEL_ID);
            } else {
                builder = new Notification.Builder(context);
            }
            builder.setContentTitle(title == null ? "成都公交" : title)
                    .setContentText(text == null ? "" : text)
                    .setSmallIcon(android.R.drawable.ic_popup_reminder)
                    .setContentIntent(pending)
                    .setAutoCancel(true)
                    .setOnlyAlertOnce(true)
                    // 锁屏上展开显示正文
                    .setVisibility(Notification.VISIBILITY_PUBLIC)
                    .setCategory(Notification.CATEGORY_ALARM)
                    .setPriority(Notification.PRIORITY_HIGH);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                builder.setStyle(new Notification.BigTextStyle().bigText(text == null ? "" : text));
            }
            manager.notify(ID, builder.build());
            Log.i(TAG, "锁屏通知：" + title + " / " + text);
        } catch (Throwable e) {
            Log.w(TAG, "发锁屏通知失败", e);
        }
    }

    static void cancel(Context context) {
        if (context == null) return;
        try {
            NotificationManager manager =
                    (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
            if (manager != null) manager.cancel(ID);
        } catch (Throwable ignored) {
        }
    }
}
