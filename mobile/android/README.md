# AgentOne Context Android prototype

**正常连接流程已更新：新版 Mac 设置 → 连接 Android 手机 → 手机扫描/点开配对链接。无需手填 URL、ID 或 Token。**

Native Android 10+ (API 29), target API 35. This is a debug-signed engineering prototype, not a store release.

Implemented: continuous microphone AAC capture, seamless native file rotation, automatic location with permission, private retryable upload queue, HTTPS pairing settings, foreground capture notification with pause, explicit spoken-command mode, and an Agent result inbox with notifications.

Start the capture service from the visible app after permission prompts. It can continue in the background; it is not configured to restart the microphone invisibly after process death or reboot. Incomplete files are retained and shown as pending inspection. No separate sentence-level recording, ASR or Agent runtime runs on the phone. Do not infer recording completeness from an uploaded segment count.

Build using official installed SDK platform/build-tools 35 and a JDK (the Android Studio bundled JDK works):

```sh
bash mobile/android/build.sh
```

Override `ANDROID_SDK_ROOT` and `JAVA_HOME` if needed. Output: `build/android/AgentOne-Context-prototype.apk`. The script uses a local prototype keystore under the ignored build directory and verifies the resulting signature. Keep that key for local updates; it is not a production release credential. Never commit the key.

Install only on a user-selected test device. Configure a trusted HTTPS bridge root, device ID and device-only token in “连接与权限”. The app does not implement certificate bypasses. Then choose “开始持续记录” or “给 Agent 说一句”; finish the latter recording to send its tail promptly. Grant notification permission to see Agent reports; grant location to automatically attach coordinates. Denied location stays unknown.

During recording, synchronization runs about every 30 seconds and after a sealed chunk. Outside recording a network-constrained JobScheduler job is periodic (15 minutes minimum, possibly delayed further); “立即同步并取回结果” also polls. **This is not instant push.** An uploaded chunk does not imply a transcribed, accepted or completed task.

The app currently captures only its microphone, time and permitted location. Calendar, notification ingestion, other app contents, phone system audio, on-phone voice enrollment, task cancellation cards, multi-device deduplication and FCM/vendor push are not yet implemented. Factory battery restrictions and lock-screen continuity require real-device acceptance.

Background bridge/Source setup: [integration guide](../../integrations/superagent-context/README.md). Architecture, benchmark and remaining work: [design](../../docs/vnext/ANDROID_SUPERAGENT_CONTEXT.md).

## Island and pairing update (0.1.1)

The UI now shares the Mac island's black/mint palette, segmented tabs and capsule actions. Optional `TYPE_APPLICATION_OVERLAY` shows the same island above other apps while enabled (including when recording is paused); the user grants Android overlay permission once. Tapping expands/collapses the island; wave amplitude uses the real recorder meter. The phone may record locally before pairing.

Normal setup no longer requires entering URL, device ID or token. In the newly built Mac App choose Settings → Connect Android phone, then scan/open its short-lived link. Alternatively copy that link and choose “粘贴并连接” on Android. The link is single-use and expires after two minutes; pairing cannot silently override an existing connection. Mac prepares the bridge and device-only HTTPS route using existing cloudflared, and stages the Source in a healthy existing Super Agent profile. Phone pairing and live Agent connectivity have separate status. Global execution policy is preserved.

See [validation and limitations](../../docs/reviews/ANDROID_ISLAND_PAIRING_20261102.md). The old manual deployment section below/above describes operator setup; the mobile form no longer asks users for those fields.
