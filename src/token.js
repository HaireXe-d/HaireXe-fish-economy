/**
 * 中文友好的 token 估算器。
 *
 * 为什么不用 DSH 自带的 4 字符/token：那条规则只对英文散文成立。中文一个字
 * 大约 1 token，一个 JSON schema 里结构符号比散文更密（约 3.4–3.8 字符/token），
 * 混排场景直接套 4 会低估 2–3 倍 —— 视频里"50 个工具 11K token"就来自这里。
 *
 * 这里的估算器按码点分类计价：
 *   - ASCII 可见字符：ASCII_CHARS_PER_TOKEN 个一起算 1 token（连写累加后向上取整）
 *   - CJK 汉字/假名/韩文/全角标点：1 字 1 token
 *   - 其它非 ASCII（emoji 等）：EMOJI_TOKENS 个 token
 *   - 换行：0 token（分词时通常并进前一个 token）
 *
 * 常量由 bench/analyze-sessions.mjs 拿真实 session 的 usage 回归校准，改之前先跑
 * `npm run bench:sessions -- --calibrate`，别凭感觉动。
 *
 * @module dsh-fish-economy/src/token
 */

/** ASCII 字符的固定密度：英文散文约 4.0，JSON/代码约 3.6，取中位数偏保守。 */
export const ASCII_CHARS_PER_TOKEN = 3.7
/** 每个 emoji 之类非 CJK 非 ASCII 符号的计价。 */
export const EMOJI_TOKENS = 2
/** 每个内容块的结构开销（JSON 框架、type 标签）。 */
export const BLOCK_OVERHEAD = 4

const CJK_PATTERN = /[\u1100-\u11FF\u2E80-\uA4CF\uA960-\uA97F\uAC00-\uD7FF\uF900-\uFAFF\uFE10-\uFE6F\uFF00-\uFFEF\u3000-\u303F\u3040-\u30FF\u4E00-\u9FFF]/

/**
 * 判断一个码点是否按"一字一 token"计价。
 * @param {string} char 单个码点（代理对已合并）。
 * @returns {boolean} 是否 CJK 类字符。
 */
export function isCjk(char) {
  return CJK_PATTERN.test(char)
}

/**
 * 估算一段文本的 token 数。
 * @param {string} text 任意文本。
 * @returns {number} 估算 token 数（非负整数）。
 */
export function estimateTextTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return 0
  let tokens = 0
  let latin = 0
  const flushLatin = () => {
    if (latin > 0) {
      tokens += Math.ceil(latin / ASCII_CHARS_PER_TOKEN)
      latin = 0
    }
  }
  for (const char of text) {
    const code = char.codePointAt(0)
    if (code === 10 || code === 13) continue
    if (code < 128) {
      if (char === ' ' || char === '\t') {
        // 空格便宜：连续空格往往并进同一个 token，这里按 3 个 1 token 粗算。
        latin += 0.4
      } else {
        latin += 1
      }
      continue
    }
    flushLatin()
    tokens += isCjk(char) ? 1 : EMOJI_TOKENS
  }
  flushLatin()
  return tokens
}

/**
 * 估算一段 JSON 值的 token 数（序列化后按同一密度计价 + 结构开销）。
 * @param {unknown} value 可序列化的值。
 * @returns {number} 估算 token 数。
 */
export function estimateJsonTokens(value) {
  if (value === undefined) return 0
  let json
  try {
    json = JSON.stringify(value)
  } catch {
    return 0
  }
  if (json === undefined) return 0
  return estimateTextTokens(json) + BLOCK_OVERHEAD
}

/**
 * 估算一个工具 schema（name/description/parameters）在请求里的成本。
 * 只统计真正上线到模型的三段，不掺本地回调。
 * @param {{ name?: string, description?: string, parameters?: unknown }} schema 工具 schema。
 * @returns {number} 估算 token 数。
 */
export function estimateToolSchemaTokens(schema) {
  if (schema === undefined || schema === null) return 0
  const name = typeof schema.name === 'string' ? schema.name : ''
  const description = typeof schema.description === 'string' ? schema.description : ''
  const parameters = schema.parameters ?? {}
  return estimateJsonTokens({ name, description, parameters })
}

/**
 * 估算一组工具 schema 的总成本，返回总数与按工具拆开的明细（明细按成本降序）。
 * @param {Array<{ name?: string }>} schemas 工具 schema 列表。
 * @returns {{ total: number, byTool: Array<{ name: string, tokens: number }> }} 汇总与明细。
 */
export function estimateToolSchemas(schemas) {
  const byTool = []
  let total = 0
  for (const schema of schemas ?? []) {
    const tokens = estimateToolSchemaTokens(schema)
    total += tokens
    byTool.push({ name: String(schema?.name ?? '(anonymous)'), tokens })
  }
  byTool.sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name))
  return { total, byTool }
}

/**
 * 估算一条模型可见消息（content block 数组）的 token 数。
 * @param {{ role?: string, content?: Array<object> }} message 消息。
 * @returns {number} 估算 token 数。
 */
export function estimateMessageTokens(message) {
  if (message === undefined || message === null) return 0
  let tokens = 4 // role 框架开销
  for (const block of message.content ?? []) {
    if (block?.type === 'text' || block?.type === 'reasoning') {
      tokens += estimateTextTokens(block.text ?? '') + BLOCK_OVERHEAD
    } else if (block?.type === 'tool-call') {
      tokens += estimateTextTokens(String(block.name ?? ''))
        + estimateTextTokens(String(block.arguments ?? ''))
        + BLOCK_OVERHEAD
    } else {
      tokens += estimateJsonTokens(block)
    }
  }
  return tokens
}

/**
 * 估算一整条消息数组的 token 数。
 * @param {Array<object>} messages 消息数组。
 * @returns {number} 估算 token 数。
 */
export function estimateMessagesTokens(messages) {
  let total = 0
  for (const message of messages ?? []) total += estimateMessageTokens(message)
  return total
}

/**
 * 把 token 数格式化成人类可读的短字符串（视频和报告里直接用）。
 * @param {number} tokens token 数。
 * @returns {string} 形如 "11.2K" / "803.4K" / "42" 的字符串。
 */
export function formatTokens(tokens) {
  const value = Number(tokens) || 0
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 10_000) return `${(value / 1000).toFixed(1)}K`
  if (value >= 1000) return `${(value / 1000).toFixed(2)}K`
  return String(Math.round(value))
}

/**
 * 把 token 数折算成人民币（按 deepseek-flash 缓存命中价与全价分开算，均为占位默认值，
 * 用户可在 config 里覆盖）。
 * @param {number} tokens token 数。
 * @param {{ cacheHit?: boolean, pricePerMTok?: number }} [options] 计价选项。
 * @returns {number} 金额（元）。
 */
export function priceOf(tokens, options = {}) {
  const price = options.pricePerMTok ?? (options.cacheHit ? 0.2 : 1)
  return ((Number(tokens) || 0) / 1_000_000) * price
}
