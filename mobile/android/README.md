# AgentOne Context Android prototype

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
