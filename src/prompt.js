/**
 * 系统提示瘦身 + 预算测量。
 *
 * system-prompt/assemble 是唯一能拿到"这次请求完整装配结果"的地方：sections + tools。
 * 这里做三件事，都不改变语义：
 *   1. 去掉逐字节重复的 section（插件叠加/预设拼接常见的重复整段）。
 *   2. 折叠 3 个以上连续空行、行尾空格、全角空格行 —— 纯格式，不动内容。
 *   3. 按 config.prompt.dropSections 删掉用户明确不要的段。
 * 加上一件事：把 baseline/announced/saved 三块钱算进账本。
 *
 * 重要：带 complete: true 的 section 一律不碰（它代表整个提示词被接管，改它等于改别人的
 * 契约，dsh-unrestricted 那类插件就靠它工作）。
 *
 * @module dsh-fish-economy/src/prompt
 */
import { estimateTextTokens, estimateToolSchemas } from './token.js'

/**
 * 规范化单段文本：折叠多余空行与行尾空白。
 * @param {string} text 原文。
 * @returns {string} 规范化结果。
 */
export function normalizeSectionText(text) {
  return String(text ?? '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\s*\n/, '')
    .trimEnd()
}

/**
 * 按上限掐头去尾保留一段文本（只用于显式配置 maxSectionChars 时）。
 * @param {string} text 原文。
 * @param {number} max 上限。
 * @returns {string} 结果。
 */
export function clipSection(text, max) {
  if (max <= 0 || text.length <= max) return text
  const head = Math.ceil(max * 0.7)
  const tail = Math.max(0, max - head - 40)
  return `${text.slice(0, head)}\n…（本段已按 prompt.maxSectionChars=${max} 裁剪）…\n${tail > 0 ? text.slice(text.length - tail) : ''}`
}

/**
 * 对一次 assembly 的 sections 做无损瘦身。
 * @param {Array<object>} sections 装配出来的 section 列表。
 * @param {{ dedupe?: boolean, dropSections?: string[], maxSectionChars?: number, log?: Function }} options 选项。
 * @returns {{ sections: Array<object>, removedChars: number, dropped: string[], deduped: number }} 结果。
 */
export function slimSections(sections, options) {
  const drop = new Set(options.dropSections ?? [])
  const seen = new Set()
  let removedChars = 0
  let deduped = 0
  const dropped = []
  const out = []
  for (const section of sections ?? []) {
    if (section === null || typeof section !== 'object') {
      out.push(section)
      continue
    }
    const name = String(section.name ?? '')
    if (section.complete === true) {
      out.push(section)
      continue
    }
    if (drop.has(name)) {
      dropped.push(name)
      removedChars += String(section.text ?? '').length
      continue
    }
    const original = String(section.text ?? '')
    let text = normalizeSectionText(original)
    if (options.maxSectionChars !== undefined && options.maxSectionChars > 0) text = clipSection(text, options.maxSectionChars)
    if (options.dedupe === true && text.length >= 200) {
      if (seen.has(text)) {
        deduped += 1
        removedChars += text.length
        out.push({ ...section, text: `（与同名/同文 section 重复，已省略：${name || 'anonymous'}）` })
        continue
      }
      seen.add(text)
    }
    removedChars += original.length - text.length
    out.push(text === original ? section : { ...section, text })
  }
  return { sections: out, removedChars, dropped, deduped }
}

/**
 * 创建提示词模块。
 * @param {object} ctx 插件上下文。
 * @param {object} config 已解析配置。
 * @param {{ log: Function, meter: object, gate: { budgetFor: (agent: object, tools: Array<object>) => { baseline: number, announced: number, saved: number } } }} deps 依赖。
 * @returns {{ install: () => void }} 模块。
 */
export function createPrompt(ctx, config, deps) {
  const log = deps.log
  const meter = deps.meter
  const gate = deps.gate
  const stats = { assemblies: 0, removedChars: 0, deduped: 0 }

  /**
   * assembly waterfall：瘦身 + 记账。
   * @param {object} assembly 装配结果。
   * @param {object} context 装配上下文（含 agent）。
   * @param {Function} next 下游。
   * @returns {Promise<object>} 装配结果。
   */
  async function onAssemble(assembly, context, next) {
    const original = await next()
    stats.assemblies += 1
    const tools = Array.isArray(original?.tools) ? original.tools : []
    const budget = gate.budgetFor(context?.agent, tools)
    meter.recordAssembly(context?.agent, budget)

    if (!config.prompt.enabled) return original
    const result = slimSections(original?.sections, {
      dedupe: config.prompt.dedupeSections,
      dropSections: config.prompt.dropSections,
      maxSectionChars: config.prompt.maxSectionChars,
      log,
    })
    if (result.removedChars <= 0 && result.dropped.length === 0 && result.deduped === 0) return original
    stats.removedChars += result.removedChars
    stats.deduped += result.deduped
    if (result.removedChars > 0) {
      const sectionTokens = Math.round(result.removedChars / 3.2)
      log('debug', `提示词瘦身：省 ${result.removedChars} 字符（≈${sectionTokens} token），丢弃 ${result.dropped.length} 段，去重 ${result.deduped} 段`)
    }
    return { ...original, sections: result.sections }
  }

  return {
    stats: () => ({ ...stats }),
    install() {
      ctx.on('system-prompt/assemble', onAssemble)
    },
  }
}

/**
 * 估算整次请求的提示词成本（sections + tools），用于 report 的"总盘子"。
 * @param {Array<object>} sections section 列表。
 * @param {Array<object>} tools 工具 schema。
 * @returns {{ sections: number, tools: number, total: number }} 成本。
 */
export function assemblyCost(sections, tools) {
  let sectionTokens = 0
  for (const section of sections ?? []) sectionTokens += estimateTextTokens(String(section?.text ?? ''))
  const toolTokens = estimateToolSchemas(tools ?? []).total
  return { sections: sectionTokens, tools: toolTokens, total: sectionTokens + toolTokens }
}
