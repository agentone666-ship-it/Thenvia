# Android Context / Super Agent 原型验证

日期：2026-11-02。代码分支：`codex/android-superagent-context`，草稿 PR #11，叠加在声纹 PR #9 上。没有合并或部署。

## 本轮已验证

| 检查 | 结果 | 证明范围 |
| --- | --- | --- |
| Bridge / Source / Channel | 11 / 11 通过 | 哈希、幂等、租约失效、ASR 错误保留、乱序结果不漏投、HTTP 角色隔离、上下文与结果收件箱往返 |
| 已安装 Super Agent 的实际契约 | 3 / 3 通过 | 真实 SourceRegistry 注册、真实 policy.gate、observe/auto 的 assessmentOutcome；不是 LLM 语义识别测试 |
| Voice task 场景入口 | 14 / 14 路由契约通过 | 确认什么事件可交给模型评估；不代表 14 个任务做对了 |
| 模型任务判断 benchmark | `not_run` | 没有实际 Super Agent 决策/执行证据，不报准确率 |
| 原有 runtime / MCP / recall | `scripts/ci.sh runtime` 退出 0 | 58 runtime、26 Memory MCP 测试及原有个人事件插件/合成回忆 benchmark 保持通过 |
| Python 与 shell 语法 | 通过 | ASR worker / 宿主契约 runner 可解析，构建/CI 脚本语法有效 |
| Android APK | 编译、签名验证通过 | API 29+，target 35，debug 原型签名；不证明实际录音连续性 |
| CI YAML / gate 依赖 | 本地结构检查通过 | 新 Android 构建加入 all-checks-passed；远端 CI 结果单独检查 |

复现命令：

```sh
bash scripts/ci.sh runtime
python3 integrations/superagent-context/check-superagent.py /Users/zengjiabao/src/dsh-superagent
bash mobile/android/build.sh
```

本地 APK 位于 `build/android/AgentOne-Context-prototype.apk`；同目录 `APK-SHA256SUMS` 记录构建后的哈希，签名私钥只在忽略的构建目录中。CI 不上传私钥。

## 未通过/未做的现场检查

- 独立无窗口 Android 35 模拟器禁用主机音频运行，120 秒内未完成系统启动。未进入 App 安装/录音阶段，不能据此判断 App 录音对错。该临时模拟器已退出、临时 AVD 已清理，未操作用户桌面或实际手机。
- 没有连接 Android 真机，因此未测实际锁屏、音频轮换、厂商电源管理、断网补传和手机通知。
- 本机现有 Super Agent 状态命令返回 1；发现进程但未证明运行健康。没有重启现有宿主、变更 live Policy、开启自动接单或派发真实任务。
- 可选 ASR worker 仅做语法检查与其 HTTP 协议测试；没有本轮手机真实音频的 ASR/声纹准确率结果。
- 本地安装 actionlint 时 Go 代理网络超时，未获得本地 actionlint 结果；远端 workflow-lint 由已有固定镜像执行。

## 使用边界

这是可以继续连接与验收的工程原型。当前结果通知为轮询，非即时 Push。Mac 原有音频/事件继续通过既有 MCP 检索，尚未统一导入本次手机桥接库。手机声纹录入、任务结构化卡片、跨设备去重和桥接删除/保留界面尚未实现。

没有把本地测试通过、APK 可编译、模型会判断、任务已执行和手机已收到回报合并为一个“已跑通”的结论。下一次验收必须用同一条真实授权任务贯穿原音、转写、Decision、Ticket、交付文件/PR 和手机回报。
