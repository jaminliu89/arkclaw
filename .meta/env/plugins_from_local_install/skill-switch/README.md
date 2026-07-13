# @openclaw/skill-switch

`@openclaw/skill-switch` 是 OpenClaw host plugin，负责会话级 skill 选择、BUA session 注入、CUA 命令桥接，以及 video-to-prompt 录制 / 分析 gateway。

本目录只负责 plugin 侧逻辑。video-to-prompt runtime 的多模态分析实现位于 `runtime/agents/video-to-prompt/`，skill bootstrap 位于 `skills/video-to-prompt/`。

## 功能边界

| 能力             | 说明                                                                                                  | 主要入口                                         |
| ---------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Skill 切换       | 扫描可用 `SKILL.md`，实例级保存当前激活 skill，并在 prompt 构建前按优先级注入内容                     | `src/commands.ts`, `src/skill-injection-hook.ts` |
| BUA session 注入 | 在 `before_tool_call` / `after_tool_call` hook 中识别 `bua` 调用，注入 `--session` 并写入安全摘要日志 | `index.ts`                                       |
| BUA focus        | 提供 `/bua-focus` 与 `arkclawSkillSelect.focus`，调用 `bua --session <id> focus`                      | `src/commands.ts`                                |
| CUA 命令         | 提供 `/cua` 命令，桥接 computer-use skill 的 `cua.sh`                                                 | `src/cua_commands.ts`                            |
| video-to-prompt  | 提供 `/vtp-recording` 和 `arkclawVtpRecording.*` RPC，完成录屏、分析、结果读取、保存为 skill          | `src/video-to-prompt/`                           |

## 目录结构

| 路径                                    | 说明                                                 |
| --------------------------------------- | ---------------------------------------------------- |
| `index.ts`                              | plugin 注册入口，注册命令、hooks、gateway 和维护任务 |
| `src/commands.ts`                       | `/skill-switch`、`/bua-focus` 命令实现               |
| `src/cua_commands.ts`                   | `/cua` 命令实现                                      |
| `src/skill-discovery.ts`                | skill 目录扫描与 session skill 合并                  |
| `src/session-state.ts`                  | session 激活 skill 状态读写                          |
| `src/skill-injection-hook.ts`           | prompt 构建前注入选中 skill                          |
| `src/video-to-prompt/`                  | video-to-prompt plugin 侧实现                        |
| `src/video-to-prompt/gateway-handlers/` | 每个 `arkclawVtpRecording.*` RPC 一个 handler        |
| `tests/`                                | plugin 根级 Vitest 用例                              |
| `docs/`                                 | plugin 本地 ADR、架构索引和经验文档                  |

## 命令

### `/skill-switch`

列出可用 skills，并清除当前实例的激活 skill。该命令现在是实例级别（全局生效），传入 `--session` / `-s` 仅做兼容，会被忽略。

```text
/skill-switch
/skill-switch --session agent:main:main   # 兼容写法，session 参数被忽略
```

### `/skill-switch <skill-id>`

切换当前实例的激活 skill（全局生效，所有 session 共享）。切换成功后会保存状态、清理工具调用历史，并在存在上一条用户消息时触发 reprocess。

```text
/skill-switch my-custom-skill
/skill-switch my-custom-skill --session agent:main:main   # 兼容写法，session 参数被忽略
/skill-switch my-custom-skill -s agent:main:main          # 兼容写法，session 参数被忽略
```

### `/bua-focus`

聚焦指定 session 的 BUA 页面。未显式传入 `--session` 时，会尝试从 command context 解析 session。

```text
/bua-focus --session agent:main:main
```

### `/cua`

桥接 computer-use skill 的 CUA 脚本，支持运行、查询、继续、停止、列表等子命令。具体输出为 JSON 文本，实际能力由 `skills/computer-use/scripts/cua.sh` 提供。

```text
/cua
/cua run <prompt>
/cua status [runId]
/cua continue [runId]
/cua stop [runId]
/cua list
```

### `/vtp-recording`

控制 video-to-prompt 录制、分析和结果读取。

```text
/vtp-recording start
/vtp-recording pause
/vtp-recording resume
/vtp-recording stop
/vtp-recording cancel
/vtp-recording analyze [recordingId]
/vtp-recording save-skill [recordingId]
/vtp-recording status [recordingId]
/vtp-recording result [recordingId] [--log] [--steps]
/vtp-recording list
```

## Gateway RPC

### Skill Select

| RPC                         | 说明                                                           |
| --------------------------- | -------------------------------------------------------------- |
| `arkclawSkillSelect.list`   | 返回扫描 skills、session skills、当前激活 skill                |
| `arkclawSkillSelect.switch` | 切换或清除实例级激活 skill（传入 sessionKey 仅做兼容，被忽略） |
| `arkclawSkillSelect.focus`  | 执行 `bua --session <id> focus`                                |

`arkclawSkillSelect.switch` 的错误响应遵循严格 error envelope。额外字段放入 `details`，避免宿主 CLI schema 拒绝响应。

### VTP Recording

| RPC                                     | 说明                                                    |
| --------------------------------------- | ------------------------------------------------------- |
| `arkclawVtpRecording.start`             | 开始录制                                                |
| `arkclawVtpRecording.pause`             | 暂停录制                                                |
| `arkclawVtpRecording.resume`            | 恢复录制                                                |
| `arkclawVtpRecording.stop`              | 停止录制                                                |
| `arkclawVtpRecording.cancel`            | 取消录制或分析                                          |
| `arkclawVtpRecording.analyze`           | 触发 video-to-prompt 分析                               |
| `arkclawVtpRecording.events`            | 轮询分析事件                                            |
| `arkclawVtpRecording.status`            | 查询当前或指定录制状态                                  |
| `arkclawVtpRecording.result`            | 读取生成的 prompt / meta / steps / log                  |
| `arkclawVtpRecording.renderInstruction` | 渲染“在聊天里运行”的自然语言 instruction                |
| `arkclawVtpRecording.saveAsSkill`       | 保存为可复用 skill                                      |
| `arkclawVtpRecording.updatePrompt`      | 更新生成 prompt                                         |
| `arkclawVtpRecording.saveVideoToMount`  | 将录制视频 relay 到挂载盘并维护长期保存标记             |
| `arkclawVtpRecording.getRelayProgress`  | 查询视频 relay 进度                                     |
| `arkclawVtpRecording.delete`            | 强制擦除录制域痕迹（runDir / state / 进程 / mount mp4） |
| `arkclawVtpRecording.listSkill`         | 列出已保存任务模板                                      |
| `arkclawVtpRecording.getSkill`          | 读取任务模板详情                                        |
| `arkclawVtpRecording.invokeSkill`       | 执行任务模板                                            |
| `arkclawVtpRecording.updateSkill`       | 更新任务模板                                            |
| `arkclawVtpRecording.deleteSkill`       | 删除任务模板                                            |

## Skill 来源

plugin 会扫描并合并以下 skill 来源：

| 来源             | 目录 / 数据                                         |
| ---------------- | --------------------------------------------------- |
| plugin managed   | `<stateDir>/skills`                                 |
| workspace agents | `/root/.agents/skills`                              |
| extra dirs       | `config.skills.load.extraDirs`                      |
| session snapshot | OpenClaw session store 中的 `skillsSnapshot.skills` |

每个目录型 skill 需要包含 `SKILL.md`。

当 active skill context 尚不存在时，plugin 默认使用 skill id `XUA-auto`。如果缓存中没有该 skill，`before_prompt_build` 会按 `$HOME/.agents/skills/XUA-auto/SKILL.md` 兜底读取；文件缺失时不注入 skill block。

## 状态与日志

| 数据             | 位置 / 说明                                                                  |
| ---------------- | ---------------------------------------------------------------------------- |
| 激活 skill       | `src/session-state.ts` 管理，按 session context key 存储                     |
| BUA hook 日志    | `<stateDir>/extensions/skill-switch/bua-hook.log`，只记录截断后的低风险摘要  |
| VTP artifacts    | 默认由 `videoToPrompt.vtpHome` 或 `VTP_HOME` 控制，未配置时使用 `$HOME/.vtp` |
| VTP saved skills | 默认写入 workspace-relative `skills/vtp-recording`                           |

## 配置

`openclaw.plugin.json` 中的 `injection` 命名空间控制 prompt 注入策略，`videoToPrompt` 命名空间控制录制、分析和保存行为。

| 字段                                  | 默认值         | 说明                                                                                                   |
| ------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------ |
| `injection.lowPrioritySkills`         | `["XUA-auto"]` | 命中的 skill 只作为低优先级“可用技能目录”注入，不独占；未命中的选中 skill 作为首选方案注入，可按需回退 |
| `videoToPrompt.maxRecordingSeconds`   | `120`          | 用户侧录制上限，auto-stop 在该时间触发                                                                 |
| `videoToPrompt.maxRecordingGraceSeconds` | `10`        | ffmpeg hard cap 额外宽限时间                                                                           |
| `videoToPrompt.maxRecordingSizeMB`    | `300`          | 停止后视频大小上限                                                                                     |
| `videoToPrompt.ffmpegBin`             | `ffmpeg`       | ffmpeg 可执行文件                                                                                      |
| `videoToPrompt.display`               | `:99`          | X11 display                                                                                            |
| `videoToPrompt.resolution`            | `1920x1080`    | 录制分辨率                                                                                             |
| `videoToPrompt.framerate`             | `15`           | 录制帧率，整数 [1, 60]；非法值在 runtime 回退默认 15                                                   |
| `videoToPrompt.skillScriptPath`       | workspace 下的 video-to-prompt skill script | `video-to-prompt.sh` 路径                                                        |
| `videoToPrompt.vtpHome`               | `$HOME/.vtp`   | VTP 配置和运行产物根目录                                                                               |
| `videoToPrompt.logRetentionDays`      | `7`            | `skill.log` 清理保留天数                                                                               |
| `videoToPrompt.maxReferenceCount`     | `100`          | `saveAsSkill` reference LRU 上限                                                                       |
| `videoToPrompt.vtpRecordingRoot`      | `skills/vtp-recording` | 保存录制 skill 的 workspace-relative 目录                                                       |

安装 / 升级时 `plugin-manager.sh` 会把推荐配置写入 host 侧 `~/.openclaw/openclaw.json` 的 `plugins.entries.skill-switch.config.injection.lowPrioritySkills`。如需回滚到旧的强优先注入行为，可将该数组设为 `[]` 或移除特定 skill id；如需彻底关闭某个缺失 skill 的注入，删除 active skill 或移除对应 `SKILL.md` 即可，hook 会按 0 skill 注入处理。历史镜像中写入 `AGENTS.md` 的 Computer / Browser 强制读 skill 提示词由 `scripts/tos/common/cleanup-agents-skill-injections.sh` 幂等清理。

## 开发与验证

在本目录执行：

```bash
npm install
npm run build
npm run typecheck
npm test
```

### 覆盖率统计

覆盖率不会随 `npm test` 默认开启，仅在显式带 `--coverage` 时启动 V8 采集（数据源：`@vitest/coverage-v8`，由 [vitest.config.ts](./vitest.config.ts) 中的 `test.coverage` 块描述 reporter 与 include 范围）。

```bash
# 全量测试 + 覆盖率
npx vitest run --coverage

# 仅本次新增的核心模块覆盖率（与 vitest.config.ts include 对齐）
npx vitest run --coverage \
  src/utils.test.ts \
  src/session-state.test.ts \
  src/skill-discovery.test.ts \
  src/skill-injection-hook.test.ts \
  src/conversation-source.test.ts \
  src/handoff-source.test.ts
```

覆盖率产物位于本目录 `coverage/`（已加入仓库根 `.gitignore`，不会进入 git，也不会被 [scripts/package/package.sh](../../scripts/package/package.sh) 打入 tarball）：

| 数据源                           | 用途                               |
| -------------------------------- | ---------------------------------- |
| 终端 `text` reporter             | 命令行直接查看摘要                 |
| `coverage/coverage-summary.json` | CI / Bot 解析机器可读摘要          |
| `coverage/lcov.info`             | LCOV 上报 (SonarQube / Codecov 等) |
| `coverage/index.html`            | 本地浏览器打开查看逐行高亮         |

测试布局：

| 路径                                             | 说明                                    |
| ------------------------------------------------ | --------------------------------------- |
| `tests/`                                         | plugin 根级命令、hook、gateway 注册测试 |
| `src/video-to-prompt/*.test.ts`                  | video-to-prompt plugin 侧模块测试       |
| `src/video-to-prompt/gateway-handlers/*.test.ts` | 单个 gateway handler 测试               |

修改 video-to-prompt 协议、产物布局或 skill bootstrap 时，还需要同步检查：

| 路径                                   | 说明                                          |
| -------------------------------------- | --------------------------------------------- |
| `runtime/agents/video-to-prompt/`      | runtime 侧实现、SEA bundle 和 prompt 分析逻辑 |
| `skills/video-to-prompt/`              | skill bootstrap 与 `SKILL.md`                 |
| `docs/features/video-to-prompt/specs/` | 对外协议、测试计划和升级说明                  |

## 相关文档

| 文档                                                                                                                                       | 说明                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| [AGENTS.md](./AGENTS.md)                                                                                                                   | 本目录 AI 编程规则和常用命令                                               |
| [docs/architecture/codemap.md](./docs/architecture/codemap.md)                                                                             | 本地代码导航                                                               |
| [docs/adr/README.md](./docs/adr/README.md)                                                                                                 | plugin 侧 ADR 索引                                                         |
| [docs/experience/README.md](./docs/experience/README.md)                                                                                   | plugin 侧经验沉淀                                                          |
| [docs/features/skill-switch-plugin/README.md](./docs/features/skill-switch-plugin/README.md)                                               | skill-switch plugin 本体、skill 选择、prompt 注入和 `arkclawSkillSelect.*` |
| [docs/features/cua-command/README.md](./docs/features/cua-command/README.md)                                                               | `/cua` 命令桥接 computer-use skill                                         |
| [docs/features/observability/README.md](./docs/features/observability/README.md)                                                           | plugin 日志、状态文件、运行产物和排障入口                                  |
| [docs/features/video-to-prompt/specs/](./docs/features/video-to-prompt/specs/)                                                             | video-to-prompt 对外协议、测试计划和升级说明                               |
| [docs/features/video-to-prompt/research/STANDARDS-ALIGNMENT-PLAN.md](./docs/features/video-to-prompt/research/STANDARDS-ALIGNMENT-PLAN.md) | video-to-prompt 行业标准对标调研入口                                       |
| [src/video-to-prompt/README.md](./src/video-to-prompt/README.md)                                                                           | video-to-prompt plugin 子模块说明                                          |
