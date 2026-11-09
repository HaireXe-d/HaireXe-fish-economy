/**
 * 预算闸：给会话装一个"上下文天花板"。
 *
 * 为什么需要它：真实数据里，养鱼那类机器人 276K token/请求、峰值 664K，而**整批会话一次压缩都没触发过**
 * （宿主默认阈值 0.8，要 80 万才动）。工具面和裁剪加起来只能省 3%，因为钱全在历史里。
 *
 * 做法：每次拿到真实 usage（assistant/message）就记一下上下文体量；超过阈值时，
 * 在会话空闲的那一刻调用宿主的 `ctx.compaction.compactNow(agent, signal)`，
 * 把旧历史压成一条摘要。我们不自己写摘要，也不改宿主的压缩策略 —— 只负责"什么时候该压"。
 *
 * 边界：
 *   - agent 不空闲（`compactNow` 会抛 busy）就跳过，下一次再试；
 *   - 没有 `ctx.compaction` 服务（profile 没挂后端）时整体禁用；
 *   - 压缩本身要烧一次摘要调用，所以有最小间隔与阈值，不做"压完立刻再压"。
 *
 * @module dsh-fish-economy/src/budget
 */
import { formatTokens } from './token.js'

/**
 * 建预算闸。
 * @param {object} ctx 插件上下文。
 * @param {object} config 已解析配置。
 * @param {{
 *   log: Function,
 *   meter: object,
 *   agentOf: (session: object) => object | undefined,
 *   inScope?: (agent: object) => boolean,
 * }} deps 依赖。
 * @returns {{ install: () => void, stats: () => object }} 模块。
 */
export function createBudget(ctx, config, deps) {
  const log = deps.log
  const meter = deps.meter
  const agentOf = deps.agentOf
  /** @type {WeakMap<object, { at: number, inflight: boolean }>} */
  const states = new WeakMap()
  const stats = { attempts: 0, compactions: 0, freedTokens: 0, skipped: 0 }

  /**
   * 取（或建）一个 agent 的预算状态。
   * @param {object} agent agent。
   * @returns {{ at: number, inflight: boolean }} 状态。
   */
  function stateOf(agent) {
    let state = states.get(agent)
    if (state === undefined) {
      state = { at: 0, inflight: false }
      states.set(agent, state)
    }
    return state
  }

  /**
   * 判断这次是否值得压缩。
   * @param {object} agent agent。
   * @param {object} session 会话。
   * @returns {boolean} 是否触发。
   */
  function worthCompacting(agent, session) {
    const compaction = ctx.get('compaction')
    if (compaction === undefined || typeof compaction.compactNow !== 'function') return false
    if (deps.inScope !== undefined && deps.inScope(agent) !== true) return false
    const contextTokens = meter.contextOf(session)
    if (contextTokens < config.budget.compactAtTokens) return false
    const state = stateOf(agent)
    if (state.inflight) return false
    if (Date.now() - state.at < config.budget.minIntervalMs) return false
    return true
  }

  /**
   * 触发一次压缩；失败只记日志，绝不影响会话。
   * @param {object} agent agent。
   * @param {object} session 会话。
   * @returns {Promise<void>} 完成。
   */
  async function maybeCompact(agent, session) {
    if (!worthCompacting(agent, session)) return
    const state = stateOf(agent)
    state.inflight = true
    state.at = Date.now()
    stats.attempts += 1
    const before = meter.contextOf(session)
    try {
      // compactNow 自己会走 agent.runMaintenance，这里先等它真正空闲。
      await agent.whenIdle?.()
      const signal = AbortSignal.timeout(config.budget.timeoutMs)
      const result = await ctx.get('compaction').compactNow(agent, signal)
      if (result === null || result === undefined) {
        stats.skipped += 1
        log('debug', '预算闸：没有可压缩的区间')
        return
      }
      stats.compactions += 1
      stats.freedTokens += result.shadowedTokenCount ?? 0
      meter.recordCompaction(session, result.shadowedTokenCount ?? 0)
      log('info', `预算闸：压缩 ${before} → 之后 ${formatTokens(result.shadowedTokenCount ?? 0)} token 已释放`)
    } catch (error) {
      // busy 是正常竞态（机器人刚好又来消息），其余也按"下次再说"处理。
      stats.skipped += 1
      log('debug', `预算闸跳过：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      state.inflight = false
    }
  }

  return {
    stats: () => ({ ...stats }),
    install() {
      if (!config.budget.enabled) return
      ctx.on('turn/end', (payload) => {
        const agent = payload?.agent
        if (agent === undefined || agent === null) return
        const session = agent.session
        if (session === undefined) return
        // 不阻塞事件派发：压缩是后台动作。
        void maybeCompact(agent, session)
      })
      ctx.on('session/event', (session, event) => {
        // 兜底：有些 profile 不派发 agent 级 turn/end，用会话事件补。
        if (event?.type !== 'turn/end') return
        const agent = agentOf(session)
        if (agent === undefined) return
        void maybeCompact(agent, session)
      })
    },
  }
}
