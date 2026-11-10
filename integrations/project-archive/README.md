# 录音按 Codex 项目自动归档

运行 `node integrations/project-archive/install.mjs` 安装当前用户的后台服务。它将运行代码复制到 AgentOne 的私人应用数据目录，登录后自动运行，通过操作系统文件通知接收录音库变更，现有录音采集进程继续工作。

默认从启用时刻之后的新讨论开始。整场讨论结束、转写完成后，后台程序将内容与 Codex 项目资料写入私人 `SessionInbox`。程序仅在出现新请求时，用 Codex 自带的消息队列唤醒用户指定的固定 Codex 会话“录音项目归属与归档”，依据整场转写判断项目，并写回有原话依据的结构化响应。后台程序校验结果后归档。这个可见会话保留处理进展和归档结果，空闲时不调用模型，没有定时检查。

项目候选从 Codex 本机项目状态读取，名称和 README 帮助消歧。置信分达到 0.85 才归档到项目，信息不足、多个独立项目或超过 32000 字符的讨论进入私人 `Unassigned` 目录。

目标目录是 `<项目>/Context/Recordings/`。Markdown 包含完整转写、UTC 时间、录音时区、地点线索、分类理由、原始片段 ID、音频引用、哈希和转写版本。`INDEX.md` 提供索引。首次归档到项目时，在现有 `AGENTS.md` 末尾追加一个有标记的阅读入口，保留原有内容。Codex 可按需读取这些 Markdown，当前已打开的对话需要在后续任务中主动回查文件。

来源改变或删除后，自动撤回尚未被用户修改的派生文档并更新索引。已修改的文档保留。失败任务保留待重试，分类结果缓存避免重复调用，同一来源和转写版本不会反复创建文件。

私人运行状态位于 `~/Library/Application Support/AgentOne/ProjectArchive/status.json`，启动参数位于同目录 `config.json`。`since` 是首次启用时间，`memoryRoot` 指向当前录音库。安装器重复运行保留这份配置。`Unassigned/` 保存待归属文件。项目 Markdown 是本地文件，目录本身继续遵循各项目的版本管理设置。

验证命令为 `node --test integrations/project-archive/test.mjs`。已验证完整原文和来源、重复处理、低置信度、越界项目 ID、来源删除及目录符号链接。真实 Codex 分类已将 DeepSeek Harness / dsh 云端工作台示例匹配到 dsh。


专用会话 ID 保存在私人 `config.json` 的 `session_id` 中。每条 `SessionInbox/<request_id>.request.json` 对应同名 `.response.json`，响应包含 request_id、choice、confidence、reason、quote。请求由转写与项目目录内容生成稳定哈希，相同请求重试复用同一个文件。响应中的项目必须来自该请求的候选，quote 必须逐字出现于原文。模型判断、归档完成、尚待确认分别保留状态。

## 从 idea 到工作会话

固定协调会话还会评估录音中的可执行机会，先登记带原话与来源的工单，再创建 Codex 工作会话。已有项目中的任务归到相应项目，全新方向可在独立 IdeaLab 中开展验证。默认每轮最多新建一个工作会话，同时最多推进两个。相同目标复用已有工单和会话。

交付由协调会话独立检查。验收分为目标、范围、功能、可用性、验证和交接六项，总分至少 60，并满足主流程验证、验证证据、可用产物和主要阻碍四项条件。六个维度都须达到该项满分的 60%。未达标时回到原工作会话返工。当前门槛的自动检查仅约束工单状态，实际评分依据仍由协调会话核查并留下证据。

详细运行约定位于 `WORKFLOW.md`。工单保存在私人应用目录的 `work-orders.sqlite`，可用 `node <运行目录>/work-orders.mjs list` 查看。后台通过程序 hook 触发录音分析与任务退出后的验收；旧的五分钟 heartbeat 已停用，没有周期模型唤醒，真实 idea 的首个完整执行验收仍待新录音触发。

## 程序 hook 与去重

使用 `fs.watch` 接收操作系统通知，不使用 `setInterval`、`watchFile` 或重复 sleep 扫描。通知后 400ms 的单次防抖合并同一批落盘动作。录音状态、转写响应和任务交付各自触发归档接续；数据库心跳写入只做本地判断，没有新可处理内容就不唤起 Codex。启动时补查一次遗漏事件。

固定会话通过 `codex queue --thread <session_id> --message ...` 接收消息；工作会话仍由固定会话使用桌面工具创建或跟进，沿用该会话现有模型、登录和权限配置。无需独立 API Key、模型反向代理或后台 Agent runtime。已绑定工作会话的本地终态生成交付事件，固定会话独立验收。`hook-receipts.json` 在分发前持久化去重，避免重启、重复通知或失败造成模型循环调用。不确定分发进入 needs_attention，等待明确恢复。`work-orders.sqlite` 保存实际线程绑定；程序通过本地 thread_history 投影接收 completed/failed/interrupted 事件，再由协调会话核对。App 关闭时消息保留在原生队列，下一次启动后处理，不为唤醒抢屏幕。

新增测试 `event-hooks.test.mjs` 和 `codex-session.test.mjs` 使用临时目录与假 Codex 子进程，覆盖空闲零唤醒、事件防抖、重复去重、重启去重、串行化、失败不循环以及队列确认与本地终态校验。
