#!/usr/bin/env bash
# Dependency-free prototype APK build using installed official JDK/Android SDK tools.
set -euo pipefail
cd "$(dirname "$0")"
sdk="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-$HOME/Library/Android/sdk}}"
task_java="${JAVA_HOME:-/Applications/Android Studio.app/Contents/jbr/Contents/Home}"
task_tools="$sdk/build-tools/35.0.0"
task_android="$sdk/platforms/android-35/android.jar"
task_build="$(pwd)/../../build/android"
mkdir -p "$task_build/gen" "$task_build/classes" "$task_build/dex"
for tool in "$task_java/bin/javac" "$task_tools/aapt" "$task_tools/d8" "$task_tools/apksigner"; do test -x "$tool" || { echo "Missing tool: $tool" >&2;exit 1; }; done
# aapt requires an explicit manifest package; source manifest stays IDE-compatible.
python3 - "$task_build/AndroidManifest.xml" <<'PY'
import pathlib,sys
text=pathlib.Path('app/src/main/AndroidManifest.xml').read_text()
text=text.replace('<manifest ', '<manifest package="life.agentone.mobile" android:versionCode="2" android:versionName="0.1.1" ')
text=text.replace('<application ', '<uses-sdk android:minSdkVersion="29" android:targetSdkVersion="35" /><application android:debuggable="true" ')
pathlib.Path(sys.argv[1]).write_text(text)
PY
"$task_tools/aapt" package -f -M "$task_build/AndroidManifest.xml" -I "$task_android" -S app/src/main/res -J "$task_build/gen" -F "$task_build/resources.apk"
find app/src/main/java "$task_build/gen" -name '*.java' > "$task_build/sources.txt"
"$task_java/bin/javac" --release 8 -classpath "$task_android" -d "$task_build/classes" @"$task_build/sources.txt"
"$task_java/bin/jar" cf "$task_build/classes.jar" -C "$task_build/classes" .
JAVA_HOME="$task_java" "$task_tools/d8" --lib "$task_android" --min-api 29 --output "$task_build/dex" "$task_build/classes.jar"
cp "$task_build/resources.apk" "$task_build/unsigned.apk"
(cd "$task_build/dex" && zip -q "$task_build/unsigned.apk" classes*.dex)
"$task_tools/zipalign" -f 4 "$task_build/unsigned.apk" "$task_build/aligned.apk"
task_key="$task_build/prototype.keystore"
if ! test -f "$task_key"; then
    "$task_java/bin/keytool" -genkeypair -keystore "$task_key" -storepass android -keypass android -alias prototype -keyalg RSA -keysize 2048 -validity 365 -dname 'CN=AgentOne local prototype'
fi
JAVA_HOME="$task_java" "$task_tools/apksigner" sign --ks "$task_key" --ks-key-alias prototype --ks-pass pass:android --key-pass pass:android --out "$task_build/AgentOne-Context-prototype.apk" "$task_build/aligned.apk"
JAVA_HOME="$task_java" "$task_tools/apksigner" verify --verbose "$task_build/AgentOne-Context-prototype.apk"
echo "$task_build/AgentOne-Context-prototype.apk"
