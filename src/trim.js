/**
 * 上下文瘦身：在内容进历史之前动手，而不是事后压缩。
 *
 * 为什么值得做：历史是每次请求都重发的。第 3 步省下的 1 万字符，会在第 4、5…N 步
 * 每一轮都再省一次，收益是复利的。而 DSH 自带的 compaction 是"事后补救"（历史
 * 超过阈值才总结），这里做的是"入口限流"。
 *
 * 两个钩子：
 *   - tools/post-execute：工具结果超过阈值就掐头去尾。这是最大头，因为 read/grep/
 *     pwsh 的输出动辄上万字符。返回 { kind:'accept', content } 就替换掉了。
 *   - agent/pre-step：同一批输入里重复的长文本块只留第一份（养鱼插件每次唤醒都会
 *     重发人设+规则，重复块很常见）。
 *
 * @module dsh-fish-economy/src/trim
 */
import { estimateTextTokens } from './token.js'

/** 折叠标记。 */
export const TRIM_MARKER = '\n\n…（入口裁剪：省 {chars} 字符，原文共 {total} 字符；需要全文请用 offset/limit 重读或 grep 定位）…\n\n'
/** 批次内重复块的标记。 */
export const DEDUPE_MARKER = '（与上文第 {index} 段重复，已折叠 {chars} 字符）'

/**
 * 掐头去尾保留中段信息量大的部分（头部通常是结果开头的元信息，尾部是合计）。
 * @param {string} text 原文。
 * @param {number} budget 允许保留的最大字符数。
 * @returns {{ text: string, removed: number }} 结果。
 */
export function trimText(text, budget) {
  const source = String(text ?? '')
  if (budget <= 0 || source.length <= budget) return { text: source, removed: 0 }
  const head = Math.ceil(budget * 0.55)
  const tail = Math.max(0, budget - head)
  const removed = source.length - head - tail
  const marker = TRIM_MARKER.replace('{chars}', String(removed)).replace('{total}', String(source.length))
  return { text: source.slice(0, head) + marker + (tail > 0 ? source.slice(source.length - tail) : ''), removed }
}

/**
 * 裁剪一次工具结果的内容块数组（非文本块原样保留）。
 * @param {Array<object>} content 内容块。
 * @param {{ budget: number }} options 选项。
 * @returns {{ content: Array<object>, removed: number }} 结果。
 */
export function trimContent(content, options) {
  let totalChars = 0
  for (const block of content ?? []) if (block?.type === 'text') totalChars += block.text.length
  if (totalChars <= options.budget) return { content, removed: 0 }
  // 单块超预算：整块裁剪；多块超预算：把预算按块长度分摊，只裁最大的那几块。
  const sorted = [...(content ?? [])].map((block, index) => ({ block, index, chars: block?.type === 'text' ? block.text.length : 0 }))
  sorted.sort((a, b) => b.chars - a.chars)
  const out = [...(content ?? [])]
  let remaining = totalChars - options.budget
  let removed = 0
  for (const item of sorted) {
    if (remaining <= 0) break
    if (item.chars <= 0) continue
    const want = Math.min(item.chars, remaining)
    const keep = Math.max(120, item.chars - want)
    const result = trimText(item.block.text, keep)
    out[item.index] = { ...item.block, text: result.text }
    remaining -= result.removed
    removed += result.removed
  }
  return { content: out, removed }
}

/**
 * 取一条消息里的纯文本（用于批次内去重）。
 * @param {unknown} message 消息。
 * @returns {string} 文本。
 */
export function messageText(message) {
  if (typeof message === 'string') return message
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter((block) => block?.type === 'text').map((block) => block.text).join('\n')
}

/**
 * 批次内去重：同一批输入里，长文本块第二次出现就折叠成一句指路。
 * @param {Array<unknown>} messages 消息数组。
 * @param {{ minChars: number }} options 选项。
 * @returns {{ messages: Array<unknown>, duplicated: number, removed: number }} 结果。
 */
export function dedupeBatch(messages, options) {
  const seen = new Map()
  let duplicated = 0
  let removed = 0
  const out = messages.map((message, index) => {
    const content = Array.isArray(message?.content) ? message.content : undefined
    if (content === undefined) return message
    let changed = false
    const next = content.map((block) => {
      if (block?.type !== 'text' || block.text.length < options.minChars) return block
      const key = block.text
      const first = seen.get(key)
      if (first === undefined) {
        seen.set(key, index + 1)
        return block
      }
      changed = true
      duplicated += 1
      removed += block.text.length
      return {
        ...block,
        text: DEDUPE_MARKER.replace('{index}', String(first)).replace('{chars}', String(block.text.length)),
      }
    })
    return changed ? { ...message, content: next } : message
  })
  return { messages: out, duplicated, removed }
}

/**
 * 创建瘦身模块。
 * @param {object} ctx 插件上下文。
 * @param {object} config 已解析配置。
 * @param {{ log: Function, meter: object }} deps 依赖。
 * @returns {{ install: () => void, stats: () => object }} 模块。
 */
export function createTrim(ctx, config, deps) {
  const log = deps.log
  const meter = deps.meter
  const enabled = config.trim.enabled && config.trim.mode !== 'off'
  const stats = { trims: 0, removedChars: 0, duplicates: 0 }

  /**
   * 工具结果入口裁剪。
   * @param {object} exec 执行信息。
   * @param {{ content?: Array<object> }} result 工具结果。
   * @param {Function} next 下一个监听者。
   * @returns {Promise<object>} 决策。
   */
  async function onPostExecute(exec, result, next) {
    const decision = await next()
    if (!enabled || decision.kind !== 'accept') return decision
    const content = decision.content ?? result?.content
    if (!Array.isArray(content)) return decision
    let budget = config.trim.pruneToolResultChars
    // 本插件自己的工具输出已经是紧凑格式，不再二次裁剪。
    if (String(exec?.name ?? '').startsWith('fish_') || exec?.name === 'tool_list' || exec?.name === 'ops') budget = Math.max(budget, 12000)
    const trimmed = trimContent(content, { budget })
    if (trimmed.removed <= 0) return decision
    stats.trims += 1
    stats.removedChars += trimmed.removed
    meter.recordTrim(exec?.agent?.session, trimmed.removed)
    log('debug', `裁剪 ${exec?.name} 结果 ${trimmed.removed} 字符`)
    return { ...decision, content: trimmed.content }
  }

  /**
   * 入口去重（同批重复长文本）。
   * @param {object} payload pre-step 输入。
   * @param {Function} next 下一个监听者。
   * @returns {Promise<object>} 决策。
   */
  async function onPreStep(payload, next) {
    const decision = await next()
    if (!enabled || config.trim.mode !== 'dedupe' || decision.kind !== 'enter') return decision
    if (!Array.isArray(decision.messages) || decision.messages.length === 0) return decision
    const result = dedupeBatch(decision.messages, { minChars: config.trim.dedupeMinChars })
    if (result.removed <= 0) return decision
    stats.duplicates += result.duplicated
    stats.removedChars += result.removed
    log('debug', `入口去重折叠 ${result.duplicated} 块，省 ${result.removed} 字符`)
    return { ...decision, messages: result.messages }
  }

  return {
    stats: () => ({ ...stats }),
    install() {
      if (!enabled) return
      ctx.on('tools/post-execute', onPostExecute)
      ctx.on('agent/pre-step', onPreStep)
    },
  }
}
