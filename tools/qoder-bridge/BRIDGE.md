# Qoder Token Monitor 桥接

让 [Token Monitor](https://github.com/Javis603/token-monitor) 把 **Qoder（国际版）** 识别为一个受跟踪的客户端，在桌面悬浮窗里实时显示 Qoder 的 token 消耗量、费用和实时 token 速率。

本项目不修改 Qoder，也不读取 Qoder 的 cookie、token 或网络接口：用量来自 Qoder 在本机留下的会话记录，额度来自 Qoder 主进程日志中最近一次的用量快照。结果会合并进 Token Monitor 自带的 `tokscale` 采集器。安装过程会给 `app.asar` 打补丁，但会先留一份原始备份，可完整卸载。

## 效果

2026-10-25 在本机 Token Monitor v0.78.0 上验证通过：

| 视图 | 结果 |
| --- | --- |
| 今日 | 约 115M tokens / 约 $1.01，缓存命中 97.7%，780+ 次调用 |
| 实时速率 | 会话内约 120 tok/s（输出侧），底栏 TPM 包含缓存输入 |
| 会话 | 按 Qoder 会话列出调用次数、缓存命中率、token、tok/s |
| 模型 | `DeepSeek-V4.1-Flash 1024`、`Qwen3.8-Flash`、`Kimi-K3.1-Pro` 等可读名称 |
| 额度 | Qoder Teams：2173 / 3000 credits，剩余 72%，Reset 11d 19h |
| 边栏 | 右侧 Qoder 环显示 72%，位置在 Codex / WorkBuddy 之前 |

## 它是怎么工作的

```
Token Monitor (Electron)
  └─ collector ── spawn ──> resources/app.asar.unpacked/node_modules/tokscale/bin.js
                                                   │  （安装时被替换为 loader）
                                                   ▼
                                        qoder-bridge/shim.cjs
                                         ├─ 调用 tokscale-real.exe 拿原生客户端数据
                                         ├─ 读取 Qoder 本机会话 → 估算 token
                                         └─ 合并 JSON / graph 后返回
```

### 1. app.asar 补丁

安装脚本会解开 `app.asar`，对最多 12 个文件做定点替换（每个锚点都要求恰好命中一次），再用自定义打包器按原始归档的 unpacked 清单重打包。0.93.1 原生支持 Qoder 后，客户端目录/数据源/健康检查/监听补丁会被自动跳过，实际应用 8 个文件；0.90 仍应用全部：

| 文件 | 修改 |
| --- | --- |
| `src/shared/clientCatalog.js` | 在客户端目录中加入 `qoder`（默认跟踪，`forkOnly`） |
| `src/shared/clientSources.js` | 加入 Qoder 的数据源：`~/.qoder/projects`、`com.qoder.app.stable/main.sqlite`、`chat-session-turn-payload-buffer.sqlite` |
| `src/shared/clientHealth.js` | 为上述 3 个数据源注册健康检查 |
| `src/shared/collector.js` | 监听 Qoder 的 JSONL 与两个 SQLite（含 `-wal`/`-shm`）；监听事件只触发“今日 + Qoder”的定向扫描 |
| `src/shared/wslUsage.js` | 把 `qoder` 排除出 WSL 扫描（Qoder 数据在 Windows 侧） |
| `src/shared/providers/qoder/limits.js` | 额度读取：优先解析 Qoder 主进程日志里的真实 credits 快照；无快照时保留原有 cookie 流程 |
| `src/electron/edgeDock/presentation.js` | 过期额度仍保留最近一次读数，环变暗而不是显示 `--` |
| `src/electron/renderer/app.js` | 模型详情中的缓存命中/未命中比例显示到小数点后一位（例如 97.2% / 2.8%）；实时速率改由底部居中的读数常驻显示；冷启动缓存快照只在页面为空时填充，不覆盖已到达的新数据 |
| `src/electron/main.js` | 每次成功扫描后把最新的 stats 快照写入 `last-stats-cache.json`；冷启动先向主窗口/边栏推送上次快照，真实扫描完成后正常覆盖（最长沿用 7 天，客户端升级后自动失效） |
| `src/electron/renderer/styles.css` | 关闭标题栏 `Σ` 图标的悬停速率提示，避免速率只在左上角按需出现 |
| `src/shared/usage.js` | 把报告条目里的 `contextTokens`/`contextWindow` 带进会话；Qoder 会话也能显示上下文占用和边栏余量 |

安装时还会把 `assets/icon-win.png` 替换为无背景的黑色 Σ 图标（`src/assets/tray-sigma.png`）。Windows 托盘设置为“仅应用图标”（`trayContent: "icon"`）时，右下角显示的就是这个 Σ；可执行文件本身的任务栏图标不受影响。

v0.90.0 适配说明：旧版 `edgeDock/controller.js` 的懒窗口内存补丁没有继续套用，v0.90 上游已经重写了边栏窗口生命周期并自带内存改进；桥接 `shim.cjs` 增加了 `--bucket-timezone` 参数解析（v0.90 新参数，否则会把时区值误当子命令并透传 `qoder`），并把带 Qoder 的 `--home` 能力探针直接以空报告返回，避免被原生二进制 30 秒 pricing 拉取拖过 10 秒探针超时。

v0.93.1 适配说明（2026-11-19）：0.93.1 已原生包含 Qoder 客户端目录、`~/.qoder/projects` 数据源、健康检查和 Qoder 额度 provider。安装器会检测 `clientCatalog.js` 里的 `id: 'qoder'`，跳过重复的目录/数据源/健康/监听补丁，只保留本地增强：WSL 排除、无 cookie 时从 Qoder 主进程日志读取额度、边栏过期读数、缓存比例小数、冷启动快照、设计/会话状态条、每日历史解耦，以及把报告条目里的 `contextTokens`/`contextWindow` 带进会话。设置（绿色 Qoder、Qoder+Codex 边栏、隐藏 WorkBuddy、DeepSeek 别名、托盘 Σ、`qoderSite`、CNY、关闭会话归档）全部保留；升级前备份在 `D:\Qoder\Work\backups\token-monitor-pre-update-v0.93.1-2026-11-19`，升级并重装补丁后的完整快照在 `D:\Qoder\Work\backups\token-monitor-post-update-v0.93.1-2026-11-19`。

冷启动时主窗口会先显示上一次扫描的快照（token、模型、额度都包括），等后台首次扫描完成后自动换成新数据；边栏额度环也会先沿用上次的读数。快照写在 `%APPDATA%\Token Monitor\last-stats-cache.json`，超过 7 天或 Token Monitor 版本变化后不再沿用；删除该文件即可清空记忆。

重打包后会校验：unpacked 文件集合与原始归档一致、完整文件列表一致、Qoder 目录项存在。写入时先写临时文件再原子替换；如果 `app.asar` 被其他进程占用（例如 Qoder 自身），退化为原地覆盖并回读校验 SHA-256。

### 2. tokscale 入口替换

Token Monitor 通过 `node_modules/tokscale/bin.js` 启动 Rust 版 `tokscale.exe`。安装脚本：

1. 把 `tokscale.exe` 改名为 `tokscale-real.exe`；
2. 把 `bin.js` 换成一个 loader，动态加载 `qoder-bridge/shim.cjs`；
3. loader 运行在 Electron 的 Node 里（`ELECTRON_RUN_AS_NODE=1`），与原入口的方式一致。

`shim.cjs` 的命令路由：

- `--json` 的 `scan` / `graph`：先调用 `tokscale-real.exe` 拿原生客户端结果，再读取并合并 Qoder 数据；
- `--help`、TUI、交互式扫描、`models`、`pricing` 等命令：原样透传，不改变输出；
- `--test-data`：透传（fixture 里没有 Qoder）；
- `--home` 探测：Qoder 数据在真实 home 下，因此全 Qoder 的探测直接返回空报告，混合客户端则交给原生二进制判定；
- `--client qoder` 单独请求：只返回 Qoder 数据。

### 3. Qoder 数据读取与估算

数据来源（全部只读）：

- `~/.qoder/projects/<project>/<sessionId>.jsonl` 及 `<session>/subagents/*.jsonl`：逐轮对话、工具调用、模型名、时间戳、`context_usage_ratio`、credits；
- `%APPDATA%\com.qoder.app.stable\main.sqlite`：会话标题、项目、模型等元数据，以及 `chat_model_preferences` 里的真实上下文窗口；
- `%APPDATA%\com.qoder.app.stable\chat-session-turn-payload-buffer.sqlite`：正在进行的回合（配合 `-wal`/`-shm`），用于把“当前这一轮”也算进实时速率；
- `%APPDATA%\com.qoder.app.stable\logs\*\main.log`：Qoder 自己刷新账户用量时写下的 credits 快照，用于额度条（不读取任何 cookie/token）。

SQLite 通过内置 `node:sqlite` 以只读方式打开，不写入 Qoder 的任何文件。

数据精度一览：

| 数据 | 来源 | 精度 |
| --- | --- | --- |
| 调用次数、模型、时间、credits | Qoder assistant 行的 `message.usage` | 原始记录，未估算 |
| 输入 token | `context_usage_ratio × 上下文窗口` | 估算；窗口来自 Qoder 数据库 |
| 输出 token（含 thinking） | assistant text/thinking/tool_use 内容长度 | 估算，通常是最主要的不确定项 |
| 缓存命中 | 同会话/模型/流的前一次上下文，5 分钟 TTL | 估算；Qoder 服务端不返回 token 计数 |
| 额度 used/total/remaining、套餐 | Qoder `main.log` 的用量快照 | 服务端原始值，但可能已过期 |
| 费用 | credits × 套餐单价 | 由原始 credits 折算 |

同一个会话里，我们的 assistant 调用组数与 Qoder 自己 `sessionStats.messageCount` 基本一致（验证时 594 vs 589，差额来自快照之后继续产生的请求），说明请求级去重没有漏计或重复。

token 估算与映射规则：

- **输入 token** = `context_usage_ratio × contextWindow`。上下文窗口优先读 Qoder 的 `chat_model_preferences`（例如 `dfmodel` 为 400,000），其次用内置映射，未知模型默认 200k；
- **输出 token** = 对 assistant 内容块做保守估算：CJK 约 1 token/字，ASCII 约 3.7 字符/token，空白约 8 字符/token；
- **输入缓存命中** = 基于同一会话、同一模型、同一 subagent 流的前一次请求上下文做前缀复用估算；5 分钟内且上下文不缩小时，前一次上下文视为命中，剩余部分记为未命中。Qoder API 返回的 `input_tokens`/`cache_read_input_tokens` 全是 0，所以这是估算值，不是服务端读数。模型详情里的命中/未命中比例显示到小数点后一位；
- **耗时** = 回合起止时间，限制在 250ms–5min，避免异常停顿把速率拉低/拉高。会话里的 `tok/s` 是输出 token / 回合耗时；顶栏的 TPM 走 Token Monitor 的 burn 口径，包含缓存命中的输入 token，所以数值会远大于 `tok/s`；
- **费用** = credits × 套餐单价。程序从额度快照里的 `userType` 判断套餐：Teams/Enterprise 近似按 $40 / 3,000 credits（$0.0133/credit；Enterprise 实际是合同价），个人 Pro/Pro+/Ultra 按 $0.01/credit；未知套餐回退 $0.01；
- 同一会话内按内容块去重，增量落盘到 `~/.qoder-token-monitor/state.json`（保留 21 天），保证多次扫描不会重复计数、总量不回退。状态同时保存“上下文总量 = 未命中 + 命中”，当两次扫描对同一次请求给出不同的缓存拆分时，不会把两部分的最大值相加而虚增总量；
- 已完成的 JSONL 解析结果按文件 `mtime + size` 缓存，只有正在写入的会话需要重读；全量 graph 扫描由约 0.5 秒降到几十毫秒。

模型 id 在进入报告前会映射成可读名称。优先读取 Qoder 安装目录里的动态文案 `resources/dynamic-text/qoder.json`（`model.<id>.label` / `.description`），从这里取 Qoder 自己的 label 和 description 里的具体版本；静态表只在读不到目录时兜底：

| Qoder id | 典型显示名（以动态目录为准） |
| --- | --- |
| `dfmodel` | DeepSeek-V4.1-Flash 1024（主版本与目录一致时保留自定义名） |
| `dmodel` | DeepSeek-V4-Pro |
| `qfmodel` | Qwen3.8-Flash |
| `qmodel_38max` | Qwen3.8-Max |
| `qmodel_latest` | Qwen4-Max（历史 Qwen4-Max-Preview 单独成行） |
| `kmodel_latest` | Kimi-K3.1-Pro |
| `kmodel` | Kimi-K2.8-Preview |
| `gmodel` / `gfmodel` | GLM-5.3 / GLM-5.3-Flash |
| `mmodel` | MiniMax-M3.1-Flash |
| `smodel` | Sonus |
| `cmodel` | Cantus |

动态目录的版本号来自 `description`（例如 `DeepSeek-V4.1-Flash-1017`）。Qoder 升到 4.2 后，只要目录里的版本变成 `DeepSeek-V4.2-Flash-...`，`dfmodel` 的显示名会自动切换；主版本相同则保留现有 `... 1024` 后缀，避免无意义的历史改名。目录读不到时回退 `src/qoder-data.js` 的 `MODEL_LABELS`。Qoder 客户端自己的模型选择器目前显示 `DeepSeek-Flash`，上下文窗口取自 Qoder 数据库（当前为 1,000,000）。

目录文案会落后于服务端（`qmodel_latest` 的目录项仍写着 Qwen3.7-Max），所以桥接层还读取 `~/.qoder/logs/runs/*/qodercli.log` 里每次请求的实时 `model_config`（`display_name`）。每出现一个新名字就记录首次出现时间：`qmodel_latest` 从 Qwen4-Max-Preview 换成 Qwen4-Max 后，11 月 11 日的 Preview 调用保留在 `Qwen4-Max-Preview` 行，11 月 16 日起的调用进入新的 `Qwen4-Max` 行，旧数据不会被重命名。名字只有“同一模型的简称”关系时才沿用详细名（例如日志里的 `DeepSeek-Flash` 不会覆盖 `DeepSeek-V4.1-Flash 1024`）。时间线保存在 `~/.qoder-token-monitor/qoder-model-labels.json`，日志按 `mtime + size` 增量扫描，首次全量约 0.5 秒，之后每分钟最多扫一次变化的文件。

### 4. 界面 polish 与会话状态条

安装器会在 `styles.css` 末尾追加 `src/assets/design-polish.css`、`insights.css`，在 `app.js` 末尾追加 `design-polish.js`、`insights.js`：

- **会话状态条**：总览费用下方常驻一行“最近会话”：模型、项目、上下文余量、缓存命中率、当前 provider 额度、调用次数和会话花费；点击展开明细卡，含 token 拆分、推理、平均输出速度、每百万 token 花费、每模型明细和额度重置时间。数据只来自已有的 `stats:push`/`settings:get`，没有新增进程、窗口或定时器。
- **动效**：总览数字的 accent 光晕与分隔线、费用胶囊、模型行 hover 底板、进度条前沿高光、Home 分批入场、费用变化闪烁；视图切换时的 220ms 淡入上浮和每个视图的滚动位置记忆。花费卡从触发点展开、关闭时短淡出，底栏速率数字沿用现有的新样本信号做 160ms 上浮，最近会话变化时状态条淡入一次。所有动效只用 `transform`/`opacity`，系统的 reduced-motion 和设置里的 Reduce motion 都会关闭；关闭卡片用 `animationend` 收尾，不新增定时器。
- **上下文**：Qoder 的活跃回合在 buffer 里没有 `context_usage_ratio`，所以状态条先隐藏上下文；回合写回 JSONL 后自动出现。`usage.js` 的补丁把条目上的 `contextTokens/contextWindow` 带进会话，历史会话和边栏的余量读数也能用。

Qoder 的 `auto` 选择器在会话元数据里已经解析成实际模型（`dfmodel` 等），桥接层会把 Auto 的 usage 归到实际模型，缓存前缀估算也不再被 `auto` 边界打断。Token Monitor 的“保留已删除会话用量”归档里仍存有旧版写入的 `auto` 行；本机把 `sessionUsageArchiveEnabled` 设为 `false`，让这些历史缓存不再投影到统计里（不删除归档本身）。以后清空保留数据并重新开启该选项即可恢复归档功能。

上游 `src/electron/runtimeConfig.js` 里 `dailyHistoryArchiveEnabled` 原本跟 `sessionUsageArchiveEnabled` 绑定，关掉会话归档会把每日趋势图一起冻结。安装器现在把这一项改为跟 `historyEnabled` 走：每日历史归档继续采集，但会话归档仍可保持关闭。本机验证 2026-11-17、2026-11-18 的每日趋势条恢复，且 `auto` 幽灵行没有回来。

### 5. Qoder 额度

Token Monitor 内置的 Qoder 额度 provider 原本需要手动粘贴 qoder.com 的 cookie。这里的补丁优先读取 Qoder 主进程 `main.log` 中最近的 `account.getQuotaUsage` 响应摘要，直接得到：

- 已用/总量/剩余 credits（含共享额度）；
- 套餐类型（Teams/Enterprise）；
- 下次重置时间；
- 快照时间（Token Monitor 会据此显示 “Stale · xx ago”）。

这样不需要登录 Token Monitor、也不需要 cookie。Qoder 自己刷新额度并不频繁（通常打开 Qoder 账户/用量面板会触发一次）；Token Monitor 会持续显示最近一次快照，并标出它是多久之前的。日志超过 7 天或找不到时，会回退到原来的 cookie 流程。

### 6. 边栏额度环

设置里的 `edgeDockItems` 现在显式把 Qoder 放在第一位：

```json
[
  { "type": "limit", "provider": "qoder", "hiddenAccounts": [], "showUsage": true, "showSessions": true, "windowKey": "", "accountMode": "lowest" },
  { "type": "limit", "provider": "codex", "...": "..." },
  { "type": "limit", "provider": "workbuddy", "...": "..." }
]
```

Qoder 只有一个 `Credits` 计费窗口，且没有 `metric: "credits"`，所以边栏画的是**剩余百分比环**（72%），不是金额。原版边栏遇到 `stale` 的额度会直接隐藏读数并显示 `--`；Qoder 的额度只在它自己的账户面板刷新时才写日志，快照经常超过 10 分钟，因此补丁让边栏保留最近一次读数，同时把状态标成 `stale`，环的填充色会变暗——数字仍然可读，但不会假装它是刚刷新过的。打开 Qoder 的账户/用量面板后，下一次 Token Monitor 刷新会读到新快照，环恢复正常亮度。

### 7. 底部实时速率

原版把实时 `tok/s` 放在标题栏 `Σ` 图标旁，只有窗口收窄到 icon-only 标题、再把鼠标移到图标上才展开；底部的常驻读数又会在“有可用更新”（`appUpdatePill` 可见）时被整行隐藏。补丁改成：

- 标题栏的悬停提示不再显示速率，速率只保留在底部；
- 底部读数固定在窗口最下方正中（`.live-token-rate` 本来就以 `left: 50%` 定位），更新按钮只占右侧 34px，不再遮挡它；
- live tracker 没有样本时（Qoder 的计时计数只在回合提交后增长，样本 8 秒过期），回退到当前周期的 `timedOutputTokens / timedDurationMs`，再回退到“今日”的同一比值，所以读数不会掉回 `—`；
- 空闲时保留最近一次读数并降低亮度，活跃时随统计推送刷新。

### 8. 内存与刷新频率

边栏原本在启动时就创建 `peek`、`rail`、`bubble` 三个 BrowserWindow，每个都是一个独立渲染进程。现在：

- 静止时只创建 `peek` 手柄，`rail` / `bubble` 在第一次悬停或点击时按需创建；
- 两者隐藏 5 分钟后自动销毁，下一次使用再重建；
- 主界面刷新从 15 秒改成 30 秒；采集器仍由文件监听事件触发，活跃会话的实时速率不受影响；
- 关闭 WSL 扫描（本机没有 WSL），减少 watcher 的目录遍历；
- 已完成的 Qoder JSONL 不再每次重读。

本机实测（同一台机器，主窗口内容量会波动）：

| 状态 | 进程数 | 工作集合计 |
| --- | --- | --- |
| 修改前（边栏三窗常驻） | 8 | 约 1,078 MB |
| 修改后静止（仅 peek） | 6 | 约 749 MB |
| 边栏展开（rail + bubble） | 8 | 约 1.04–1.06 GB |

展开时仍需要两个渲染进程，这是保留完整边栏功能的代价；回到静止状态 5 分钟后会释放。主窗口本身约 175 MB，GPU 进程约 140 MB，属于 Electron 基线，未通过关闭硬件加速来“省内存”（会破坏毛玻璃和动画）。

## 安装

要求：Windows（macOS/Linux 的路径已适配但未实机验证）、Node.js ≥ 22.12（`@electron/asar` 4.x 的要求）。运行时使用 Token Monitor 自带的 Electron Node 24，其内置 `node:sqlite` 负责读取 Qoder 数据库。

```bat
cd /d D:\Qoder\Work\qoder-token-monitor
npm install
npm run install-bridge
```

脚本会自动定位 `D:\Github\Token Monitor`，也可以显式指定：

```bat
node src/install.js --app-dir="D:\Github\Token Monitor"
```

安装前请**完全退出 Token Monitor**（包括托盘图标）。脚本会：

- 备份原始 `resources/app.asar` 到 `resources/qoder-bridge-backup/`；
- 重打包并写入补丁版 `app.asar`，记录原始/补丁 SHA-256；
- 安装 `qoder-bridge/` 与 loader，重命名原生二进制；
- 把 `qoder` 加入 `%APPDATA%\Token Monitor\settings.json` 的 `clients` 列表。

启动 Token Monitor 后，第一次全量扫描约需 30–40 秒，之后今日视图和实时速率就会出现 Qoder 数据。如果设置里 Qoder 未勾选，请在 **Settings → tools** 中勾选。

## 卸载

完全退出 Token Monitor 后：

```bat
npm run uninstall-bridge
```

脚本会：恢复原始 `app.asar`（回读校验 SHA-256）→ 恢复 `bin.js` 与 `tokscale.exe` → 删除 `qoder-bridge/` 与备份目录 → 从设置中移除 `qoder`。如果桥接文件被手动改过，需要加 `--force`。

卸载后再运行安装器会重新建立备份，可反复往返。

## 测试

```bat
npm test
```

覆盖 token 估算、缓存拆分状态的最大值合并，以及 Teams 套餐的费用换算；额度解析、模型映射和边栏环已在真实 Qoder 数据上手工验证。

## 已知限制与注意事项

- **token 数是估算值**，不是 Qoder 服务端账单。输入按上下文占比推算，输出按内容长度估算；长代码与工具调用可能偏差。
- **缓存命中率是估算值**：Qoder 本地记录的 input/cache/output token 全是 0，本项目按“同会话、同模型、5 分钟内的上下文前缀复用”推算；长思考、压缩、并行请求都会让估算与真实命中率有偏差。
- **上下文窗口按 Qoder 数据库读取**：`dfmodel` 当前是 400,000；旧版本曾默认 200k，所以升级后今日/本月 token 总量会明显变大。如果 `deepseek v4.1flash 1024` 的 `1024` 指 1,024K 窗口，请把 `KNOWN_MODEL_WINDOWS.dfmodel` 改成 `1024000`。
- **费用按套餐单价折算**：Teams/Enterprise 近似使用 $40 / 3,000 credits（$0.0133/credit），个人套餐 $0.01/credit，仅用于让图表有可比性；真实扣费以 Qoder 账单为准。可在 `src/qoder-usage.js` 的 `creditUsdRate()` 调整。
- **本地 credits 总和可能小于服务端额度用量**：本项目只读本机的 Qoder 会话；如果同一账号在别的设备、QoderWork/CLI 或已删除的会话里也消耗了 credits，服务端的 `used` 会更大。额度仍以日志快照为准。
- **额度是 Qoder 最近一次刷新时的快照**。Token Monitor 会显示 `Stale · xx ago` 而不是假装实时；边栏在快照过期时仍显示最近读数，但环会变暗。打开 Qoder 的账户/用量面板可触发一次刷新。本项目不读取 cookie/token，也不调用 Qoder 网络接口。
- **会话标题取自首条用户消息**，Qoder 侧重命名后不会同步。
- **Token Monitor 自动更新会覆盖补丁**。当前已确认设置里 `automaticAppUpdates: false`；若升级了客户端，先重装 Token Monitor，再运行一次 `npm run install-bridge`。如果旧备份和新版本冲突，安装器会报错，按提示删除 `resources/qoder-bridge-backup` 后重试（或用 `--force`）。
- **只支持 `--json` 扫描**：Token Monitor 的采集就是走 JSON，所以无影响；如果在终端里直接跑交互式 `tokscale`，Qoder 数据不会注入。
- 补丁锚点绑定 Token Monitor v0.90.0 / v0.93.1；其它版本会因锚点不匹配而拒绝安装，不会写出半成品。0.93.1 原生 Qoder 后不再需要目录/数据源/健康/监听补丁。
- 会话状态条里的上下文只在 Qoder 回合写回 JSONL 后出现；活跃 buffer 不带 `context_usage_ratio`，没有可估算的可靠输入。活跃回合的输入 token 也因此按 0 计，等提交后补齐。

## 目录结构

```
qoder-token-monitor/
├─ src/
│  ├─ install.js        安装：校验、解包、打补丁、重打包、装桥接
│  ├─ uninstall.js      卸载：恢复 asar / loader / 二进制 / 设置
│  ├─ atomic-file.js    原子写入（占用时原地覆盖）
│  ├─ qoder-shim.cjs    tokscale 入口 shim（合并 / 透传路由）
│  ├─ qoder-data.js     JSONL + SQLite 读取与 token 估算
│  ├─ qoder-usage.js    周期过滤、增量状态、tokscale 报告/图表构造
│  ├─ estimate.js       文本/内容块 token 估算
│  ├─ paths.js          Qoder 与状态目录解析
│  └─ assets/           注入的 motion / insights 样式与脚本、托盘图标
├─ test/                估算、图表合并、上下文透传单元测试
└─ README.md
```

安装后额外产生：

```
D:\Github\Token Monitor\resources\
├─ app.asar                         补丁版
├─ qoder-bridge-backup\
│  ├─ app.asar.original             原始备份
│  └─ manifest.json                 版本与哈希清单
└─ app.asar.unpacked\node_modules\
   ├─ tokscale\bin.js                loader
   ├─ tokscale\qoder-bridge\         shim + 数据层
   └─ @tokscale\cli-win32-x64-msvc\bin\tokscale-real.exe
                                     原生命名后的二进制
```

用户状态：`%USERPROFILE%\.qoder-token-monitor\state.json`（可安全删除，删除后重新全量扫描，历史 token 会重新计算）；`qoder-model-labels.json` 保存模型显示名的首次出现时间线（可安全删除，删除后会重新读取 Qoder CLI 日志重建）。
