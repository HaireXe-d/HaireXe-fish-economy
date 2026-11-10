/**
 * 账本：把"省了多少"从感觉变成数字。
 *
 * 三个来源：
 *   1. 每次 assembly 拿到的工具成本（baseline 全量 vs announced 实际下发），差额就是
 *      这一轮闸门省下的 schema token —— 不依赖 API 计费，本地就能算。
 *   2. 真实 usage（assistant/message 事件里的 input/output/cacheRead/cacheWrite），
 *      用来校准、算缓存命中率，以及验证"工具集合一变缓存就断"这件事。
 *   3. 裁剪收益（trim 模块每次截掉多少字符）。
 *
 * 落盘：$DSH_HOME/fish-economy/summary.json（覆盖写）+ ledger.jsonl（按轮追加）。
 * 写盘全部包在 try/catch 里 —— 记账失败绝不影响会话。
 *
 * @module dsh-fish-economy/src/meter
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { estimateTextTokens, formatTokens } from './token.js'

/**
 * 建一个空的会话账本。
 * @param {string} id 会话 id。
 * @returns {object} 账本。
 */
export function emptySession(id) {
  return {
    id,
    turns: 0,
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    schemaBaseline: 0,
    schemaAnnounced: 0,
    schemaSaved: 0,
    trimCharsSaved: 0,
    trims: 0,
    lastContextTokens: 0,
    compactions: 0,
    compactedTokens: 0,
    messageCharsSaved: 0,
    messageCompressions: 0,
    steps: 0,
    updatedAt: 0,
  }
}

/**
 * 创建账本服务。
 * @param {object} options 选项。
 * @param {object} options.config 已解析配置。
 * @param {(level: string, message: string) => void} [options.log] 日志函数。
 * @returns {{
 *   recordAssembly: (agent: object, budget: { baseline: number, announced: number, saved: number }) => void,
 *   recordUsage: (session: object, usage: object) => void,
 *   recordTurn: (session: object) => void,
 *   recordTrim: (session: object, chars: number) => void,
 *   report: (scope?: 'session'|'total', sessionId?: string) => object,
 *   text: (scope?: 'session'|'total', sessionId?: string) => string,
 *   flush: () => void,
 *   sessions: () => object[],
 * }} 账本 API。
 */
export function createMeter(options) {
  const config = options.config
  const log = options.log ?? (() => {})
  const dir = config.meter.dir !== '' ? config.meter.dir : join(homedir(), '.dsh', 'fish-economy')
  /** @type {Map<string, ReturnType<typeof emptySession>>} */
  const sessions = new Map()
  let dirty = false
  let lastFlush = 0

  /**
   * 取（或建）一个会话账本。
   * @param {object} session 会话对象。
   * @returns {ReturnType<typeof emptySession>} 账本。
   */
  function sessionOf(session) {
    const id = String(session?.header?.id ?? session?.id ?? session?.header?.cwd ?? 'unknown')
    let entry = sessions.get(id)
    if (entry === undefined) {
      entry = emptySession(id)
      sessions.set(id, entry)
    }
    return entry
  }

  /**
   * 把某次 assembly 的工具成本记进去。
   * @param {object} agent agent 对象。
   * @param {{ baseline: number, announced: number, saved: number }} budget 成本三元组。
   * @returns {void}
   */
  function recordAssembly(agent, budget) {
    if (!config.meter.enabled) return
    const entry = sessionOf(agent?.session)
    entry.schemaBaseline = Math.max(entry.schemaBaseline, Math.round(budget.baseline))
    entry.schemaAnnounced = Math.round(budget.announced)
    entry.schemaSaved += Math.round(budget.saved)
    entry.updatedAt = Date.now()
    dirty = true
  }

  /**
   * 记一次真实 usage。
   * @param {object} session 会话。
   * @param {{ inputTokens?: number, outputTokens?: number, cacheReadTokens?: number, cacheWriteTokens?: number }} usage 用量。
   * @returns {void}
   */
  function recordUsage(session, usage) {
    if (!config.meter.enabled || usage === undefined || usage === null) return
    const entry = sessionOf(session)
    entry.requests += 1
    entry.inputTokens += usage.inputTokens ?? 0
    entry.outputTokens += usage.outputTokens ?? 0
    entry.cacheReadTokens += usage.cacheReadTokens ?? 0
    entry.cacheWriteTokens += usage.cacheWriteTokens ?? 0
    // 最近一次请求的上下文体量（输入 + 缓存读），预算闸用它判断该不该压缩。
    entry.lastContextTokens = (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0)
    entry.updatedAt = Date.now()
    dirty = true
  }

  /**
   * 记一轮结束。
   * @param {object} session 会话。
   * @returns {void}
   */
  function recordTurn(session) {
    if (!config.meter.enabled) return
    sessionOf(session).turns += 1
    dirty = true
    flush()
  }

  /**
   * 记一步（step/start）：用来算"每条消息跑了几步"。
   * @param {object} session 会话。
   * @returns {void}
   */
  function recordStep(session) {
    if (!config.meter.enabled) return
    sessionOf(session).steps += 1
    dirty = true
  }

  /**
   * 记一次裁剪。
   * @param {object} session 会话。
   * @param {number} chars 省下的字符数。
   * @returns {void}
   */
  function recordTrim(session, chars) {
    if (!config.meter.enabled || chars <= 0) return
    const entry = sessionOf(session)
    entry.trimCharsSaved += Math.round(chars)
    entry.trims += 1
    dirty = true
  }

  /**
   * 最近一次请求的上下文体量（输入 + 缓存读）。
   * @param {object} session 会话。
   * @returns {number} token 数。
   */
  function contextOf(session) {
    return sessionOf(session).lastContextTokens ?? 0
  }

  /**
   * 记一次上下文压缩。
   * @param {object} session 会话。
   * @param {number} tokens 被摘要掉的 token 数。
   * @returns {void}
   */
  function recordCompaction(session, tokens) {
    if (!config.meter.enabled) return
    const entry = sessionOf(session)
    entry.compactions += 1
    entry.compactedTokens += Math.max(0, Math.round(tokens))
    dirty = true
  }

  /**
   * 记一次入站消息压缩（消息路径省下的字符）。
   * @param {object} session 会话。
   * @param {number} chars 省下的字符数。
   * @returns {void}
   */
  function recordMessage(session, chars) {
    if (!config.meter.enabled || chars <= 0) return
    const entry = sessionOf(session)
    entry.messageCharsSaved += Math.round(chars)
    entry.messageCompressions += 1
    dirty = true
  }

  /**
   * 汇总一个或全部会话。
   * @param {'session'|'total'} [scope] 范围。
   * @param {string} [sessionId] 指定会话 id。
   * @returns {object} 汇总。
   */
  function report(scope = 'total', sessionId) {
    const list = [...sessions.values()].filter((entry) => sessionId === undefined || entry.id === sessionId)
    const rows = scope === 'session' && list.length > 0 ? [list[list.length - 1]] : list
    const sum = emptySession(scope === 'session' ? rows[0]?.id ?? 'session' : 'total')
    for (const row of rows) {
      for (const key of ['turns', 'requests', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'schemaSaved', 'trimCharsSaved', 'trims', 'compactions', 'compactedTokens', 'messageCharsSaved', 'messageCompressions', 'steps']) {
        sum[key] += row[key] ?? 0
      }
      sum.schemaBaseline = Math.max(sum.schemaBaseline, row.schemaBaseline)
      sum.schemaAnnounced = Math.max(sum.schemaAnnounced, row.schemaAnnounced)
    }
    const totalTokens = sum.inputTokens + sum.outputTokens + sum.cacheReadTokens + sum.cacheWriteTokens
    const perRequest = sum.requests === 0 ? 0 : totalTokens / sum.requests
    const cacheBase = sum.inputTokens + sum.cacheReadTokens + sum.cacheWriteTokens
    // 折算成"计费权重 token"：缓存读按 cachePricePerMTok / pricePerMTok 折算，
    // 这样缓存命中率高的时候不会把省下的 token 吹成钱。
    const cacheWeight = config.meter.pricePerMTok === 0 ? 1 : config.meter.cachePricePerMTok / config.meter.pricePerMTok
    const billable = sum.inputTokens + sum.outputTokens + sum.cacheWriteTokens + sum.cacheReadTokens * cacheWeight
    const savedBillable = sum.schemaSaved * (cacheBase === 0 ? 1 : (sum.inputTokens + cacheWeight * sum.cacheReadTokens) / cacheBase)
    return {
      scope,
      sessions: rows.length,
      turns: sum.turns,
      requests: sum.requests,
      totalTokens,
      perRequest,
      inputTokens: sum.inputTokens,
      outputTokens: sum.outputTokens,
      cacheReadTokens: sum.cacheReadTokens,
      cacheHitRate: cacheBase === 0 ? 0 : (sum.cacheReadTokens + sum.cacheWriteTokens) / cacheBase,
      schemaBaseline: sum.schemaBaseline,
      schemaAnnounced: sum.schemaAnnounced,
      schemaSaved: sum.schemaSaved,
      savedBillable,
      trimCharsSaved: sum.trimCharsSaved,
      trims: sum.trims,
      compactions: sum.compactions,
      compactedTokens: sum.compactedTokens,
      messageCharsSaved: sum.messageCharsSaved,
      messageCompressions: sum.messageCompressions,
      steps: sum.steps,
      stepsPerTurn: sum.turns === 0 ? 0 : sum.steps / sum.turns,
      moneySaved: (savedBillable / 1_000_000) * config.meter.pricePerMTok,
      moneySpent: (billable / 1_000_000) * config.meter.pricePerMTok,
    }
  }

  /**
   * 把汇总渲染成一段给模型/人看的短报告。
   * @param {'session'|'total'} [scope] 范围。
   * @param {string} [sessionId] 会话 id。
   * @returns {string} 报告文本。
   */
  function text(scope = 'total', sessionId) {
    const data = report(scope, sessionId)
    const lines = []
    lines.push(`鱼缸账本（${scope === 'session' ? '本会话' : '累计'}，${data.sessions} 个会话 / ${data.requests} 次请求 / ${data.turns} 轮）`)
    lines.push(`  工具定义：${formatTokens(data.schemaBaseline)} → ${formatTokens(data.schemaAnnounced)} token/请求`)
    lines.push(`  闸门累计省：${formatTokens(data.schemaSaved)} token（折算计费 ${formatTokens(data.savedBillable)}）`)
    if (data.trimCharsSaved > 0) lines.push(`  裁剪累计省：${formatTokens(Math.round(data.trimCharsSaved / 1.6))} token（${data.trims} 次）`)
    if (data.steps > 0) lines.push(`  步骤：${data.steps} 步 / ${data.turns} 轮 = 每轮 ${data.stepsPerTurn.toFixed(1)} 步（每步都是一次整段重发）`)
    if (data.messageCharsSaved > 0) lines.push(`  消息路径省：${formatTokens(Math.round(data.messageCharsSaved / 2.2))} token（${data.messageCompressions} 条消息里的重复段落被压短）`)
    if (data.compactions > 0) lines.push(`  预算闸压缩：${data.compactions} 次，共释放 ${formatTokens(data.compactedTokens)} token（平均上下文 ${formatTokens(data.perRequest)}/请求）`)
    lines.push(`  真实用量：总 ${formatTokens(data.totalTokens)}，其中输入 ${formatTokens(data.inputTokens)}、输出 ${formatTokens(data.outputTokens)}、缓存读 ${formatTokens(data.cacheReadTokens)}`)
    lines.push(`  缓存命中率：${(data.cacheHitRate * 100).toFixed(1)}%；平均每次请求 ${formatTokens(data.perRequest)} token`)
    lines.push(`  估计花费：约 ¥${data.moneySpent.toFixed(2)}（含缓存折扣），已省约 ¥${data.moneySaved.toFixed(2)}`)
    return lines.join('\n')
  }

  /**
   * 落盘：summary.json 覆盖写，ledger.jsonl 追加。
   * @returns {void}
   */
  function flush() {
    if (!config.meter.enabled || !dirty) return
    const now = Date.now()
    if (now - lastFlush < 800) return
    lastFlush = now
    dirty = false
    try {
      mkdirSync(dir, { recursive: true })
      const data = report('total')
      writeFileSync(join(dir, 'summary.json'), `${JSON.stringify({ ...data, sessions: [...sessions.values()].map((entry) => ({ ...entry })) }, null, 2)}\n`, 'utf8')
      appendFileSync(join(dir, 'ledger.jsonl'), `${JSON.stringify({ at: new Date(now).toISOString(), ...data, sessions: undefined })}\n`, 'utf8')
    } catch (error) {
      log('warn', `账本写盘失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return {
    recordAssembly,
    recordUsage,
    recordTurn,
    recordStep,
    recordTrim,
    recordCompaction,
    recordMessage,
    contextOf,
    report,
    text,
    flush,
    sessions: () => [...sessions.values()],
  }
}

/**
 * 估算一段文本的 token（给 trim 模块复用，保持单一实现）。
 * @param {string} text 文本。
 * @returns {number} token 数。
 */
export { estimateTextTokens }
