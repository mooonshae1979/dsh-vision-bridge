# dsh-vision-bridge — 让任意文本模型能看图

给 DeepSeek Harness 装一只"视觉桥"：**任意文本模型（官方 DeepSeek、TRAE、opencode-go 等）都能直接接收图片附件**，图片由插件自动生成的一次性读图子 agent（自动选择视觉模型，**免费优先、质量优先**）转写为文本，主模型继续处理。

## 特性

- **Host 图片准入自动补丁（自愈）**：每次插件加载自动检查 `dsh-host-apiproxy` 的两处图片准入检查，未打补丁则自动应用（`RELAX_IMAGE_ADMISSION` 开关，默认放行），备份原文件；`npm update -g @deepseek-ai/dsh` 后无需手动重打。
- **文生图（generate_image）**：通过火山引擎方舟 Doubao Seedream 生成图片，下载后注入会话显示。
- **读图子 agent**：`agent/pre-step` 检测到图片且当前模型不原生看图时，基于 `ctx.subagents`（与 AgentTeams 成员同源）生成一次性子 agent，`agentOptions` 固定视觉路由、禁用全部工具、超时取消、完成后释放。
- **失败自动重试**：视觉路由按「免费优先、质量优先」排序成候选列表；一次尝试失败（spawn 错误 / 子 agent 未完成 / 空输出）自动换下一个候选路由，最多 `maxAttempts` 次；全部失败后再降级为直连 `llm.stream` 重试一次（`fallbackToDirect`）。
- **带着需求读图**：视觉子 agent 不再只拿到图片——**图片所在消息里的用户文本（问题/指令）会一并传给视觉模型**（`includeUserText`，默认开启），所以问"这是谁"时视觉模型会做身份识别，而不是机械逐字转写。
- **可诊断的失败占位符**：转写失败时不再只有一句「视觉子 agent 未完成 (aborted)」，而是附上失败原因、已尝试的路由，以及**图片来源信息**（文件名、尺寸、大小、附件ID、本地附件库路径）——主 agent 可以直接定位原图重读，不再瞎猜图片文件。
- **视觉模型自动识别**：从 LLM 目录自动发现所有声明 `input: [text, image]` 的模型（不注册任何 provider——模型配置仍以你的 `llm-pi-ai` / `llm-deepseek` 为唯一来源）。
- **免费优先、质量优先**：排序 = 免费（`freeProviders` 名单 / candidates 显式标注 / 名称启发式）优先 → 质量（candidates 标注 1~5）优先。

## 安装

```sh
dsh plugin --profile web add "link:G:\deepseek harness\.tools\skills-src\dsh-vision-bridge"
```

重启 `dsh web` 生效。

## 配置（`~/.dsh/settings.yaml`）

```yaml
dsh-vision-bridge:
  vision:
    transcribeTimeoutMs: 90000        # 单次转写尝试超时
    maxAttempts: 2                    # 最多尝试多少个视觉路由（默认 2，>=1）
    fallbackToDirect: true            # 子 agent 全部失败后，直连 llm.stream 再试一次
    includeAttachmentInfo: true       # 失败占位符附带图片文件名/附件ID/本地附件库路径
    includeUserText: true             # 把图片消息里的用户文本一并传给视觉模型（带需求读图）
    transcribePrompt: ...             # 可选：自定义转写指令（默认中文逐字转写）
    modelSelection:
      mode: auto                      # auto（自动发现+排序）| manual（显式路由）
      freeProviders: [trae-solo]      # 这些 provider 的视觉模型视为免费，优先选用
      candidates:                     # 可选：显式标注候选的质量（1~5）
        - provider: trae-solo
          model: glm-5.2
          free: true
          quality: 5
        - provider: opencode-go
          model: qwen3.6-plus
          quality: 5
      manual:                         # mode: manual 时使用
        provider: opencode-go
        model: mimo-v2.5
```

视觉模型 = 在 `llm-pi-ai` 的 provider 配置里声明了 `input: [text, image]` 的模型。例如 TRAE SOLO（免费）的 GLM/Kimi/Doubao 系列：

```yaml
llm-pi-ai:
  providers:
    trae-solo:
      baseURL: http://192.168.2.16:7864/v1
      apiKeyEnv: TRAE_SOLO_API_KEY
      models:
        - id: glm-5.2
          name: GLM-5.2
          input: [text, image]      # 声明支持图片
```

## 工作原理

```
用户附图（+文字需求）──▶ host 准入（自动补丁放行任意文本模型）
         ──▶ agent/pre-step（插件）：检测图片 → 自动选择视觉模型（免费优先、质量优先）
             └─▶ spawn 一次性读图子 agent（图片 + 用户附言 + 转写指令 → 视觉模型）
                 → 图片块替换为转写文本（含对用户需求的回应）
         ──▶ 主模型（任意文本模型）继续处理
```

- 原生看图模型（声明 image 模态）的会话**不干预**——直接看图；读图子 agent 跑在原生视觉模型上，天然防递归。
- 手动回退/恢复 host 补丁：`pwsh -File patch-host-apiproxy.ps1` / `-Revert`。

## 故障排查

| 现象 | 原因与解决 |
|---|---|
| 官方文本模型贴图被拒 | 插件未加载或补丁未生效：重启 dsh web；或手动跑 `patch-host-apiproxy.ps1` |
| 回复"未发现可用的视觉模型" | 没有任何 provider 声明 `input: [text, image]` 的模型：检查 `llm-pi-ai` 配置 |
| 转写失败 MISSING_CREDENTIAL | 视觉模型的 `apiKeyEnv` 对应 key 未配置 |
| 转写失败 RATE_LIMIT | 免费档限流：新版本会自动换下一个候选视觉路由重试；仍失败则检查 candidates |
| 提示"视觉子 agent 未完成 (aborted)" | **旧版本（<0.2.0）的已知 bug**：`start()` 返回后立即 abort 了子 agent 的 signal，导致子 agent 从未运行、必然 aborted。0.2.0 已修复：signal 生命周期覆盖整个子 agent 运行，且失败自动换路由重试 + 直连降级。升级后重启 dsh web 生效 |
| 失败占位符提示"原图文件: C:\Users\...\attachments\..." | 转写失败但主 agent 可按此路径直接读取原图继续处理（视觉 workflow 重读） |

## Model Experience

### Request surface and condition

#### What the model sees

用户消息带图、且当前步骤模型未声明 `input: [text, image]` 时，插件在 `agent/pre-step` 拦截：
- 图片块被替换为转写文本，格式为 `【图片内容转写】\n<转写结果>`；
- 转写失败时替换为 `【图片转写失败: <原因>】`（含已尝试路由、来源图片信息）。

转写由一次性读图子 agent 完成，其视觉模型按「免费优先、质量优先」从 LLM 目录自动发现。`includeUserText`（默认开）会把图片所在消息的用户文本一并传给视觉模型。

##### Verbatim text for this field

```markdown
【图片内容转写】
<转写结果>
```

```markdown
【图片转写失败: <原因>】
```

#### Token effect

对主模型：图片 token 被替换为等量文本 token（通常远小于图片的视觉 token 开销），**零图片 token 直达主模型 API**。视觉子 agent 是独立模型请求，其 token 计入对应视觉 provider 的用量（不占主模型上下文）。

#### KV Cache effect

前缀不稳定：主模型上下文中的图片转写文本随图片内容变化，且 `【图片内容转写】` 前缀固定但正文不重复，**不构成可复用的稳定前缀**；视觉子 agent 请求为一次性独立请求，无跨请求缓存复用。

## Known Limitations and Deferred Work

- **视觉模型需自行配置** — 插件不注册任何 provider；若 `llm-pi-ai` / `llm-deepseek` 没有任何声明 `input: [text, image]` 的模型，转写降级为 `【图片转写失败: 未发现可用的视觉模型】`。
- **读图子 agent 是一次性的** — 每次转写 spawn 全新子 agent，无状态复用；高频率贴图场景会有额外的子 agent 调度开销。
- **host 补丁依赖宿主文件路径** — `patch-host-apiproxy.ps1` 只覆盖已知的 DSH 安装布局；`npm update -g @deepseek-ai/dsh` 后插件会自愈重打，但手动改过 host 文件的环境需人工确认。
- **转写即失真的边界** — 转写是文本近似，复杂图表/精确颜色/细粒度视觉信息可能丢失；`includeAttachmentInfo` 可让主 agent 失败时按附件路径重读原图。
- **TRAE 上游兼容性** — 视觉模型若为 TRAE 免费路由（trae-solo），注意其 `messages.role` 只接受 `system/assistant/user/tool`；TRAE 上游 4027 错误会中断流（traework2api 已在代理层归一化 `developer` role）。

## 许可

MIT
