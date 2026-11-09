/**
 * 鱼缸经济学 · Host 半边。
 *
 * 一个插件干三件事，全部围绕"每次请求都重发的东西"：
 *   1. 工具闸门：默认只下发 tool_list/tool_enable/tool_disable 三个小 schema，
 *      其余工具按组休眠，用的时候唤醒（等价于 dsh-flash-presets 的预设思路，但
 *      作用在工具面上，且不覆盖任何人的系统提示）。
 *   2. 上下文瘦身：工具结果在进历史之前掐头去尾，系统提示做无损去重与格式折叠。
 *      历史是复利，第 3 步省下的字会跟着后面每一次请求。
 *   3. 原生批量操作：ops 一个工具顶 read/write/edit/glob/grep/stat，少 6 个 schema、
 *      少好几个来回（dsh-ops 的思路，纯 Node 实现，默认只读）。
 *
 * 另外带一本账（fish_report / summary.json），把"省了多少"变成可核对的数字。
 *
 * 只用宿主公开接口：ctx.tools.register / restrict / schemas、ctx.on(...)、
 * ctx.systemPrompt.section。不 import 任何 @deepseek-ai 包（插件侧解析不到）。
 *
 * @module dsh-fish-economy
 */
import { resolveConfig } from './src/config.js'
import { createBudget } from './src/budget.js'
import { readState, statePath, writeState } from './src/state.js'
import {
  computeDenyList, computeKeepSet, groupIds, groupsForText, renderToolList, schemaBudget, toolsOfGroup,
} from './src/gate.js'
import { createMeter } from './src/meter.js'
import { createOpsTool } from './src/ops-tool.js'
import { createPrompt } from './src/prompt.js'
import { createTrim } from './src/trim.js'
import { estimateToolSchemas, formatTokens } from './src/token.js'

/** 插件名（Loader 诊断用）。 */
export const name = 'dsh-fish-economy'

/** 依赖的服务。`tools`/`systemPrompt` 在任何跑 agent 的组合里都存在。 */
export const inject = ['tools', 'systemPrompt']

/**
 * 从参数里解析要操作的分组。
 * @param {object} args 工具参数。
 * @returns {string[]} 分组 id 列表（去重）。
 */
function parseGroups(args) {
  const out = new Set()
  if (typeof args?.group === 'string' && args.group.trim() !== '') out.add(args.group.trim())
  for (const item of Array.isArray(args?.groups) ? args.groups : []) {
    if (typeof item === 'string' && item.trim() !== '') out.add(item.trim())
  }
  return [...out]
}

/**
 * @param {object} ctx 插件上下文（cordis）。
 * @param {object} [rawConfig] cordis.patch.yml 中这一行的 config。
 * @returns {void}
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig ?? {})

  /**
   * 诊断日志：默认只在 debug 打开时写 stderr，绝不进模型上下文。
   * @param {string} level 级别。
   * @param {string} message 文本。
   * @returns {void}
   */
  const log = (level, message) => {
    if (level === 'debug' && !config.debug) return
    try {
      process.stderr.write(`[fish-economy] ${level}: ${message}\n`)
    } catch {
      // 诊断失败不影响主流程
    }
  }

  if (!config.enabled) {
    log('info', '插件已加载但 enabled=false，所有功能休眠')
    return
  }

  // 装完不配置就是这种状态：一个工具都不注册、一个钩子都不挂，零开销。
  // 想生效必须开 fish.enabled 或显式打开某个模块（README 第 3 步）。
  const inert = !config.gate.enabled && !config.trim.enabled && !config.budget.enabled
    && !config.ops.enabled && !config.fish.enabled && !config.prompt.enabled
  if (inert) {
    log('info', '已加载但未启用任何功能（装完不配置时的默认状态），不注册工具、不挂钩子')
    return
  }

  /** @type {WeakMap<object, object>} agent -> 闸门状态 */
  const agentStates = new WeakMap()
  /** 没有 agent 的调用（例如某些 scope-less 场景）落到这里。 */
  const globalState = {
    enabled: new Set(config.gate.startGroups),
    touched: new Map(),
    restriction: undefined,
    baseline: undefined,
    turns: 0,
  }

  const meter = createMeter({ config, log })

  // 控制台开关：state.json 里的 enabled 决定运行时开/关，改完约 1 秒生效。
  const stateFile = statePath(config)
  let runtimeOn = readState(stateFile).enabled

  /**
   * 运行时是否在干活（配置开着 + 控制台开关开着）。
   * @returns {boolean} 是否生效。
   */
  function isOn() {
    return config.enabled && runtimeOn === true
  }

  /**
   * 取一个 agent 的闸门状态。
   * @param {object} [agent] agent。
   * @returns {object} 状态。
   */
  function stateOf(agent) {
    if (agent === undefined || agent === null) return globalState
    let state = agentStates.get(agent)
    if (state === undefined) {
      state = {
        enabled: new Set(config.gate.startGroups),
        touched: new Map(),
        restriction: undefined,
        baseline: undefined,
        turns: 0,
      }
      agentStates.set(agent, state)
    }
    return state
  }

  /**
   * 基线 schema：全局可见工具（restrict 只能过滤"继承来的"工具，所以基线也只能取全局层）。
   *
   * 为什么不用 `schemas(agent)`：那样会把别的插件注册在 agent 自己 scope 上的工具也算进来
   * （比如子代理的 structured_output），而 restrict 拒绝 scope-local 名字，一旦混进去整条
   * deny 名单都会失败 —— 闸门会整体降级。取全局层从根上避免这个问题。
   * @param {object} agent agent。
   * @param {object} state 状态。
   * @returns {Array<object>} schema 列表。
   */
  function baselineOf(agent, state) {
    if (state.baseline !== undefined) return state.baseline
    try {
      const tools = ctx.tools
      // 优先用 view(agent).restrictableNames：它正好是 restrict() 允许点名的集合
      // （继承来的全局工具），不会混进 agent 自己 scope 注册的工具（那会让整条
      // deny 名单被拒）。view 不是声明层 API，所以取不到时退回 schemas(agent)。
      const view = agent !== undefined && typeof tools.view === 'function' ? tools.view(agent) : undefined
      const visible = tools.schemas(agent) ?? []
      if (view?.restrictableNames !== undefined) {
        const byName = new Map(visible.map((schema) => [schema.name, schema]))
        state.baseline = [...view.restrictableNames].map((name) => byName.get(name) ?? { name, description: '', parameters: {} })
        return state.baseline
      }
      state.baseline = visible
    } catch (error) {
      log('warn', `读取基线工具失败：${error instanceof Error ? error.message : String(error)}`)
      state.baseline = []
    }
    return state.baseline
  }

  /**
   * 这个 agent 是否落在闸门作用范围内。
   *
   * `gate.scope` 是 cwd 子串列表，空数组表示"所有会话"。养鱼预设默认只作用于
   * 路径里带 whale 的工作目录 —— 保证同一个 profile 里写代码的会话完全不受影响。
   * 宁可少省一点，也不要让别的会话突然少一半工具。
   * @param {object} agent agent。
   * @returns {boolean} 是否在范围内。
   */
  function inScope(agent) {
    const scope = config.gate.scope ?? []
    if (scope.length === 0) return true
    const cwd = String(agent?.session?.header?.cwd ?? '').toLowerCase()
    if (cwd === '') return false
    return scope.some((part) => cwd.includes(String(part).toLowerCase()))
  }

  /**
   * 把当前分组状态同步成 agent scope 上的 restrict 名单。
   * 先撤旧再立新：restrict 是静态集合，改名单要重新注册。
   * @param {object} agent agent。
   * @returns {void}
   */
  function sync(agent) {
    if (!config.gate.enabled) return
    const state = stateOf(agent)
    const scoped = agent?.ctx?.tools
    if (scoped === undefined || typeof scoped.restrict !== 'function') return
    if (!isOn() || !inScope(agent)) {
      // 不在作用范围：确保没有任何生效的限制。
      if (state.restriction !== undefined) {
        try {
          state.restriction()
        } catch {
          // 已失效
        }
        state.restriction = undefined
      }
      return
    }
    const baseline = baselineOf(agent, state)
    const keep = computeKeepSet(
      baseline.map((schema) => schema.name),
      state.enabled,
      { overrides: config.gate.overrides, pins: config.gate.pins, alwaysGroups: config.gate.alwaysGroups },
    )
    const deny = computeDenyList(baseline.map((schema) => schema.name), keep)
    if (state.restriction !== undefined) {
      try {
        state.restriction()
      } catch (error) {
        log('debug', `撤销旧 restrict 失败：${error instanceof Error ? error.message : String(error)}`)
      }
      state.restriction = undefined
    }
    if (deny.length === 0) return
    try {
      state.restriction = scoped.restrict({ deny })
      log('debug', `闸门：休眠 ${deny.length} 个工具（${[...state.enabled].join(',') || '无分组'} 在线）`)
    } catch (error) {
      log('warn', `restrict 失败（闸门降级为只报数）：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * 给一组分组打上"最近使用"时间戳，供 TTL 回收。
   * @param {object} state 状态。
   * @param {string[]} groups 分组。
   * @returns {void}
   */
  function touch(state, groups) {
    for (const group of groups) state.touched.set(group, state.turns)
  }

  /**
   * 唤醒分组。
   * @param {object} agent agent。
   * @param {string[]} groups 分组 id（支持 'all'）。
   * @returns {{ enabled: string[], unknown: string[] }} 结果。
   */
  function enable(agent, groups) {
    const state = stateOf(agent)
    const known = new Set(groupIds(baselineOf(agent, state)))
    const enabled = []
    const unknown = []
    for (const group of groups) {
      if (group === 'all') {
        for (const id of known) state.enabled.add(id)
        enabled.push('all')
        continue
      }
      if (!known.has(group)) {
        unknown.push(group)
        continue
      }
      state.enabled.add(group)
      enabled.push(group)
    }
    touch(state, enabled)
    sync(agent)
    return { enabled, unknown }
  }

  /**
   * 收起分组。
   * @param {object} agent agent。
   * @param {string[]} groups 分组 id（支持 'all'）。
   * @returns {{ disabled: string[] }} 结果。
   */
  function disable(agent, groups) {
    const state = stateOf(agent)
    const disabled = []
    for (const group of groups) {
      if (group === 'all') {
        state.enabled.clear()
        disabled.push('all')
        continue
      }
      if (group === 'meta') continue
      state.enabled.delete(group)
      disabled.push(group)
    }
    sync(agent)
    return { disabled }
  }

  /**
   * 计算"全量 vs 本次下发"的工具成本。
   * @param {object} agent agent。
   * @param {Array<object>} tools 本次 assembly 的 schema。
   * @returns {{ baseline: number, announced: number, saved: number }} 成本。
   */
  function budgetFor(agent, tools) {
    const state = agent === undefined || agent === null ? undefined : agentStates.get(agent)
    const baselineSchemas = state?.baseline
    const baselineTokens = baselineSchemas === undefined ? estimateToolSchemas(tools).total : estimateToolSchemas(baselineSchemas).total
    const announced = estimateToolSchemas(tools).total
    return { baseline: Math.max(baselineTokens, announced), announced, saved: Math.max(0, baselineTokens - announced) }
  }

  // ---------------------------------------------------------------- 工具注册
  /** @type {Array<object>} */
  const definitions = []

  definitions.push({
    name: 'tool_list',
    description: '按组列出当前可用的工具：哪些在线、哪些休眠、每组多少 token。对话里需要的工具不在线时，先用 tool_enable 唤醒（同一轮的下一次请求就生效）。',
    parameters: {
      type: 'object',
      properties: {
        group: { type: 'string', description: '只看某个分组，例如 fs / shell / web；省略则列出全部' },
        verbose: { type: 'boolean', description: '是否列出组内每个工具名，默认 false' },
      },
      additionalProperties: false,
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    async execute(args, exec) {
      const agent = exec?.agent
      if (!isOn()) {
        return '养鱼经济学生效中是关闭的（设置 → 养鱼经济学 里打开开关，或看 README）。现在没有休眠任何工具。'
      }
      if (!inScope(agent)) {
        return `本会话不在闸门范围内（gate.scope=${JSON.stringify(config.gate.scope)}），所有工具照常可用，没有休眠任何工具。`
      }
      const state = stateOf(agent)
      const schemas = baselineOf(agent, state)
      const list = renderToolList(schemas, {
        enabled: state.enabled,
        overrides: config.gate.overrides,
        alwaysGroups: config.gate.alwaysGroups,
        verbose: args?.verbose === true,
        group: typeof args?.group === 'string' ? args.group : undefined,
      })
      return list.text
    },
  })

  definitions.push({
    name: 'tool_enable',
    description: '唤醒一个或多个工具分组（下一轮请求即可调用）。不确定组名时先 tool_list。',
    parameters: {
      type: 'object',
      properties: {
        group: { type: 'string', description: '单个分组 id，例如 fs' },
        groups: { type: 'array', items: { type: 'string' }, description: '多个分组 id' },
      },
      additionalProperties: false,
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    async execute(args, exec) {
      const groups = parseGroups(args)
      if (groups.length === 0) return '需要 group 或 groups 参数。先调 tool_list 看看有哪些组。'
      const agent = exec?.agent
      const result = enable(agent, groups)
      const state = stateOf(agent)
      const schemas = baselineOf(agent, state)
      const budget = schemaBudget(schemas, state.enabled, {
        overrides: config.gate.overrides,
        pins: config.gate.pins,
        alwaysGroups: config.gate.alwaysGroups,
      })
      const lines = []
      if (result.enabled.length > 0) {
        const names = result.enabled.includes('all')
          ? schemas.map((schema) => schema.name)
          : result.enabled.flatMap((group) => toolsOfGroup(schemas, group, { overrides: config.gate.overrides }))
        lines.push(`已唤醒：${result.enabled.join(', ')}`)
        lines.push(`新增可用：${names.join(', ') || '（空）'}`)
        lines.push(`下一轮请求生效；工具定义成本 ${formatTokens(budget.announced)}（全量 ${formatTokens(budget.baseline)}）。`)
      }
      if (result.unknown.length > 0) lines.push(`未知分组：${result.unknown.join(', ')}（用 tool_list 查看）`)
      return lines.join('\n')
    },
  })

  definitions.push({
    name: 'tool_disable',
    description: '收起工具分组，把它的 schema 从后续请求里拿掉。all 表示全部收起。',
    parameters: {
      type: 'object',
      properties: {
        group: { type: 'string', description: '单个分组 id' },
        groups: { type: 'array', items: { type: 'string' }, description: '多个分组 id' },
      },
      additionalProperties: false,
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    async execute(args, exec) {
      const groups = parseGroups(args)
      if (groups.length === 0) return '需要 group 或 groups 参数。'
      const result = disable(exec?.agent, groups)
      return `已收起：${result.disabled.join(', ') || '（无变化）'}。下一轮请求生效。`
    },
  })

  definitions.push({
    name: 'fish_report',
    description: '看这本账：工具定义省了多少 token、真实用量与缓存命中率、累计估计花费。不传参数看累计，scope=session 看本会话。',
    parameters: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['session', 'total'], description: '统计范围，默认 total' },
      },
      additionalProperties: false,
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    async execute(args) {
      return meter.text(args?.scope === 'session' ? 'session' : 'total')
    },
  })

  const opsTool = createOpsTool(ctx, config, { log })
  if (opsTool !== undefined) definitions.push(opsTool)

  // ---------------------------------------------------------------- 生命周期
  ctx.effect(() => {
    const disposers = []
    for (const definition of definitions) {
      try {
        disposers.push(ctx.tools.register(definition))
      } catch (error) {
        log('warn', `注册工具 ${definition.name} 失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          // 卸载期的失败不影响别的插件
        }
      }
    }
  }, 'fish-economy: tool registration')

  const trim = createTrim(ctx, config, { log, meter, isOn })
  const prompt = createPrompt(ctx, config, { log, meter, gate: { budgetFor } })
  const budget = createBudget(ctx, config, {
    log,
    meter,
    agentOf: (session) => agentBySession.get(sessionId(session)),
    inScope,
    isOn,
  })

  ctx.effect(() => {
    trim.install()
    prompt.install()
    budget.install()
    return () => {
      meter.flush()
    }
  }, 'fish-economy: context modules')

  /** @type {WeakMap<object, Function>} agent -> pre-step 监听器 disposer */
  const agentListeners = new WeakMap()
  /** @type {Map<string, object>} session id -> agent（预算闸要从会话找回 agent） */
  const agentBySession = new Map()

  /**
   * 取会话 id。
   * @param {object} session 会话。
   * @returns {string} id。
   */
  function sessionId(session) {
    return String(session?.header?.id ?? session?.id ?? '')
  }

  /**
   * 每一个 agent 自己的 pre-step：推进轮次、按话术预唤醒、TTL 回收。
   * 挂在 agent.ctx 上（而不是全局），才能知道"这是谁"，也才能把 restrict 装在对的 scope。
   * @param {object} agent agent。
   * @param {object} payload pre-step 输入。
   * @param {Function} next 下游。
   * @returns {Promise<object>} 决策。
   */
  async function onPreStep(agent, payload, next) {
    const state = stateOf(agent)
    state.turns += 1
    if (config.gate.autoEnable) {
      const text = Array.isArray(payload?.messages)
        ? payload.messages.map((message) => {
          if (typeof message === 'string') return message
          if (Array.isArray(message?.content)) return message.content.filter((block) => block?.type === 'text').map((block) => block.text).join('\n')
          return ''
        }).join('\n')
        : ''
      const suggestions = groupsForText(text)
      if (suggestions.length > 0) {
        const fresh = suggestions.filter((group) => !state.enabled.has(group))
        if (fresh.length > 0) {
          log('debug', `按话术预唤醒：${fresh.join(',')}`)
          enable(agent, fresh)
        }
      }
    }
    if (config.gate.ttlTurns > 0) {
      const expired = [...state.touched.entries()].filter(([, turn]) => state.turns - turn > config.gate.ttlTurns).map(([group]) => group)
      if (expired.length > 0) {
        log('debug', `TTL 回收：${expired.join(',')}`)
        disable(agent, expired)
      }
    }
    return await next()
  }

  ctx.on('agent/created', ({ agent }) => {
    try {
      baselineOf(agent, stateOf(agent))
      sync(agent)
      const id = sessionId(agent?.session)
      if (id !== '') agentBySession.set(id, agent)
      const off = agent?.ctx?.on?.('agent/pre-step', (payload, next) => onPreStep(agent, payload, next))
      if (typeof off === 'function') agentListeners.set(agent, off)
    } catch (error) {
      log('warn', `初始化 agent 闸门失败：${error instanceof Error ? error.message : String(error)}`)
    }
  })

  ctx.on('agent/disposed', ({ agent }) => {
    const state = stateOf(agent)
    if (state.restriction !== undefined) {
      try {
        state.restriction()
      } catch {
        // agent 已经销毁，restriction 随之失效
      }
      state.restriction = undefined
    }
    const id = sessionId(agent?.session)
    if (id !== '' && agentBySession.get(id) === agent) agentBySession.delete(id)
    const off = agentListeners.get(agent)
    if (typeof off === 'function') {
      try {
        off()
      } catch {
        // 同上
      }
      agentListeners.delete(agent)
    }
  })

  // 真实用量：assistant/message 带 usage；turn/end 落一次盘。
  ctx.on('session/event', (session, event) => {
    try {
      if (event?.type === 'assistant/message') meter.recordUsage(session, event.data?.usage)
      else if (event?.type === 'turn/end') meter.recordTurn(session)
    } catch (error) {
      log('debug', `记账失败：${error instanceof Error ? error.message : String(error)}`)
    }
  })

  // 启动时补一遍已经在跑的 agent（插件热挂载的情况）。
  try {
    const agents = ctx.get('agents')
    if (agents !== undefined && typeof agents.list === 'function') {
      for (const agent of agents.list()) {
        baselineOf(agent, stateOf(agent))
        sync(agent)
      }
    }
  } catch (error) {
    log('debug', `扫描已存在 agent 失败：${error instanceof Error ? error.message : String(error)}`)
  }

  // ---------------------------------------------------------------- 控制台开关
  /**
   * 给控制台卡片/HTTP 接口用的状态快照（全是数字，不含任何对话内容）。
   * @returns {object} 状态。
   */
  function statusPayload() {
    const ledger = meter.report('total')
    return {
      online: isOn(),
      available: config.gate.enabled || config.trim.enabled || config.budget.enabled,
      preset: config.fish.enabled ? config.fish.preset : 'off',
      scope: config.gate.scope,
      thresholds: {
        compactAtTokens: config.budget.compactAtTokens,
        pruneToolResultChars: config.trim.pruneToolResultChars,
      },
      ledger: {
        requests: ledger.requests,
        sessions: ledger.sessions,
        perRequest: Math.round(ledger.perRequest),
        schemaBaseline: ledger.schemaBaseline,
        schemaAnnounced: ledger.schemaAnnounced,
        schemaSaved: ledger.schemaSaved,
        compactions: ledger.compactions,
        compactedTokens: ledger.compactedTokens,
        cacheHitRate: Number(ledger.cacheHitRate.toFixed(4)),
        moneySaved: Number(ledger.moneySaved.toFixed(3)),
      },
      updatedAt: Date.now(),
    }
  }

  /**
   * 读请求体（限 64KB）。
   * @param {object} req 请求。
   * @returns {Promise<object>} JSON 对象。
   */
  async function readBody(req) {
    let raw = ''
    for await (const chunk of req) {
      raw += chunk
      if (raw.length > 65536) break
    }
    try {
      return JSON.parse(raw.length === 0 ? '{}' : raw)
    } catch {
      return {}
    }
  }

  /**
   * HTTP 接口：GET 取状态，POST { enabled } 开关。
   * @param {object} req 请求。
   * @param {object} res 响应。
   * @returns {Promise<void>} 完成。
   */
  async function onHttp(req, res) {
    try {
      if (req.method === 'GET') {
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end(JSON.stringify(statusPayload()))
        return
      }
      if (req.method === 'POST') {
        const body = await readBody(req)
        runtimeOn = body?.enabled !== false
        writeState(stateFile, runtimeOn)
        log('info', `控制台开关：${runtimeOn ? '开' : '关'}（来自设置页）`)
        try {
          for (const agent of ctx.get('agents')?.list?.() ?? []) sync(agent)
        } catch {
          // 没有 agent 服务时下一次 assembly 会自己同步
        }
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end(JSON.stringify(statusPayload()))
        return
      }
      res.statusCode = 405
      res.end('method not allowed')
    } catch (error) {
      res.statusCode = 500
      res.end(String(error instanceof Error ? error.message : error))
    }
  }

  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (webCtx) => {
      const dispose = webCtx.webServer.register({
        kind: 'exact',
        path: '/fish-economy/api/state',
        handler: onHttp,
      })
      return () => {
        try {
          dispose()
        } catch {
          // 路由已经跟着 server 一起没了
        }
      }
    })
  }

  // 每秒看一次开关文件：设置页点了开关，这里约 1 秒内生效。
  ctx.effect(() => {
    if (!config.enabled) return undefined
    const timer = setInterval(() => {
      const next = readState(stateFile).enabled
      if (next === runtimeOn) return
      runtimeOn = next
      log('info', `控制台开关：${runtimeOn ? '开' : '关'}（文件变化）`)
      try {
        for (const agent of ctx.get('agents')?.list?.() ?? []) sync(agent)
      } catch {
        // 同上
      }
    }, 1000)
    if (typeof timer.unref === 'function') timer.unref()
    return () => clearInterval(timer)
  }, 'fish-economy: runtime switch')

  log('info', `已加载：闸门=${config.gate.enabled ? '开' : '关'} 瘦身=${config.trim.enabled ? config.trim.mode : '关'} ops=${config.ops.enabled ? '开' : '关'} 预算=${config.budget.enabled ? `${Math.round(config.budget.compactAtTokens / 1000)}K` : '关'}`)
}
