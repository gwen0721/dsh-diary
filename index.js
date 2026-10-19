/**
 * dsh-diary — 每日日记 Host 半身
 *
 * 数据口径（写进 README 与面板）：
 * - 聚合数字只从会话日志的投影读：ctx.sessionProjections.snapshot(session, keys)
 *   取 `sessionStats` 与 `tokenUsage`；不订阅 session/event，也不遍历
 *   session.events 做统计。
 * - 一个会话归属哪个自然日，由它的 header.createdAt 落在 Asia/Shanghai
 *   （UTC+8，无夏令时）的哪一天决定。
 * - token 数字是 token-meter 的估算占用，是参考值，不是计费记录。
 */

import z from '@deepseek-ai/schemastery'

const LOG_PREFIX = '[dsh-diary]'
const DOMAIN_NAME = 'diary'
const DOMAIN_VERSION = 1
const TABLE_ENTRIES = 'entries'
const API_PREFIX = '/dsh-diary/api'
const TIME_ZONE = 'Asia/Shanghai'
const TZ_OFFSET_MS = 8 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const PROJECTION_KEYS = ['sessionStats', 'tokenUsage']
const NOTE = 'token 占用是 token-meter 的估算数字，仅作参考，不是计费记录。'

export const name = 'dsh-diary'

/** 硬依赖：没有持久化与 HTTP 路由就什么也做不了。其余服务用 ctx.get 可选访问。 */
export const inject = ['storageDomain', 'webServer']

export const Config = z.object({
  /** 每天的自动生成时刻，HH:MM 或 HH:MM:SS。 */
  time: z.string().default('23:00:00'),
  /** 计算自然日所用的时区（当前实现按固定 UTC+8 计算）。 */
  timeZone: z.string().default(TIME_ZONE),
  /** 保留多少天的日记条目；<=0 表示不清理。 */
  retentionDays: z.number().default(90),
  /** 面板默认列出最近多少天。 */
  panelDays: z.number().default(14),
  /** 每条日记最多几条重点。 */
  summaryPoints: z.number().default(4),
  /** 是否启用每天定时生成。 */
  autoGenerate: z.boolean().default(true),
  /** 总结用 provider；留空则取 agentDefaultModel。 */
  provider: z.string().default(''),
  /** 总结用 model；留空则取 agentDefaultModel。 */
  model: z.string().default(''),
})

const DIARY_SPEC = {
  name: DOMAIN_NAME,
  version: DOMAIN_VERSION,
  layout: 'single',
  tables: {
    entries: {
      // storage-domain 只调用记录 schema 的 parse()。保持宽容：坏记录不拖垮 domain 打开。
      valueSchema: {
        parse(value) {
          if (value === null || typeof value !== 'object' || Array.isArray(value)) {
            throw new Error('dsh-diary entry must be an object')
          }
          if (typeof value.date !== 'string') {
            throw new Error('dsh-diary entry.date must be a string')
          }
          return value
        },
      },
    },
  },
}

// ---------------------------------------------------------------- 纯工具函数

function pad2(n) {
  return n < 10 ? '0' + String(n) : String(n)
}

function dayKeyOf(ts) {
  const d = new Date(ts + TZ_OFFSET_MS)
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`
}

function dayStartOf(dayKey) {
  const ts = Date.parse(`${dayKey}T00:00:00.000Z`)
  return Number.isFinite(ts) ? ts - TZ_OFFSET_MS : NaN
}

function isDayKey(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  return Number.isFinite(dayStartOf(value))
}

function shiftDay(dayKey, delta) {
  const start = dayStartOf(dayKey)
  return Number.isFinite(start) ? dayKeyOf(start + delta * DAY_MS) : dayKey
}

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function clampText(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function parseClock(value, fallback) {
  const m = /^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/.exec(String(value ?? '').trim())
  if (m === null) return fallback
  const h = Number(m[1])
  const mi = Number(m[2])
  const s = Number(m[3] ?? 0)
  if (!(h >= 0 && h <= 23 && mi >= 0 && mi <= 59 && s >= 0 && s <= 59)) return fallback
  return [h, mi, s]
}

function nextRunAt(now, clock) {
  const [h, mi, s] = clock
  const dayStart = Math.floor((now + TZ_OFFSET_MS) / DAY_MS) * DAY_MS - TZ_OFFSET_MS
  const target = dayStart + (h * 3600 + mi * 60 + s) * 1000
  return target > now + 1000 ? target : target + DAY_MS
}

function textOfContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block)
      continue
    }
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join('\n')
}

/** 从一条会话事件里取出用户消息原文；不是用户消息返回 null。 */
function userMessageOf(event) {
  if (event === null || typeof event !== 'object') return null
  const candidate = event.data?.message ?? event.message ?? event.data ?? event.payload
  if (candidate !== null && typeof candidate === 'object' && candidate.role === 'user') {
    const text = textOfContent(candidate.content)
    return text.trim().length > 0 ? text : null
  }
  if (typeof event.role === 'string' && event.role === 'user') {
    const text = textOfContent(event.content)
    return text.trim().length > 0 ? text : null
  }
  return null
}

function parsePoints(text, limit) {
  const points = []
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    let line = raw.trim()
    if (line.length === 0 || line.startsWith('```')) continue
    line = line.replace(/^[-*•]\s*/, '').replace(/^\d+[.)、]\s*/, '').trim()
    if (line.length === 0) continue
    points.push(clampText(line, 200))
    if (points.length >= limit) break
  }
  return points
}

// ---------------------------------------------------------------- 插件本体

export function apply(ctx, config = {}) {
  const log = (...args) => console.log(LOG_PREFIX, ...args)
  const warn = (...args) => console.warn(LOG_PREFIX, ...args)

  const cfg = {
    time: typeof config.time === 'string' && config.time.trim().length > 0 ? config.time.trim() : '23:00:00',
    timeZone: TIME_ZONE,
    retentionDays: Number.isFinite(config.retentionDays) ? config.retentionDays : 90,
    panelDays: Number.isFinite(config.panelDays) && config.panelDays > 0 ? config.panelDays : 14,
    summaryPoints: Number.isFinite(config.summaryPoints) && config.summaryPoints > 0 ? config.summaryPoints : 4,
    autoGenerate: config.autoGenerate !== false,
    provider: typeof config.provider === 'string' ? config.provider.trim() : '',
    model: typeof config.model === 'string' ? config.model.trim() : '',
  }

  // ---- storage domain：同步登记 disposer，异步打开 ---------------------------------

  let domainPromise = null

  /** 定时器可观测状态：面板/诊断端点能如实报出「下一次什么时候跑」。 */
  const schedulerState = {
    enabled: cfg.autoGenerate,
    time: cfg.time,
    timeZone: TIME_ZONE,
    nextRunAt: null,
    lastRunAt: null,
    lastRunDay: null,
    lastRunOk: null,
    lastRunError: null,
  }

  function ensureDomain() {
    if (domainPromise === null) {
      const service = ctx.storageDomain ?? ctx.get('storageDomain')
      if (service === undefined || typeof service.open !== 'function') {
        return Promise.reject(new Error('storageDomain service is unavailable'))
      }
      const pending = service.open(DIARY_SPEC)
      pending.catch(() => {
        if (domainPromise === pending) domainPromise = null
      })
      domainPromise = pending
    }
    return domainPromise
  }

  ctx.effect(() => () => {
    const pending = domainPromise
    domainPromise = null
    if (pending === null) return
    pending.then((domain) => domain.close()).catch(() => {})
  }, 'dsh-diary: close storage domain')

  async function readEntry(dayKey) {
    const domain = await ensureDomain()
    return domain.table(TABLE_ENTRIES).get(dayKey)
  }

  async function writeEntry(entry) {
    const domain = await ensureDomain()
    await domain.table(TABLE_ENTRIES).put(entry.date, entry)
    return entry
  }

  async function listEntries() {
    const domain = await ensureDomain()
    const out = []
    for (const [key, value] of domain.table(TABLE_ENTRIES).entries()) {
      out.push(value !== null && typeof value === 'object' ? value : { date: key })
    }
    out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
    return out
  }

  async function pruneEntries() {
    if (!(cfg.retentionDays > 0)) return 0
    const domain = await ensureDomain()
    const table = domain.table(TABLE_ENTRIES)
    const cutoff = shiftDay(dayKeyOf(Date.now()), -cfg.retentionDays)
    let removed = 0
    for (const key of [...table.keys()]) {
      if (typeof key === 'string' && key < cutoff) {
        await table.delete(key)
        removed += 1
      }
    }
    return removed
  }

  // ---- 当天聚合：只读投影 ---------------------------------------------------------

  function makeRow(record) {
    const header = record.header
    const values = record.snapshot?.values
    const stats = values?.sessionStats
    const usage = values?.tokenUsage
    const inputTokens = num(usage?.uncachedInputTokens)
    const outputTokens = num(usage?.outputTokens)
    const cacheReadTokens = num(usage?.cacheReadTokens)
    const cacheWriteTokens = num(usage?.cacheWriteTokens)
    const cwd = typeof header.cwd === 'string' ? header.cwd : null
    return {
      id: String(header.id),
      createdAt: num(header.createdAt),
      cwd,
      label: cwd !== null && cwd.length > 0 ? cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd : String(header.id).slice(0, 8),
      asOfSeq: num(record.snapshot?.asOfSeq),
      projectionSource: record.source ?? null,
      turns: num(stats?.turns),
      steps: num(stats?.steps),
      llmMs: num(stats?.llmMs),
      toolMs: num(stats?.toolMs),
      ttftMs: num(stats?.ttftMs),
      ttftSteps: num(stats?.ttftSteps),
      decodeMs: num(stats?.decodeMs),
      decodeTokens: num(stats?.decodeTokens),
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
      statsAvailable: stats !== undefined && stats !== null,
      usageAvailable: usage !== undefined && usage !== null,
    }
  }

  function totalsOf(rows) {
    const totals = {
      sessions: rows.length,
      turns: 0,
      steps: 0,
      llmMs: 0,
      toolMs: 0,
      ttftMs: 0,
      decodeTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
      statsAvailable: rows.length > 0 && rows.every((row) => row.statsAvailable),
      usageAvailable: rows.length > 0 && rows.every((row) => row.usageAvailable),
    }
    for (const row of rows) {
      totals.turns += row.turns
      totals.steps += row.steps
      totals.llmMs += row.llmMs
      totals.toolMs += row.toolMs
      totals.ttftMs += row.ttftMs
      totals.decodeTokens += row.decodeTokens
      totals.inputTokens += row.inputTokens
      totals.outputTokens += row.outputTokens
      totals.cacheReadTokens += row.cacheReadTokens
      totals.cacheWriteTokens += row.cacheWriteTokens
      totals.totalTokens += row.totalTokens
    }
    return totals
  }

  /**
   * 读当天每个会话的原始投影快照。
   * 只走 projection 读路径：live 会话用 sessionProjections.snapshot(session, keys)，
   * 非 live 会话用 sessionProjectionCache.cachedSnapshot(header, keys)。
   */
  async function collectDayRecords(dayKey) {
    const start = dayStartOf(dayKey)
    const end = start + DAY_MS
    const sessionQuery = ctx.get('sessionQuery')
    const sessions = ctx.get('sessions')
    const projections = ctx.get('sessionProjections')
    const projectionCache = ctx.get('sessionProjectionCache')

    const candidates = []
    if (sessionQuery !== undefined && typeof sessionQuery.listSessions === 'function') {
      try {
        const listed = await sessionQuery.listSessions()
        candidates.push(...(Array.isArray(listed) ? listed : []))
      } catch (err) {
        warn('listSessions failed:', err?.message ?? err)
      }
    }
    if (candidates.length === 0 && sessions !== undefined && typeof sessions.list === 'function') {
      try {
        candidates.push(...sessions.list().map((session) => ({ header: session.header, live: true, persisted: false })))
      } catch (err) {
        warn('sessions.list failed:', err?.message ?? err)
      }
    }

    const records = []
    for (const record of candidates) {
      const header = record?.header
      if (header === null || typeof header !== 'object') continue
      const createdAt = num(header.createdAt)
      if (createdAt < start || createdAt >= end) continue

      let snapshot
      let source = null
      const live = sessions !== undefined && typeof sessions.get === 'function' ? sessions.get(header.id) : undefined
      if (live !== undefined && projections !== undefined && typeof projections.snapshot === 'function') {
        try {
          snapshot = projections.snapshot(live, PROJECTION_KEYS)
          source = 'live'
        } catch (err) {
          warn('projection snapshot failed:', err?.message ?? err)
        }
      }
      if (snapshot === undefined && projectionCache !== undefined && typeof projectionCache.cachedSnapshot === 'function') {
        try {
          snapshot = projectionCache.cachedSnapshot(header, PROJECTION_KEYS)
          source = 'cache'
        } catch (err) {
          warn('projection cache snapshot failed:', err?.message ?? err)
        }
      }
      records.push({ header, snapshot, source })
    }
    records.sort((a, b) => num(a.header.createdAt) - num(b.header.createdAt))
    return records
  }

  async function collectDay(dayKey) {
    const records = await collectDayRecords(dayKey)
    return records.map(makeRow)
  }

  // ---- 重点总结：llm.stream，失败降级为抽取用户消息原文 ---------------------------

  async function collectExcerpts(rows, perSession, maxSessions) {
    const sessionQuery = ctx.get('sessionQuery')
    const out = []
    if (sessionQuery === undefined || typeof sessionQuery.readSession !== 'function') return out
    for (const row of rows.slice(0, maxSessions)) {
      let snapshot
      try {
        snapshot = await sessionQuery.readSession(row.id)
      } catch (err) {
        warn(`readSession(${row.id}) failed:`, err?.message ?? err)
        continue
      }
      const events = Array.isArray(snapshot?.events) ? snapshot.events : []
      const texts = []
      for (const event of events) {
        const text = userMessageOf(event)
        if (text === null) continue
        texts.push(clampText(text, 400))
        if (texts.length >= perSession) break
      }
      if (texts.length > 0) out.push({ sessionId: row.id, createdAt: row.createdAt, texts })
    }
    return out
  }

  function buildPrompt(dayKey, totals, excerpts) {
    const lines = []
    lines.push(`日期：${dayKey}（${TIME_ZONE}）`)
    lines.push(`会话 ${totals.sessions} 个，共 ${totals.turns} 轮 / ${totals.steps} 步。`)
    lines.push('')
    lines.push('当天各会话的用户消息摘录：')
    for (const group of excerpts) {
      lines.push(`- 会话 ${group.sessionId.slice(0, 8)}：`)
      for (const text of group.texts) lines.push(`  · ${text}`)
    }
    lines.push('')
    lines.push(`请用中文总结当天重点，最多 ${cfg.summaryPoints} 条。`)
    lines.push('每条单独一行，以 "- " 开头；只写用户实际在做的事和产出，不要复述 token/耗时数字，不要客套话。')
    return lines.join('\n')
  }

  async function streamText(llm, route, prompt) {
    let out = ''
    const stream = llm.stream({
      provider: route.provider,
      model: route.model,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    })
    for await (const chunk of stream) {
      if (chunk === null || typeof chunk !== 'object') continue
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
        out += chunk.text
        continue
      }
      if (chunk.type === 'finish') {
        if (out.length === 0) throw new Error(`llm stream finished without text (reason: ${String(chunk.reason)})`)
        break
      }
    }
    return out
  }

  function fallbackPoints(totals, excerpts, limit) {
    const points = [`${totals.sessions} 个会话 · ${totals.turns} 轮 · ${totals.steps} 步`]
    for (const group of excerpts) {
      for (const text of group.texts) {
        points.push(clampText(text, 160))
        if (points.length >= limit) return points
      }
    }
    if (points.length === 1) points.push('当天没有可摘录的用户消息。')
    return points
  }

  /** agentDefaultModel 是方法服务：默认模型要调 currentSelection() 拿。 */
  function readDefaultSelection() {
    const service = ctx.get('agentDefaultModel')
    if (service === undefined || service === null) return null
    try {
      const current = typeof service.currentSelection === 'function' ? service.currentSelection() : null
      return current !== null && typeof current === 'object' ? current : null
    } catch (err) {
      warn('agentDefaultModel.currentSelection failed:', err?.message ?? err)
      return null
    }
  }

  async function buildHighlights(dayKey, rows, totals) {
    const limit = Math.max(1, Math.min(8, cfg.summaryPoints))
    const excerpts = await collectExcerpts(rows, 2, 6)
    const llm = ctx.get('llm')
    const selection = cfg.provider.length > 0 && cfg.model.length > 0 ? null : readDefaultSelection()
    const provider = cfg.provider.length > 0 ? cfg.provider : String(selection?.provider ?? '').trim()
    const model = cfg.model.length > 0 ? cfg.model : String(selection?.model ?? '').trim()

    if (llm !== undefined && typeof llm.stream === 'function' && provider.length > 0 && model.length > 0 && excerpts.length > 0) {
      try {
        const text = await streamText(llm, { provider, model }, buildPrompt(dayKey, totals, excerpts))
        const points = parsePoints(text, limit)
        if (points.length > 0) return { points, source: 'llm', provider, model }
        warn('llm returned no usable points; falling back')
      } catch (err) {
        warn('llm summary failed; falling back:', err?.message ?? err)
      }
    }
    return { points: fallbackPoints(totals, excerpts, limit), source: 'fallback', provider: null, model: null }
  }

  // ---- 生成并持久化 ---------------------------------------------------------------

  async function generateDay(dayKey, reason) {
    const rows = await collectDay(dayKey)
    const collectedAt = Date.now()
    const totals = totalsOf(rows)
    const highlights = await buildHighlights(dayKey, rows, totals)
    const entry = {
      date: dayKey,
      generatedAt: Date.now(),
      collectedAt,
      reason,
      timeZone: TIME_ZONE,
      note: NOTE,
      sessions: rows,
      totals,
      highlights: highlights.points,
      highlightSource: highlights.source,
      highlightProvider: highlights.provider,
      highlightModel: highlights.model,
    }
    await writeEntry(entry)
    pruneEntries().catch((err) => warn('prune failed:', err?.message ?? err))
    log(`entry ${dayKey}: ${rows.length} session(s), ${totals.turns} turn(s), highlights=${highlights.source}`)
    return entry
  }

  function daySummary(entry) {
    const totals = entry?.totals ?? {}
    return {
      date: entry.date,
      generatedAt: num(entry.generatedAt) || null,
      reason: entry.reason ?? null,
      sessions: num(totals.sessions),
      turns: num(totals.turns),
      steps: num(totals.steps),
      totalTokens: num(totals.totalTokens),
      highlightSource: entry.highlightSource ?? null,
      highlights: Array.isArray(entry.highlights) ? entry.highlights.slice(0, 2) : [],
      missing: false,
    }
  }

  // ---- HTTP API：面板与外部工具的唯一数据入口 -------------------------------------

  function sendJson(res, status, body) {
    const bytes = Buffer.from(JSON.stringify(body))
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': String(bytes.byteLength),
      'Cache-Control': 'no-store',
    })
    res.end(bytes)
  }

  async function readJsonBody(req) {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.length
      if (size > 64 * 1024) throw new Error('request body too large')
      chunks.push(buffer)
    }
    if (chunks.length === 0) return {}
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  }

  async function handleDays(searchParams) {
    const requested = Number(searchParams.get('days'))
    const limit = Math.max(1, Math.min(365, Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : cfg.panelDays))
    const entries = await listEntries()
    const byDate = new Map()
    for (const entry of entries) {
      if (isDayKey(entry.date)) byDate.set(entry.date, entry)
    }
    const today = dayKeyOf(Date.now())
    const days = []
    for (let i = 0; i < limit; i += 1) {
      const date = shiftDay(today, -i)
      const entry = byDate.get(date)
      days.push(entry === undefined ? { date, missing: true } : daySummary(entry))
    }
    return {
      ok: true,
      today,
      panelDays: limit,
      timeZone: TIME_ZONE,
      generatedAt: Date.now(),
      note: NOTE,
      days,
    }
  }

  async function handleDay(searchParams) {
    const date = searchParams.get('date')
    const dayKey = isDayKey(date) ? date : dayKeyOf(Date.now())
    const entry = await readEntry(dayKey)
    if (entry === undefined) return { ok: false, date: dayKey, error: 'no entry for this day', note: NOTE }
    return { ok: true, entry, note: NOTE }
  }

  async function handleGenerate(req) {
    const body = await readJsonBody(req)
    const dayKey = isDayKey(body.date) ? body.date : dayKeyOf(Date.now())
    const entry = await generateDay(dayKey, 'manual')
    return { ok: true, entry, note: NOTE }
  }

  /**
   * 诊断端点：把当天每个会话的投影原始读数原样吐出来，用于人工核对
   * 面板/条目里的数字确实来自 sessionStats 与 tokenUsage 投影。
   */
  async function handleDiag(searchParams) {
    const raw = searchParams.get('date')
    const dayKey = isDayKey(raw) ? raw : dayKeyOf(Date.now())
    const records = await collectDayRecords(dayKey)
    const sessions = records.map((record) => {
      const values = record.snapshot?.values
      return {
        id: String(record.header.id),
        createdAt: num(record.header.createdAt),
        projectionSource: record.source,
        asOfSeq: record.snapshot?.asOfSeq ?? null,
        projectionKeys: values !== undefined && values !== null ? Object.keys(values) : [],
        sessionStats: values?.sessionStats ?? null,
        tokenUsage: values?.tokenUsage ?? null,
      }
    })
    const selection = readDefaultSelection()
    const llm = ctx.get('llm')
    return {
      ok: true,
      date: dayKey,
      timeZone: TIME_ZONE,
      services: {
        sessionQuery: ctx.get('sessionQuery') !== undefined,
        sessions: ctx.get('sessions') !== undefined,
        sessionProjections: ctx.get('sessionProjections') !== undefined,
        sessionProjectionCache: ctx.get('sessionProjectionCache') !== undefined,
        llm: llm !== undefined && typeof llm.stream === 'function',
        agentDefaultModel: selection !== null,
      },
      defaultSelection: selection,
      scheduler: {
        ...schedulerState,
        nextRunIso: schedulerState.nextRunAt === null ? null : new Date(schedulerState.nextRunAt).toISOString(),
        nowIso: new Date().toISOString(),
      },
      sessions,
    }
  }

  ctx.effect(() => {
    const webServer = ctx.webServer ?? ctx.get('webServer')
    if (webServer === undefined || typeof webServer.register !== 'function') {
      warn('webServer service is unavailable; the panel API is not served')
      return () => {}
    }
    const dispose = webServer.register({
      kind: 'prefix',
      path: API_PREFIX,
      async handler(req, res) {
        try {
          const host = typeof req.headers?.host === 'string' ? req.headers.host : '127.0.0.1'
          const url = new URL(req.url ?? '/', `http://${host}`)
          const rest = url.pathname.slice(API_PREFIX.length).replace(/^\/+/, '').replace(/\/+$/, '')
          if (req.method === 'GET' && (rest === '' || rest === 'days')) {
            sendJson(res, 200, await handleDays(url.searchParams))
            return
          }
          if (req.method === 'GET' && rest === 'day') {
            sendJson(res, 200, await handleDay(url.searchParams))
            return
          }
          if (req.method === 'GET' && rest === 'diag') {
            sendJson(res, 200, await handleDiag(url.searchParams))
            return
          }
          if (req.method === 'POST' && rest === 'generate') {
            sendJson(res, 200, await handleGenerate(req))
            return
          }
          sendJson(res, 404, { ok: false, error: `unknown endpoint: ${req.method} ${rest}` })
        } catch (err) {
          warn('api request failed:', err?.message ?? err)
          try {
            sendJson(res, 500, { ok: false, error: String(err?.message ?? err) })
          } catch {
            /* response already gone */
          }
        }
      },
    })
    return dispose
  }, 'dsh-diary: /dsh-diary/api routes')

  // ---- 每天定时生成 ---------------------------------------------------------------

  ctx.effect(() => {
    if (!cfg.autoGenerate) {
      log('autoGenerate is off; scheduled generation disabled')
      return () => {}
    }
    const clock = parseClock(cfg.time, [23, 0, 0])
    let stopped = false
    let timer = null

    const arm = () => {
      if (stopped) return
      const now = Date.now()
      const target = nextRunAt(now, clock)
      schedulerState.nextRunAt = target
      timer = setTimeout(() => {
        timer = null
        if (stopped) return
        const dayKey = dayKeyOf(Date.now())
        schedulerState.nextRunAt = null
        generateDay(dayKey, 'schedule')
          .then(() => {
            schedulerState.lastRunAt = Date.now()
            schedulerState.lastRunDay = dayKey
            schedulerState.lastRunOk = true
            schedulerState.lastRunError = null
          })
          .catch((err) => {
            schedulerState.lastRunAt = Date.now()
            schedulerState.lastRunDay = dayKey
            schedulerState.lastRunOk = false
            schedulerState.lastRunError = String(err?.message ?? err)
            warn(`scheduled generation failed for ${dayKey}:`, err?.message ?? err)
          })
          .finally(arm)
      }, Math.max(1000, target - now))
      if (typeof timer.unref === 'function') timer.unref()
      log(`next scheduled run: ${new Date(target).toISOString()} (${cfg.time} ${TIME_ZONE})`)
    }

    arm()
    return () => {
      stopped = true
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
    }
  }, 'dsh-diary: daily generation timer')

  // ---- 启动补生成今天的条目（已有则跳过） -----------------------------------------

  ctx.effect(() => {
    let cancelled = false
    const timer = setTimeout(() => {
      if (cancelled) return
      const dayKey = dayKeyOf(Date.now())
      readEntry(dayKey)
        .then((existing) => {
          if (cancelled || existing !== undefined) return undefined
          return generateDay(dayKey, 'boot')
        })
        .catch((err) => warn('boot generation failed:', err?.message ?? err))
    }, 4000)
    if (typeof timer.unref === 'function') timer.unref()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, 'dsh-diary: boot backfill for today')

  log(`ready (time=${cfg.time} ${TIME_ZONE}, panelDays=${cfg.panelDays}, autoGenerate=${cfg.autoGenerate})`)
}
