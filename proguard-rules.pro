# ============================================================
# 成都公交 —— R8 混淆规则
# 目标：混淆内部实现，但保住所有「按名字被外部调用」的入口。
# ============================================================

# ---- 1. JS 桥：@JavascriptInterface 的方法名会被网页按字符串调用 ----
# 注解本身已经能让 R8 保留被注解的方法名，但类名/字段仍需显式保住，
# 否则 addJavascriptInterface 注入的对象会变成 a.b.c，虽然能用，
# 但一旦哪天有地方按类名反射就会炸，代价为零，直接 keep 整个类。
-keep class com.chengdu.bus.BusBridge { *; }
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# ---- 2. Manifest 里按类名注册的组件 ----
-keep class com.chengdu.bus.MainActivity { *; }
-keep class com.chengdu.bus.WatchService { *; }
-keep class com.chengdu.bus.AlightService { *; }
-keep class com.chengdu.bus.HeartbeatService { *; }

# ---- 3. Android 框架回调（Activity/Service 生命周期由系统按名字调）----
-keepclassmembers class * extends android.app.Activity {
    public void *(android.view.View);
    protected void on*(...);
}
-keepclassmembers class * extends android.app.Service {
    protected void on*(...);
}

# ---- 4. 枚举 / 序列化（本项目暂无，保留以防以后加）----
-keepclassmembers enum * {
    public static **[] values();
    public static ** valueOf(java.lang.String);
}
-keepnames class * implements java.io.Serializable

# ---- 5. 泛型与注解信息（JSON 手工拼装，不依赖反射，可安全移除）----
-keepattributes Signature
-keepattributes *Annotation*
-keepattributes SourceFile,LineNumberTable

# 隐藏原始源文件名，报错堆栈里不会出现 MainActivity.java
-renamesourcefileattribute SourceFile

# ---- 6. 压缩：删掉未使用的代码/资源引用 ----
-dontwarn org.json.**
-dontwarn android.webkit.**

# 保留 R8 的优化，但别做过于激进的类内联（WebView 回调偶尔依赖）
-optimizationpasses 3
-allowaccessmodification
