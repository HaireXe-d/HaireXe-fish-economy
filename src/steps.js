/**
 * 省步骤：一条消息别拆成好几步。
 *
 * 为什么值得做：养鱼会话实测**每条消息平均 5.5 次请求**，每次请求都要把 272K 的上下文
 * 重新发一遍。每少一步，就少一次整段重发。压到 4 步省 27%，压到 3 步省 45%。
 *
 * 做法：给养鱼会话加一句很短的提示（只在 gate.scope 匹配的会话里生效，别的会话 section 为空、
 * 直接不出现），让模型：
 *   1) 能一次做完的别拆成多步；
 *   2) 同一步能并行调用的工具就并行；
 *   3) 不要为了确认再单独读一遍刚读过的内容。
 *
 * 代价：每次请求多一句提示（约 60 token）。只要它每 100 轮少拆一步，就已经回本。
 * 关掉：config.steps.enabled = false，或者卡片上总开关。
 *
 * @module dsh-fish-economy/src/steps
 */

/** 默认提示语：短、具体、可执行。 */
export const DEFAULT_HINT = '【省步骤】能一次做完的别拆成多步；同一步能并行调用的工具就并行；不要为了确认再单独读一遍刚读过的内容。'

/**
 * 建省步骤模块。
 * @param {object} ctx 插件上下文。
 * @param {object} config 已解析配置。
 * @param {{ log: Function, inScope: (agent: object) => boolean, isOn: () => boolean }} deps 依赖。
 * @returns {{ install: () => (() => void) | undefined }} 模块。
 */
export function createSteps(ctx, config, deps) {
  const log = deps.log
  const inScope = deps.inScope
  const isOn = deps.isOn

  return {
    install() {
      if (config.steps === undefined || config.steps.enabled !== true) return undefined
      if (typeof ctx.systemPrompt?.section !== 'function') {
        log('warn', '省步骤：没有 systemPrompt.section，跳过提示语')
        return undefined
      }
      const hint = String(config.steps.hint ?? DEFAULT_HINT)
      let dispose
      try {
        dispose = ctx.systemPrompt.section({
          name: 'fish-economy:steps',
          order: 9600,
          // 不在范围内 / 总开关关着 → 返回空串，宿主会把这段丢掉。
          text: (context) => (isOn() && inScope(context?.agent) ? hint : ''),
        })
      } catch (error) {
        log('warn', `省步骤：注册提示段失败（${error instanceof Error ? error.message : String(error)}）`)
        return undefined
      }
      log('debug', `省步骤：已加提示（${hint.length} 字）`)
      return () => {
        try {
          dispose?.()
        } catch {
          // 卸载期的失败不影响别的插件
        }
      }
    },
  }
}
