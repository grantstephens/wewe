#!/usr/bin/env bash
# Verifies a signed release APK before it ships: real signing key, minimum
# targetSdk, the expected permission set, the expected versionCode, and
# (optionally) an exact native-code ABI set. Assertions, not just output - a
# silent regression here ships a broken, over-permissioned, or wrongly-signed
# build to everyone running Obtainium or installing from F-Droid's reference.
#
# Usage: verify-release-apk.sh <apk> <expected-versioncode> [expected-native-code]
#
# expected-native-code, if given, must match aapt's native-code line exactly,
# e.g. "'armeabi-v7a'" for a single-ABI split APK. Omit it for the universal
# APK, which legitimately carries all four ABIs and isn't worth pinning here.
#
# Expects RUNNER_TEMP, KS_PASS, and KEY_ALIAS in the environment (the keystore
# path and the real signing credentials), matching release.yml's own env.
set -euo pipefail

APK="$1"
EXPECTED_CODE="$2"
EXPECTED_NATIVE_CODE="${3:-}"

apksigner verify --print-certs "$APK"

TARGET=$(aapt dump badging "$APK" | sed -n "s/.*targetSdkVersion:'\([0-9]*\)'.*/\1/p")
echo "targetSdkVersion=$TARGET"
[ "$TARGET" -ge 35 ] || { echo "::error::targetSdkVersion $TARGET < 35"; exit 1; }

# DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION is excluded deliberately: it is a
# self-signature permission AndroidX Core auto-injects to emulate Android
# 13's RECEIVER_NOT_EXPORTED flag on older API levels
# (ContextCompat.registerReceiver()) - scoped to this app's own package,
# unusable by any other app, invisible in Play Store's permission listing.
#
# This is the real permission set of a signed release APK's actual merged
# manifest (aapt reads the POST-merge manifest baked into the built APK,
# not the pre-merge source android/app/src/main/AndroidManifest.xml `expo
# prebuild` writes — dependency AARs' own declared permissions only show up
# after Gradle's manifest merger runs, which is why a naive `grep
# uses-permission` against the source file undercounts this; confirmed by a
# real CI failure the first time this script ran for real). Grouped by
# source:
#   - camera (QR pairing), mic + audio routing (the monitor's capture and
#     the two-way talk-back track), foreground-service types (keeping the
#     mic/WebRTC connection alive with the screen off), network state +
#     Bluetooth (react-native-webrtc's ICE gathering), vibrate + wake lock
#     (alert delivery) — this app's own declared permissions.
#   - ACCESS_NOTIFICATION_POLICY, POST_NOTIFICATIONS, READ_APP_BADGE,
#     RECEIVE_BOOT_COMPLETED, SCHEDULE_EXACT_ALARM, and the long tail of
#     vendor launcher badge permissions (com.htc.launcher.*,
#     com.huawei.android.launcher.*, com.sonyericsson.home.*, etc.) —
#     auto-injected by expo-notifications' bundled badge-count library,
#     which declares a uses-permission for essentially every OEM launcher's
#     own badge API so app-icon badge counts work across vendors.
# Checked by exact set, not just count, so a future dependency silently
# adding some other permission does not slip through unnoticed - if this
# list is genuinely out of date, update it deliberately, don't just loosen
# the check.
EXPECTED_PERMS=$(cat <<'EOF' | sort
android.permission.ACCESS_NETWORK_STATE
android.permission.ACCESS_NOTIFICATION_POLICY
android.permission.BLUETOOTH
android.permission.CAMERA
android.permission.FOREGROUND_SERVICE
android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK
android.permission.FOREGROUND_SERVICE_MICROPHONE
android.permission.INTERNET
android.permission.MODIFY_AUDIO_SETTINGS
android.permission.POST_NOTIFICATIONS
android.permission.READ_APP_BADGE
android.permission.RECEIVE_BOOT_COMPLETED
android.permission.RECORD_AUDIO
android.permission.SCHEDULE_EXACT_ALARM
android.permission.VIBRATE
android.permission.WAKE_LOCK
com.anddoes.launcher.permission.UPDATE_COUNT
com.google.android.c2dm.permission.RECEIVE
com.google.android.finsky.permission.BIND_GET_INSTALL_REFERRER_SERVICE
com.htc.launcher.permission.READ_SETTINGS
com.htc.launcher.permission.UPDATE_SHORTCUT
com.huawei.android.launcher.permission.CHANGE_BADGE
com.huawei.android.launcher.permission.READ_SETTINGS
com.huawei.android.launcher.permission.WRITE_SETTINGS
com.majeur.launcher.permission.UPDATE_BADGE
com.oppo.launcher.permission.READ_SETTINGS
com.oppo.launcher.permission.WRITE_SETTINGS
com.sec.android.provider.badge.permission.READ
com.sec.android.provider.badge.permission.WRITE
com.sonyericsson.home.permission.BROADCAST_BADGE
com.sonymobile.home.permission.PROVIDER_INSERT_BADGE
me.everything.badger.permission.BADGE_COUNT_READ
me.everything.badger.permission.BADGE_COUNT_WRITE
EOF
)
PERM_LIST=$(aapt dump permissions "$APK" | grep 'uses-permission' \
  | grep -v 'DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION' \
  | sed -n "s/.*name='\([^']*\)'.*/\1/p" | sort)
echo "declared permissions:"
echo "$PERM_LIST"
[ "$PERM_LIST" = "$EXPECTED_PERMS" ] || {
  echo "::error::declared permissions did not match the expected set"
  echo "--- expected ---"; echo "$EXPECTED_PERMS"
  echo "--- actual ---"; echo "$PERM_LIST"
  exit 1; }

CODE=$(aapt dump badging "$APK" | sed -n "s/.*versionCode='\([0-9]*\)'.*/\1/p")
[ "$CODE" = "$EXPECTED_CODE" ] || {
  echo "::error::versionCode $CODE != $EXPECTED_CODE"; exit 1; }

# Confirms the signing-config patch actually took effect: the APK's
# certificate fingerprint must match the real release keystore's, not the
# debug one build.gradle defaults to.
APK_FPR=$(apksigner verify --print-certs "$APK" \
  | sed -n 's/.*SHA-256 digest: //p' | head -1 | tr 'A-F' 'a-f')
KS_FPR=$(keytool -list -v -keystore "$RUNNER_TEMP/keystore.jks" \
  -storepass "$KS_PASS" -alias "$KEY_ALIAS" \
  | sed -n 's/.*SHA256: *//p' | head -1 | tr -d ':' | tr 'A-F' 'a-f')
[ -n "$APK_FPR" ] && [ "$APK_FPR" = "$KS_FPR" ] || {
  echo "::error::APK is not signed with the release keystore (signing patch did not apply)"
  echo "apksigner: $APK_FPR"
  echo "keystore:  $KS_FPR"
  exit 1; }

NATIVE_CODE=$(aapt dump badging "$APK" | sed -n "s/^native-code: //p")
echo "native-code: $NATIVE_CODE"
if [ -n "$EXPECTED_NATIVE_CODE" ]; then
  [ "$NATIVE_CODE" = "$EXPECTED_NATIVE_CODE" ] || {
    echo "::error::native-code was [$NATIVE_CODE], expected [$EXPECTED_NATIVE_CODE]"
    exit 1; }
fi

aapt dump badging "$APK" | grep -E '^package|native-code'
