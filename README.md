# dsh-diary

每天一篇日记：**当天有哪些会话、重点是什么、花了多少 token**，外加**自己写的一段体会**。面板极简，只有列表、详情和几个按钮。

## 口径（重要）

- **token 数字是估算，不是计费记录。** 它来自 `tokenUsage` 投影，是 token-meter 对上下文的估算占用，和账单无关。
- 一个会话算哪一天，由它的 `header.createdAt` 落在 **Asia/Shanghai（UTC+8，无夏令时）** 的哪一个自然日决定。
- 统计只从**投影**读：live 会话用 `sessionProjections.snapshot(session, ['sessionStats','tokenUsage'])`，非 live 会话用 `sessionProjectionCache.cachedSnapshot(header, …)`。不订阅 session/event，不遍历 `session.events` 做统计。
- 同一天的条目在重新生成时会被整体覆盖；历史日期不会被自动重算。

## 文件

```
dsh-diary/
├── package.json        # 包声明、exports、dsh.bundle.patch、dsh.client
├── cordis.patch.yml    # 只挂本插件一行（依赖由 dsh-base / dsh-web-app 提供）
├── index.js            # Host：投影读取、聚合、总结、手写体会、storage、HTTP API、每日定时
├── client.js           # Web：settings.section 里的「每日日记」面板
├── locale/{en,zh}.json # meta.title / meta.description
├── icon.svg            # 自绘图标（356B）
└── README.md
```

## 数据流

```
sessionQuery.listSessions()                → 当天 createdAt 的会话列表
  ├─ live  → sessionProjections.snapshot(session, KEYS)
  └─ 非live → sessionProjectionCache.cachedSnapshot(header, KEYS)
        → { sessionStats, tokenUsage }
        → 条目 { sessions[], totals, highlights, journal? }
        → storageDomain('diary').table('entries').put(date, entry)
        → GET  /dsh-diary/api/days | /day | /diag   ← client.js fetch
        → POST /dsh-diary/api/journal | /generate   ← client.js fetch
```

持久化落在 `dsh-storage-json` 的默认根：`~/.dsh/storages/diary.json`（`domain: diary`, `version: 1`, `layout: single`, 表 `entries`）。

## 我的体会

自动生成的 `highlights` 和手写的 `journal` 是**两个独立字段**，互不覆盖：

- 面板里每天详情有一个 `textarea`，写完点「保存体会」即写入 `entry.journal = { text, updatedAt }`。
- **重新生成当天条目不会冲掉体会**：`generateDay()` 在覆盖前先读出旧条目的 `journal` 再写回。
- 清空输入框并保存，等于删除 `journal`。如果这天只是为了写体会才建的骨架条目（没有会话、没有要点），清空后整条删除，列表里不会留空行。
- 某天还没生成过日记时也能直接写体会：会先建一条 `reason: 'journal'` 的骨架条目，之后生成当天日记时会把聚合数据合并进去。
- 单条上限 4000 字符（`JOURNAL_MAX`），超出由 Host 侧拒绝并返回错误。
- 在输入框里按 `Escape` 不会关闭详情（`stopPropagation`），避免丢掉未保存的内容。

## 重点总结

1. `ctx.llm.stream({ provider, model, messages })`，provider/model 默认取 `agentDefaultModel.currentSelection()`，也可用 `Config` 覆盖。
2. 从当天会话里抽若干条用户消息原文做输入（最多 6 个会话 × 2 条）。
3. 输出解析成最多 `summaryPoints` 条要点。
4. **任一环节失败都不让插件失败**：降级为「统计行 + 用户消息原文摘录」，条目里 `highlightSource` 记为 `fallback`，面板显示「原文摘录」。

## 定时

每天 `Config.time`（默认 `23:00:00`，Asia/Shanghai）在插件内部用 `setTimeout` 链触发一次「生成当天日记」，定时器注册在 `ctx.effect` 里、卸载时清除。

> 为什么不用 `dsh-schedule`：`ScheduleService.create(sessionId, request)` 的签名强制绑定一个真实会话，且它的投递语义是「到点往那个会话塞一条提醒」，需要有 agent 消费才会推进业务逻辑。本插件是 host 单例、不绑定任何会话，用 schedule 反而无法自己落库。这里保留内部定时器，配上 `boot` 补生成（启动时若当天条目不存在则补一次）。

## Config

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `time` | `23:00:00` | 每日自动生成时刻（HH:MM 或 HH:MM:SS） |
| `timeZone` | `Asia/Shanghai` | 计算自然日的时区（当前实现固定 UTC+8） |
| `retentionDays` | `90` | 保留天数，`<=0` 不清理 |
| `panelDays` | `14` | 面板默认列出最近多少天 |
| `summaryPoints` | `4` | 每天最多几条重点 |
| `autoGenerate` | `true` | 是否启用每日定时 |
| `provider` / `model` | 空 | 总结用模型，留空取 `agentDefaultModel` |

## HTTP API（面板唯一数据入口）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/dsh-diary/api/days[?days=N]` | 最近 N 天的条目摘要（含未生成的日期占位） |
| GET | `/dsh-diary/api/day?date=YYYY-MM-DD` | 某天的完整条目 |
| GET | `/dsh-diary/api/diag?date=YYYY-MM-DD` | 当天每个会话的原始投影读数（核对用） |
| POST | `/dsh-diary/api/generate` | 立即生成某天（body 可带 `{"date":"YYYY-MM-DD"}`） |
| POST | `/dsh-diary/api/journal` | 写入/清空体会，body `{"date":"YYYY-MM-DD","text":"…"}`，`text` 为空串即删除 |

## 面板

挂在 `settings.section`（设置 → 每日日记），列出最近 `panelDays` 天，点击展开当天详情：重点总结、**我的体会**编辑区、会话明细表、口径说明。列表行会用 `有体会` 徽标标出哪些天写了东西。样式只用 `--dsw-alias-*` 主题 token，无写死颜色、无动画、无渐变。

## 安装

```
plugin_manager action=install_bundle target="…\default-workspace\dsh-diary"
```

不要手写 profile 的 `package.json` / `cordis.patch.yml`，也不要在 profile 目录跑 pnpm。

## 已知限制

- 时区固定 UTC+8 实现，`timeZone` 只是标注；改成其它时区需要改代码。
- 条目是生成那一刻的快照；会话之后继续增长，不会自动回填到已生成的条目。
- 体会和条目同生命周期：`retentionDays` 清理旧条目时，那天的体会会一起删掉。
- 面板的视觉呈现（亮/暗主题实际观感、是否有 slot 渲染报错）需要在浏览器里确认，命令行侧只能验证到 slot 注册为 active。
