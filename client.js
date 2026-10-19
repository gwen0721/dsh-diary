/**
 * dsh-diary — 每日日记 Client 半身
 *
 * 面板挂在 settings.section（设置里的一页），数据全部来自 Host 半身注册的
 * /dsh-diary/api。样式只用 --dsw-alias-* 主题 token，不写死颜色，不做动画/渐变。
 */

window.__ModuleLoader__.load({
  id: 'dsh-diary',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useState } = React

    const STYLE_OWNER_ID = 'dsh-diary'
    const API = '/dsh-diary/api'

    const CSS = [
      '.dd-root{display:flex;flex-direction:column;gap:12px;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary)}',
      '.dd-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px}',
      '.dd-title{font-size:13px;font-weight:600;margin:0}',
      '.dd-note{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);margin:0}',
      '.dd-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.dd-btn{font:inherit;font-size:12px;padding:4px 10px;cursor:pointer;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);border:1px solid var(--dsw-alias-button-primary-fill)}',
      '.dd-btn:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}',
      '.dd-btn:disabled{opacity:.55;cursor:default}',
      '.dd-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.dd-btn[data-variant=secondary]{background:transparent;color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l1)}',
      '.dd-btn[data-variant=secondary]:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}',
      '.dd-days{border:1px solid var(--dsw-alias-border-l1)}',
      '.dd-row{display:grid;grid-template-columns:96px 1fr 132px;gap:10px;align-items:center;padding:7px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);cursor:pointer;background:var(--dsw-alias-bg-base)}',
      '.dd-row:last-child{border-bottom:none}',
      '.dd-row:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.dd-row[data-selected=true]{background:var(--dsw-alias-bg-layer-2)}',
      '.dd-row:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}',
      '.dd-date{font-variant-numeric:tabular-nums}',
      '.dd-muted{color:var(--dsw-alias-label-secondary)}',
      '.dd-right{text-align:right;font-variant-numeric:tabular-nums;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.dd-badge{display:inline-block;font-size:11px;padding:0 5px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);margin-left:6px}',
      '.dd-detail{display:flex;flex-direction:column;gap:10px;border:1px solid var(--dsw-alias-border-l1);padding:10px}',
      '.dd-section{display:flex;flex-direction:column;gap:6px}',
      '.dd-section-title{font-size:12px;font-weight:600;margin:0}',
      '.dd-points{margin:0;padding-left:18px}',
      '.dd-points li{margin:2px 0}',
      '.dd-table{width:100%;border-collapse:collapse;font-size:12px}',
      '.dd-table th,.dd-table td{text-align:left;padding:4px 6px;border-bottom:1px solid var(--dsw-alias-border-l1);vertical-align:top}',
      '.dd-table th{font-weight:500;color:var(--dsw-alias-label-secondary)}',
      '.dd-table tr:last-child td{border-bottom:none}',
      '.dd-num{text-align:right;font-variant-numeric:tabular-nums}',
      '.dd-error{font-size:12px;color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);padding:6px 8px}',
      '.dd-empty{font-size:12px;color:var(--dsw-alias-label-secondary);padding:10px}',
    ].join('')

    function createOwnedStyle(css) {
      const el = document.createElement('style')
      el.setAttribute('data-plugin', STYLE_OWNER_ID)
      el.textContent = css
      document.head.appendChild(el)
      return el
    }

    async function apiGet(path) {
      const res = await fetch(`${API}${path}`, { headers: { accept: 'application/json' } })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.json()
    }

    async function apiPost(path, body) {
      const res = await fetch(`${API}${path}`, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.json()
    }

    function pad2(n) {
      return n < 10 ? `0${n}` : String(n)
    }

    function formatTime(ts) {
      if (typeof ts !== 'number' || !Number.isFinite(ts)) return '—'
      const d = new Date(ts)
      return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
    }

    function formatDuration(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '0s'
      const total = Math.round(ms / 1000)
      const h = Math.floor(total / 3600)
      const m = Math.floor((total % 3600) / 60)
      const s = total % 60
      if (h > 0) return `${h}h${pad2(m)}m`
      if (m > 0) return `${m}m${pad2(s)}s`
      return `${s}s`
    }

    function formatTokens(n) {
      if (typeof n !== 'number' || !Number.isFinite(n)) return '0'
      if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
      if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
      return String(n)
    }

    function weekdayOf(dayKey) {
      const ts = Date.parse(`${dayKey}T00:00:00Z`)
      if (!Number.isFinite(ts)) return ''
      return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][new Date(ts).getUTCDay()]
    }

    // ------------------------------------------------------------ 详情区

    function SessionTable(props) {
      const sessions = Array.isArray(props.sessions) ? props.sessions : []
      if (sessions.length === 0) {
        return h('p', { className: 'dd-note' }, '当天没有会话记录。')
      }
      const head = h(
        'tr',
        null,
        h('th', null, '会话'),
        h('th', { className: 'dd-num' }, '轮'),
        h('th', { className: 'dd-num' }, '步'),
        h('th', { className: 'dd-num' }, '模型'),
        h('th', { className: 'dd-num' }, '工具'),
        h('th', { className: 'dd-num' }, '输入'),
        h('th', { className: 'dd-num' }, '输出'),
        h('th', { className: 'dd-num' }, '缓存读'),
        h('th', { className: 'dd-num' }, '缓存写'),
        h('th', { className: 'dd-num' }, '合计'),
      )
      const rows = sessions.map((session) =>
        h(
          'tr',
          { key: session.id },
          h(
            'td',
            null,
            h('span', null, session.label ?? session.id),
            h('span', { className: 'dd-badge' }, formatTime(session.createdAt)),
            session.statsAvailable === false ? h('span', { className: 'dd-badge' }, '无投影') : null,
          ),
          h('td', { className: 'dd-num' }, String(session.turns ?? 0)),
          h('td', { className: 'dd-num' }, String(session.steps ?? 0)),
          h('td', { className: 'dd-num' }, formatDuration(session.llmMs)),
          h('td', { className: 'dd-num' }, formatDuration(session.toolMs)),
          h('td', { className: 'dd-num' }, formatTokens(session.inputTokens)),
          h('td', { className: 'dd-num' }, formatTokens(session.outputTokens)),
          h('td', { className: 'dd-num' }, formatTokens(session.cacheReadTokens)),
          h('td', { className: 'dd-num' }, formatTokens(session.cacheWriteTokens)),
          h('td', { className: 'dd-num' }, formatTokens(session.totalTokens)),
        ),
      )
      return h('table', { className: 'dd-table' }, h('thead', null, head), h('tbody', null, rows))
    }

    function DayDetail(props) {
      const { date, entry, loading, error } = props
      if (loading) {
        return h('div', { className: 'dd-detail' }, h('p', { className: 'dd-note' }, '读取中…'))
      }
      if (error !== null && error !== undefined) {
        return h('div', { className: 'dd-detail' }, h('p', { className: 'dd-error' }, `读取失败：${String(error)}`))
      }
      if (entry === null || entry === undefined) {
        return h('div', { className: 'dd-detail' }, h('p', { className: 'dd-empty' }, `${date} 还没有日记条目。可以点“生成今天”或在当天 23:00 后自动生成。`))
      }
      const totals = entry.totals ?? {}
      const sourceLabel = entry.highlightSource === 'llm' ? '模型总结' : '原文摘录（降级）'
      return h(
        'div',
        { className: 'dd-detail' },
        h(
          'div',
          { className: 'dd-head' },
          h('p', { className: 'dd-title' }, `${entry.date} ${weekdayOf(entry.date)}`),
          h('span', { className: 'dd-muted' }, `生成于 ${formatTime(entry.generatedAt)} · ${sourceLabel}`),
        ),
        h(
          'div',
          { className: 'dd-toolbar' },
          h('span', { className: 'dd-muted' }, `会话 ${totals.sessions ?? 0}`),
          h('span', { className: 'dd-muted' }, `轮次 ${totals.turns ?? 0}`),
          h('span', { className: 'dd-muted' }, `步数 ${totals.steps ?? 0}`),
          h('span', { className: 'dd-muted' }, `模型 ${formatDuration(totals.llmMs)}`),
          h('span', { className: 'dd-muted' }, `工具 ${formatDuration(totals.toolMs)}`),
          h('span', { className: 'dd-muted' }, `token 估算 ${formatTokens(totals.totalTokens)}`),
        ),
        h(
          'div',
          { className: 'dd-section' },
          h('p', { className: 'dd-section-title' }, '重点总结'),
          Array.isArray(entry.highlights) && entry.highlights.length > 0
            ? h('ul', { className: 'dd-points' }, entry.highlights.map((point, index) => h('li', { key: index }, point)))
            : h('p', { className: 'dd-note' }, '没有可用的总结。'),
        ),
        h('div', { className: 'dd-section' }, h('p', { className: 'dd-section-title' }, '会话明细'), h(SessionTable, { sessions: entry.sessions })),
        h('p', { className: 'dd-note' }, entry.note ?? 'token 占用是估算数字，不是计费记录。'),
      )
    }

    // ------------------------------------------------------------ 面板

    function DiaryPanel() {
      const [listState, setListState] = useState({ loading: true, error: null, data: null })
      const [selected, setSelected] = useState(null)
      const [detailState, setDetailState] = useState({ loading: false, error: null, entry: null, date: null })
      const [busy, setBusy] = useState(false)
      const [notice, setNotice] = useState(null)

      const loadDays = useCallback(async () => {
        setListState({ loading: true, error: null, data: null })
        try {
          const data = await apiGet('/days')
          setListState({ loading: false, error: null, data })
        } catch (err) {
          setListState({ loading: false, error: String(err?.message ?? err), data: null })
        }
      }, [])

      const loadDay = useCallback(async (date) => {
        setDetailState({ loading: true, error: null, entry: null, date })
        try {
          const data = await apiGet(`/day?date=${encodeURIComponent(date)}`)
          if (data?.ok === true) {
            setDetailState({ loading: false, error: null, entry: data.entry ?? null, date })
          } else {
            setDetailState({ loading: false, error: null, entry: null, date })
          }
        } catch (err) {
          setDetailState({ loading: false, error: String(err?.message ?? err), entry: null, date })
        }
      }, [])

      useEffect(() => {
        void loadDays()
      }, [loadDays])

      const days = listState.data?.days ?? []
      const note = listState.data?.note ?? 'token 占用是 token-meter 的估算数字，仅作参考，不是计费记录。'

      const onSelect = useCallback(
        (date) => {
          setSelected(date)
          void loadDay(date)
        },
        [loadDay],
      )

      const onGenerate = useCallback(async () => {
        setBusy(true)
        setNotice(null)
        try {
          const data = await apiPost('/generate', {})
          if (data?.ok !== true) throw new Error(data?.error ?? 'unknown error')
          setNotice(`已生成 ${data.entry?.date ?? '今天'}`)
          await loadDays()
          if (selected !== null) await loadDay(selected)
        } catch (err) {
          setNotice(`生成失败：${String(err?.message ?? err)}`)
        } finally {
          setBusy(false)
        }
      }, [loadDays, loadDay, selected])

      const onKeyDownRow = useCallback(
        (event, date) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            onSelect(date)
          }
        },
        [onSelect],
      )

      const rows = useMemo(() => {
        if (listState.loading) return h('p', { className: 'dd-empty' }, '读取中…')
        if (listState.error !== null) return h('p', { className: 'dd-error' }, `读取失败：${listState.error}`)
        if (days.length === 0) return h('p', { className: 'dd-empty' }, '还没有日记数据。')
        return h(
          'div',
          { className: 'dd-days' },
          days.map((day) => {
            const isSelected = selected === day.date
            const content = day.missing === true
              ? h('span', { className: 'dd-muted' }, '未生成')
              : h(
                  'span',
                  null,
                  `${day.sessions} 会话 · ${day.turns} 轮 · ${day.steps} 步`,
                  h('span', { className: 'dd-badge' }, `token≈${formatTokens(day.totalTokens)}`),
                )
            const right = day.missing === true
              ? h('span', { className: 'dd-right' }, '—')
              : h(
                  'span',
                  { className: 'dd-right' },
                  day.highlightSource === 'llm' ? '模型总结' : '原文摘录',
                )
            return h(
              'div',
              {
                key: day.date,
                className: 'dd-row',
                role: 'button',
                tabIndex: 0,
                'aria-pressed': isSelected ? 'true' : 'false',
                'data-selected': isSelected ? 'true' : 'false',
                onClick: () => onSelect(day.date),
                onKeyDown: (event) => onKeyDownRow(event, day.date),
                onKeyUp: (event) => {
                  if (event.key === 'Escape' && isSelected) {
                    setSelected(null)
                  }
                },
              },
              h('span', { className: 'dd-date' }, day.date),
              content,
              right,
            )
          }),
        )
      }, [days, listState.error, listState.loading, onSelect, onKeyDownRow, selected])

      return h(
        'div',
        { className: 'dd-root', onKeyDown: (event) => {
          if (event.key === 'Escape' && selected !== null) setSelected(null)
        } },
        h(
          'div',
          { className: 'dd-head' },
          h('p', { className: 'dd-title' }, '每日日记'),
          h('span', { className: 'dd-muted' }, listState.data?.timeZone ?? 'Asia/Shanghai'),
        ),
        h('p', { className: 'dd-note' }, note),
        h(
          'div',
          { className: 'dd-toolbar' },
          h('button', { className: 'dd-btn', type: 'button', onClick: onGenerate, disabled: busy }, busy ? '生成中…' : '生成今天'),
          h('button', { className: 'dd-btn', type: 'button', 'data-variant': 'secondary', onClick: () => void loadDays(), disabled: busy }, '刷新'),
          notice !== null ? h('span', { className: 'dd-muted' }, notice) : null,
        ),
        rows,
        selected !== null
          ? h(DayDetail, { date: selected, entry: detailState.entry, loading: detailState.loading, error: detailState.error })
          : h('p', { className: 'dd-note' }, '点开某一天查看当天详情。'),
      )
    }

    // ------------------------------------------------------------ 注册

    const inject = ['slots']

    function apply(ctx) {
      const slots = ctx.get !== undefined ? ctx.get('slots') : undefined
      if (slots === undefined || slots === null) return

      const styleEl = createOwnedStyle(CSS)
      ctx.effect(
        () => () => {
          styleEl.remove()
        },
        'dsh-diary: panel stylesheet',
      )

      slots.inject('settings.section', () =>
        slots.register(
          { name: 'settings.section', id: 'diary', order: 30, label: '每日日记' },
          () => h(DiaryPanel),
        ),
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
