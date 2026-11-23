#!/usr/bin/env bash
# 在设备上直接打 APK：javac → d8 → aapt → apksigner（不需要 Gradle / Android Studio）
set -euo pipefail

ROOT=$(cd "$(dirname "$0")" && pwd)
APP="$ROOT/app"
SDK="${ANDROID_JAR:-$ROOT/../sdk/android.jar}"
OUT="$ROOT/build"
PREFIX=/data/data/com.dsharnessmobile.shell/files/usr
export PATH="$PREFIX/bin:$PATH"
export JAVA_HOME="$PREFIX/lib/jvm/java-17-openjdk"

[ -f "$SDK" ] || { echo "缺少 android.jar：$SDK"; exit 1; }

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

echo "== 2/5 转 dex (d8)"
if ! d8 --lib "$SDK" --min-api 24 --output "$OUT/dex" \
     $(find "$OUT/classes" -name '*.class') > "$OUT/d8.log" 2>&1; then
  echo "!! d8 失败"; tail -10 "$OUT/d8.log"; exit 1
fi
[ -f "$OUT/dex/classes.dex" ] || { echo "!! d8 没产出 classes.dex"; exit 1; }

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
( cd "$OUT" && zip -q -j base.apk classes.dex )

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
  --key-pass pass:cdbus123 --out "$ROOT/build/成都公交.apk" "$OUT/aligned.apk" 2>&1 | grep -v "^$" || true
apksigner verify --print-certs "$ROOT/build/成都公交.apk" 2>&1 | head -3

# 6.5 产物自检：dex 里必须能找到每个类的描述符
python3 - "$ROOT/build/成都公交.apk" <<'PYEOF'
import sys, zipfile
apk = sys.argv[1]
dex = zipfile.ZipFile(apk).read("classes.dex")
need = [b"Lcom/chengdu/bus/MainActivity;", b"Lcom/chengdu/bus/BusBridge;",
        b"Lcom/chengdu/bus/ChelaileClient;", b"Lcom/chengdu/bus/Speech;",
        b"Lcom/chengdu/bus/Locator;", b"Lcom/chengdu/bus/AlightService;"]
missing = [n.decode() for n in need if n not in dex]
if missing:
    print("!! dex 缺少类:", missing); sys.exit(1)
print("dex 校验通过，大小", len(dex), "字节")
PYEOF
[ $? -eq 0 ] || exit 1

FINGERPRINT=$(apksigner verify --print-certs "$ROOT/build/成都公交.apk" 2>/dev/null | grep -m1 "SHA-256 digest" | sed "s/.*: //")
echo "== 签名 SHA-256: $FINGERPRINT"

SIZE=$(stat -c %s "$ROOT/build/成都公交.apk")
echo "== 完成：$ROOT/build/成都公交.apk ($((SIZE/1024)) KB)"