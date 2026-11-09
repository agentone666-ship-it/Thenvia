# 录音按 Codex 项目自动归档

运行 `node integrations/project-archive/install.mjs` 安装当前用户的后台服务。它将运行代码复制到 AgentOne 的私人应用数据目录，登录后自动运行，每 15 秒检查新讨论，现有录音采集进程继续工作。

默认从启用时刻之后的新讨论开始。整场讨论结束、转写完成后，通过当前 Codex 登录和配置中的模型判断项目归属。后台调用使用只读、临时的结构化输出流程，转写会发给 Codex 模型并使用现有额度。项目候选从 Codex 本机项目状态读取，名称和 README 帮助消歧。置信分达到 0.85 才归档到项目，信息不足、多个独立项目或超过 32000 字符的讨论进入私人 `Unassigned` 目录。

目标目录是 `<项目>/Context/Recordings/`。Markdown 包含完整转写、UTC 时间、录音时区、地点线索、分类理由、原始片段 ID、音频引用、哈希和转写版本。`INDEX.md` 提供索引。首次归档到项目时，在现有 `AGENTS.md` 末尾追加一个有标记的阅读入口，保留原有内容。Codex 可按需读取这些 Markdown，当前已打开的对话需要在后续任务中主动回查文件。

来源改变或删除后，自动撤回尚未被用户修改的派生文档并更新索引。已修改的文档保留。失败任务保留待重试，分类结果缓存避免重复调用，同一来源和转写版本不会反复创建文件。

私人运行状态位于 `~/Library/Application Support/AgentOne/ProjectArchive/status.json`，启动参数位于同目录 `config.json`。`since` 是首次启用时间，`memoryRoot` 指向当前录音库。安装器重复运行保留这份配置。`Unassigned/` 保存待归属文件。项目 Markdown 是本地文件，目录本身继续遵循各项目的版本管理设置。

验证命令为 `node --test integrations/project-archive/test.mjs`。已验证完整原文和来源、重复处理、低置信度、越界项目 ID、来源删除及目录符号链接。真实 Codex 分类已将 DeepSeek Harness / dsh 云端工作台示例匹配到 dsh。
