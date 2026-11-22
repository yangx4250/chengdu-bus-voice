package com.chengdu.bus;

import android.content.Context;
import android.os.PowerManager;
import android.util.Log;

/**
 * 后台/息屏保活：持一把 PARTIAL_WAKE_LOCK。
 *
 * 为什么必须有它：息屏后 CPU 进入 Doze/休眠，`Handler.postDelayed` 的定时器会被**冻结**，
 * 等到下次亮屏才一次性补跑——表现就是「锁屏后完全不播报，一解锁才响」。
 * PARTIAL_WAKE_LOCK 只保证 CPU 醒着（不亮屏、不阻止用户手动锁屏），耗电很低。
 *
 * 用超时的方式申请（而不是一直持有），服务每次 tick 续期，避免服务异常退出时
 * 留下一个永不释放的唤醒锁把电池耗干。
 */
final class WakeKeeper {

    private static final String TAG = "CdBusWake";
    private static final String TAG_LOCK = "cdbus:background";

    /** 单次持有的时长：比轮询间隔长，保证下一次 tick 之前 CPU 不会睡。 */
    private static final long HOLD_MS = 2 * 60 * 1000;

    private final Context context;
    private PowerManager.WakeLock lock;

    WakeKeeper(Context context) {
        this.context = context.getApplicationContext();
    }

    /** 拿/续一把唤醒锁（幂等，可以每次 tick 都调）。 */
    void acquire() {
        try {
            if (lock != null && lock.isHeld()) {
                lock.acquire(HOLD_MS);   // 续期
                return;
            }
            PowerManager pm = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
            if (pm == null) return;
            lock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, TAG_LOCK);
            lock.setReferenceCounted(false);
            lock.acquire(HOLD_MS);
            Log.i(TAG, "唤醒锁已获取（" + HOLD_MS + "ms）");
        } catch (Exception e) {
            Log.w(TAG, "获取唤醒锁失败：" + e.getMessage());
        }
    }

    /** 服务停止时立刻释放。 */
    void release() {
        try {
            if (lock != null && lock.isHeld()) lock.release();
        } catch (Exception ignored) {
        } finally {
            lock = null;
        }
    }

    boolean held() {
        return lock != null && lock.isHeld();
    }
}
