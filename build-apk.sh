#!/usr/bin/env bash
# 在设备上直接打 APK：javac → d8 → aapt → apksigner（不需要 Gradle / Android Studio）
set -euo pipefail

ROOT=$(cd "$(dirname "$0")" && pwd)
APP="$ROOT/app"
OUT="$ROOT/build"

# 工具链：优先用手机上的 Termux 前缀，没有就用系统 PATH（本机 Ubuntu 环境）
PREFIX=/data/data/com.dsharnessmobile.shell/files/usr
if [ -d "$PREFIX/bin" ]; then
  export PATH="$PREFIX/bin:$PATH"
  [ -d "$PREFIX/lib/jvm/java-17-openjdk" ] && export JAVA_HOME="$PREFIX/lib/jvm/java-17-openjdk"
fi

# android.jar：依次在几个常见位置找，都找不到才报错。
# 依赖不提交进仓库，所以每台机器要自己准备一份。
find_android_jar() {
  local c
  for c in \
    "${ANDROID_JAR:-}" \
    "$ROOT/../sdk/android.jar" \
    "$ROOT/sdk/android.jar" \
    "$ROOT/.sdk/android.jar" \
    "/tmp/android.jar" \
    "${ANDROID_HOME:-}"/platforms/android-34/android.jar \
    "${ANDROID_HOME:-}"/platforms/android-33/android.jar \
    "/usr/lib/android-sdk/platforms/android-33/android.jar"; do
    [ -n "$c" ] && [ -f "$c" ] && { echo "$c"; return 0; }
  done
  return 1
}
SDK=$(find_android_jar) || {
  echo "缺少 android.jar。放到以下任一位置，或设 ANDROID_JAR 环境变量："
  echo "  $ROOT/sdk/android.jar    （推荐，已 gitignore）"
  echo "  /tmp/android.jar"
  exit 1
}
echo "   android.jar: $SDK"

rm -rf "$OUT"
mkdir -p "$OUT/classes" "$OUT/dex"

echo "== 1/5 编译 Java (javac)"
find "$APP/src" -name '*.java' > "$OUT/sources.txt"
if ! javac -nowarn -source 8 -target 8 -bootclasspath "$SDK" \
      -d "$OUT/classes" @"$OUT/sources.txt" > "$OUT/javac.log" 2>&1; then
  echo "!! javac 失败"; grep -E "error:" "$OUT/javac.log" | head -10; exit 1
fi
for class in MainActivity BusBridge ChelaileClient Speech Locator AlightService; do
  [ -f "$OUT/classes/com/chengdu/bus/$class.class" ] || { echo "!! 缺少 $class.class（编译没产出）"; exit 1; }
done

echo "== 2/5 混淆 + 转 dex (r8 --release)"
# 用 R8 而不是 d8：同时做混淆（改名）、裁剪（删死代码）、dex 转换。
# 保留规则见 proguard-rules.pro —— 关键是 @JavascriptInterface 的方法名不能改，
# 网页里是按字符串 "AndroidBus.start(...)" 调用的。
RULES="$ROOT/proguard-rules.pro"
[ -f "$RULES" ] || { echo "!! 缺少 $RULES"; exit 1; }
# R8：优先 R8_JAR 环境变量，其次 sdk/r8.jar，最后找系统里的 r8 命令
find_r8() {
  local c
  for c in "${R8_JAR:-}" "$ROOT/sdk/r8.jar" "$ROOT/../sdk/r8.jar" "/tmp/r8.jar"; do
    [ -n "$c" ] && [ -f "$c" ] && { echo "$c"; return 0; }
  done
  command -v r8 >/dev/null 2>&1 && { echo ""; return 0; }
  return 1
}
R8JAR=$(find_r8) || {
  echo "缺少 R8。放到 sdk/r8.jar，或设 R8_JAR 环境变量，或安装 r8 命令"
  exit 1
}
if [ -n "$R8JAR" ]; then R8_CMD=(java -cp "$R8JAR" com.android.tools.r8.R8); else R8_CMD=(r8); fi
if ! "${R8_CMD[@]}" --release --lib "$SDK" --min-api 24 \
     --output "$OUT/dex" \
     --pg-conf "$RULES" \
     $(find "$OUT/classes" -name '*.class') > "$OUT/r8.log" 2>&1; then
  echo "!! r8 失败"; tail -20 "$OUT/r8.log"; exit 1
fi
[ -f "$OUT/dex/classes.dex" ] || { echo "!! r8 没产出 classes.dex"; exit 1; }
echo "   混淆后 dex: $(stat -c %s "$OUT/dex/classes.dex") 字节（混淆前 $(find "$OUT/classes" -name '*.class' -printf '%s\n' | awk '{s+=$1} END {print s}') 字节的 class）"

echo "== 3/5 打包资源 (aapt)"
aapt package -f \
  -M "$APP/AndroidManifest.xml" \
  -S "$APP/res" \
  -A "$APP/assets" \
  -I "$SDK" \
  -F "$OUT/base.apk" \
  --min-sdk-version 24 --target-sdk-version 33 2>&1 | grep -v "^$" || true

echo "== 4/5 塞入 classes.dex"
cp "$OUT/dex/classes.dex" "$OUT/classes.dex"
# 不用 zip 命令（部分环境没装），直接用 Python 的 zipfile 重写一遍
python3 - "$OUT/base.apk" "$OUT/classes.dex" <<'PYZIP'
import sys, zipfile, shutil
apk, dex = sys.argv[1], sys.argv[2]
tmp = apk + ".tmp"
with zipfile.ZipFile(apk) as zin, zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zout:
    for item in zin.infolist():
        zout.writestr(item, zin.read(item.filename))
    zout.write(dex, "classes.dex")
shutil.move(tmp, apk)
PYZIP

echo "== 5/6 对齐 (zipalign)"
python3 "$ROOT/tools/zipalign.py" "$OUT/base.apk" "$OUT/aligned.apk"

echo "== 6/6 签名 (apksigner)"
# 固定签名：keystore 放在 build/ 之外，只生成一次，之后每次更新都用同一把钥匙
KEYSTORE="$ROOT/keystore/cdbus.jks"
mkdir -p "$ROOT/keystore"
if [ ! -f "$KEYSTORE" ]; then
  echo "-- 首次生成签名密钥（之后固定复用）"
  keytool -genkeypair -v -keystore "$KEYSTORE" \
    -alias cdbus -keyalg RSA -keysize 2048 -validity 36500 \
    -storepass cdbus123 -keypass cdbus123 \
    -dname "CN=Chengdu Bus, OU=DSH, O=local, L=Chengdu, S=Sichuan, C=CN" >/dev/null 2>&1
fi
apksigner sign --ks "$KEYSTORE" --ks-pass pass:cdbus123 \
  --key-pass pass:cdbus123 --out "$ROOT/build/公交来了.apk" "$OUT/aligned.apk" 2>&1 | grep -v "^$" || true
apksigner verify --print-certs "$ROOT/build/公交来了.apk" 2>&1 | head -3

# 6.5 产物自检：混淆后这些「按名字被调用」的东西必须还在
python3 - "$ROOT/build/公交来了.apk" "$ROOT/app/src/com/chengdu/bus/BusBridge.java" <<'PYEOF'
import sys, zipfile, re
apk, bridge_src = sys.argv[1], sys.argv[2]
dex = zipfile.ZipFile(apk).read("classes.dex")

# (1) Manifest 里按类名注册的组件，必须保留原始类名
need_classes = [b"Lcom/chengdu/bus/MainActivity;", b"Lcom/chengdu/bus/WatchService;",
                b"Lcom/chengdu/bus/AlightService;", b"Lcom/chengdu/bus/HeartbeatService;",
                b"Lcom/chengdu/bus/ApkProvider;"]
missing = [n.decode() for n in need_classes if n not in dex]
if missing:
    print("!! dex 缺少类:", missing); sys.exit(1)

# (2) JS 桥的方法名：从 BusBridge.java 里抓 @JavascriptInterface 注解后的方法名，
#     逐个确认 dex 里还有这个字符串 —— 混淆改了就说明 -keep 规则漏了。
#     网页侧是 var bridge = window.AndroidBus; 然后 bridge.start(...)，
#     所以字符串里查不到 "AndroidBus.start("，必须从 Java 源码这边取名字。
src = open(bridge_src, encoding="utf-8").read()
called = sorted(set(re.findall(
    r"@JavascriptInterface\s+public\s+[\w.<>\[\]]+\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(", src)))
if not called:
    print("!! 没从 BusBridge.java 里找到任何 @JavascriptInterface 方法"); sys.exit(1)
lost = [m for m in called if m.encode() not in dex]
if lost:
    print("!! 混淆把 JS 桥方法名改掉了（网页会调不通）:", lost); sys.exit(1)

# (3) 反向确认：内部实现类应该已经被改名（否则说明 R8 没生效）
internal = [b"Lcom/chengdu/bus/ChelaileClient;", b"Lcom/chengdu/bus/Locator;",
            b"Lcom/chengdu/bus/Navigator;", b"Lcom/chengdu/bus/Geo;"]
still = [n.decode() for n in internal if n in dex]
print("dex 校验通过：组件类 %d 个、JS 桥方法 %d 个都保留" % (len(need_classes), len(called)))
if still:
    print("   注意：这些内部类名没被混淆（-keep 放宽了）:", still)
else:
    print("   内部实现类已全部改名（ChelaileClient/Locator/Navigator/Geo 在 dex 里都查不到）")
PYEOF
[ $? -eq 0 ] || exit 1

FINGERPRINT=$(apksigner verify --print-certs "$ROOT/build/公交来了.apk" 2>/dev/null | grep -m1 "SHA-256 digest" | sed "s/.*: //")
echo "== 签名 SHA-256: $FINGERPRINT"

SIZE=$(stat -c %s "$ROOT/build/公交来了.apk")
echo "== 完成：$ROOT/build/公交来了.apk ($((SIZE/1024)) KB)"