// 养鱼经济学 · 设置页卡片（浏览器半边）
//
// 在「设置」里加一节「养鱼经济学」，紧跟在养鱼总控制台（order 5）后面：
//   一个大开关 + 三个数字（每次请求多少 token / 累计省了多少 / 压缩了几次）。
// 开关走宿主 HTTP 接口 /fish-economy/api/state，点了立刻生效（插件每秒看一次文件），不用重启。
//
// 只依赖 React（由宿主注入）和主题变量，不 import 任何宿主包，也不碰别的插件的 DOM。
window.__ModuleLoader__.load({
  id: 'dsh-fish-economy',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const API = '/fish-economy/api/state'

    /** 把数字缩成 12.3K / 1.2M 这种好读的形式。 */
    function fmt(n) {
      const v = Number(n) || 0
      if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M'
      if (v >= 1e4) return (v / 1e3).toFixed(1) + 'K'
      if (v >= 1e3) return (v / 1e3).toFixed(2) + 'K'
      return String(Math.round(v))
    }

    /** 拉一次状态；失败返回 null，卡片显示「读不到」。 */
    async function fetchState() {
      try {
        const r = await fetch(API, { headers: { accept: 'application/json' } })
        if (!r.ok) return null
        return await r.json()
      } catch {
        return null
      }
    }

    /** 写开关。 */
    async function setEnabled(enabled) {
      try {
        const r = await fetch(API, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ enabled }),
        })
        if (!r.ok) return null
        return await r.json()
      } catch {
        return null
      }
    }

    const label = { fontSize: 12, opacity: 0.62, lineHeight: '18px' }
    const value = { fontSize: 15, fontWeight: 600, lineHeight: '20px' }

    /**
     * 卡片本体。
     * @returns {object} React 元素。
     */
    function FishEconomyCard() {
      const [data, setData] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [tick, setTick] = React.useState(0)

      React.useEffect(() => {
        let alive = true
        fetchState().then((next) => {
          if (alive) setData(next)
        })
        const timer = setInterval(() => {
          if (alive) setTick((n) => n + 1)
        }, 5000)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [])

      React.useEffect(() => {
        if (tick === 0) return
        let alive = true
        fetchState().then((next) => {
          if (alive && next) setData(next)
        })
        return () => {
          alive = false
        }
      }, [tick])

      const online = data?.online === true
      const ledger = data?.ledger ?? {}
      const percent = ledger.schemaBaseline > 0
        ? Math.round((1 - ledger.schemaAnnounced / ledger.schemaBaseline) * 100)
        : 0

      /** 点开关：先乐观切换，再用服务端返回值校准。 */
      async function toggle() {
        if (busy) return
        setBusy(true)
        const next = await setEnabled(!online)
        if (next) setData(next)
        else setData((prev) => (prev ? { ...prev, online: !online } : prev))
        setBusy(false)
      }

      return h('div', {
        style: {
          border: '1px solid var(--dsw-alias-border-l2)',
          borderRadius: 12,
          padding: '14px 16px',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        },
      },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 12 } },
        h('div', { style: { flex: 1, minWidth: 0 } },
          h('div', { style: { fontSize: 14, fontWeight: 650 } }, '养鱼经济学'),
          h('div', { style: label },
            data === null
              ? '读不到状态（宿主接口没起来？）'
              : online
                ? `生效中 · 预设 ${data.preset} · 只作用于 ${(data.scope || []).join(' / ') || '全部'} 目录`
                : '已关闭 · 所有会话照常，不省也不动')),
        h('button', {
          type: 'button',
          role: 'switch',
          'aria-checked': online,
          'aria-label': '养鱼经济学开关',
          disabled: busy,
          onClick: toggle,
          style: {
            flex: '0 0 auto',
            width: 46,
            height: 26,
            borderRadius: 999,
            border: '1px solid var(--dsw-alias-border-l2)',
            background: online ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-bg-layer-2)',
            cursor: busy ? 'progress' : 'pointer',
            position: 'relative',
            transition: 'background 120ms ease',
          },
        },
        h('span', {
          style: {
            position: 'absolute',
            top: 2,
            left: online ? 22 : 2,
            width: 20,
            height: 20,
            borderRadius: 999,
            background: '#fff',
            boxShadow: '0 1px 3px rgba(0,0,0,.28)',
            transition: 'left 120ms ease',
          },
        }))),

      h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0,1fr))', gap: 10 } },
        h('div', null,
          h('div', { style: value }, `${fmt(ledger.perRequest)}`),
          h('div', { style: label }, '现在每次请求 / token')),
        h('div', null,
          h('div', { style: value }, `-${percent}%`),
          h('div', { style: label }, `工具说明书 ${fmt(ledger.schemaBaseline)} → ${fmt(ledger.schemaAnnounced)}`)),
        h('div', null,
          h('div', { style: value }, String(ledger.compactions ?? 0)),
          h('div', { style: label }, '自动压缩次数'))),

      h('div', { style: { ...label, display: 'flex', gap: 14, flexWrap: 'wrap' } },
        h('span', null, `累计触发 ${ledger.requests ?? 0} 次请求`),
        h('span', null, `缓存命中 ${Math.round((ledger.cacheHitRate ?? 0) * 100)}%`),
        h('span', null, `闸门省 ${fmt(ledger.schemaSaved)} token`),
        h('span', null, `估算省 ¥${(ledger.moneySaved ?? 0).toFixed(2)}`)))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'fish-economy',
          order: 6,
          label: () => '养鱼经济学',
        }, FishEconomyCard))
      },
    }
  },
})
