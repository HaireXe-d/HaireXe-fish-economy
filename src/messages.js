/**
 * 消息路径：在养鱼插件把消息投进会话之前，去掉"之前已经发过的那一段"。
 *
 * 为什么要动这条路径：养鱼插件（QQ / B 站）每次投递都用
 * `sessionController.prompt({ sessionId, mode:'queue', content:[...] })`，
 * 而每条消息里都捆着一整段固定的指令（"按以下专属通道流程做…"），每条都发一遍。
 * 实测同一批会话里，**入站消息 81.3% 的字符是之前已经发过的段落**，
 * 它们进了历史以后每一轮请求都要再带一次 —— 这是收发路径上最大的一笔浪费。
 *
 * 做法：包住 `sessionController.prompt`，在真正投递之前把"本会话已经出现过的段落"
 * 压成一小段提示（默认保留开头 200 字 + 一句"其余同上"），第一次出现的不动。
 * 不改养鱼插件一行代码，卸载时把原方法还回去。
 *
 * 只管入站：出站（她的回复）本来就不进上下文，没必要动。
 *
 * @module dsh-fish-economy/src/messages
 */
import { estimateTextTokens } from './token.js'

/** 防止同一个 controller 被重复包装。 */
const WRAPPED = Symbol.for('dsh-fish-economy.message-path')

/**
 * 把一段文本按空行切成段。
 * @param {string} text 原文。
 * @returns {string[]} 段数组（保留原始顺序）。
 */
export function splitParagraphs(text) {
  return String(text ?? '').split(/(\n{2,})/)
}

/**
 * 压缩一段"已经发过"的文本：保留开头若干字 + 一句说明。
 * @param {string} paragraph 原文。
 * @param {number} keep 保留多少字（0 表示整段丢掉）。
 * @returns {string} 压缩后的文本。
 */
export function compressSeen(paragraph, keep) {
  const text = String(paragraph ?? '')
  const head = keep > 0 ? text.slice(0, keep) : ''
  const rest = Math.max(0, text.length - head.length)
  if (rest === 0) return text
  return `${head}……（后面 ${rest} 字与上文相同，未变，不用重读）`
}

/**
 * 处理一条消息的 content block 数组：重复段落压缩。
 * @param {Array<object>} content 内容块。
 * @param {{ seen: Set<string>, minChars: number, keep: number, mode: 'short'|'full' }} options 选项。
 * @returns {{ content: Array<object>, savedChars: number, compressed: number }} 结果。
 */
export function dedupeContent(content, options) {
  let savedChars = 0
  let compressed = 0
  const out = []

  for (const block of content ?? []) {
    if (block?.type !== 'text' || typeof block.text !== 'string') {
      out.push(block)
      continue
    }
    const parts = splitParagraphs(block.text)
    const rebuilt = parts.map((part) => {
      // 分隔符原样保留
      if (/^\n+$/.test(part)) return part
      const paragraph = part
      if (paragraph.trim().length < options.minChars) return paragraph
      const key = paragraph.trim().slice(0, 160)
      if (!options.seen.has(key)) {
        options.seen.add(key)
        return paragraph
      }
      // 保留多少：不超过总长的 35%，否则"说明文字"比省下来的还多
      const keep = options.mode === 'full' ? 0 : Math.min(options.keep, Math.floor(paragraph.length * 0.35))
      const replacement = compressSeen(paragraph, keep)
      // 不划算就别压（短段落压缩后反而更长）
      if (replacement.length >= paragraph.length - 20) return paragraph
      compressed += 1
      savedChars += paragraph.length - replacement.length
      return replacement
    })
    const text = rebuilt.join('')
    out.push(text === block.text ? block : { ...block, text })
  }

  return { content: out, savedChars, compressed }
}

/**
 * 建消息路径模块。
 * @param {object} ctx 插件上下文。
 * @param {object} config 已解析配置。
 * @param {{ log: Function, meter: object, inScope: (agent: object) => boolean, isOn: () => boolean }} deps 依赖。
 * @returns {{ install: () => void, stats: () => object }} 模块。
 */
export function createMessagePath(ctx, config, deps) {
  const log = deps.log
  const meter = deps.meter
  const inScope = deps.inScope
  const isOn = deps.isOn
  /** @type {Map<string, Set<string>>} sessionId -> 已见过的段 */
  const seenBySession = new Map()
  const stats = { prompts: 0, compressed: 0, savedChars: 0 }
  const MAX_SEEN = 4000

  /**
   * 取（或建）某个会话的"已见过"集合。
   * @param {string} sessionId 会话 id。
   * @returns {Set<string>} 集合。
   */
  function seenOf(sessionId) {
    let set = seenBySession.get(sessionId)
    if (set === undefined) {
      set = new Set()
      seenBySession.set(sessionId, set)
    }
    // 太大会吃内存：超上限就清掉重来（只会让下一批重复段再露一次面，不影响正确性）
    if (set.size > MAX_SEEN) set.clear()
    return set
  }

  /**
   * 这个会话要不要管：看它的 agent 是否落在 gate.scope 里。
   * @param {string} sessionId 会话 id。
   * @returns {boolean} 是否处理。
   */
  function sessionInScope(sessionId) {
    try {
      const agent = ctx.get('agents')?.get?.(sessionId)
      if (agent === undefined || agent === null) return false
      return inScope(agent) === true
    } catch {
      return false
    }
  }

  return {
    stats: () => ({ ...stats }),
    install() {
      if (!config.messages.enabled || config.messages.mode === 'off') return
      if (typeof ctx.inject !== 'function') return
      ctx.inject(['sessionController'], (serviceCtx) => {
        const controller = serviceCtx.sessionController
        if (controller === undefined || controller === null || typeof controller.prompt !== 'function') return undefined
        if (controller[WRAPPED] === true) return undefined
        const original = controller.prompt

        /**
         * 包装后的 prompt：先把重复段压掉，再交给原来的实现。
         * @param {object} request 原始请求 { sessionId, mode, content }。
         * @param {AbortSignal} [signal] 取消信号。
         * @returns {Promise<unknown>} 原实现的结果。
         */
        const patched = async function patchedPrompt(request, signal) {
          try {
            if (isOn() && request !== null && typeof request === 'object' && Array.isArray(request.content)) {
              const sessionId = String(request.sessionId ?? '')
              if (sessionId !== '' && sessionInScope(sessionId)) {
                const result = dedupeContent(request.content, {
                  seen: seenOf(sessionId),
                  minChars: config.messages.minChars,
                  keep: config.messages.keep,
                  mode: config.messages.mode,
                })
                if (result.savedChars > 0) {
                  stats.prompts += 1
                  stats.compressed += result.compressed
                  stats.savedChars += result.savedChars
                  meter.recordMessage({ header: { id: sessionId } }, result.savedChars)
                  log('debug', `消息路径：压缩 ${result.compressed} 段，省 ${result.savedChars} 字符（≈${estimateTextTokens('x'.repeat(Math.min(result.savedChars, 4000)))} token 量级）`)
                  return original.call(controller, { ...request, content: result.content }, signal)
                }
              }
            }
          } catch (error) {
            // 任何异常都退回原样投递，绝不弄丢消息
            log('warn', `消息路径处理失败，按原样投递：${error instanceof Error ? error.message : String(error)}`)
          }
          return original.call(controller, request, signal)
        }

        controller.prompt = patched
        try {
          controller[WRAPPED] = true
        } catch {
          // 冻结对象就跳过标记，靠 dispose 还原
        }
        log('info', `消息路径：已接管 sessionController.prompt（mode=${config.messages.mode}，保留 ${config.messages.keep} 字）`)

        return () => {
          if (controller.prompt === patched) controller.prompt = original
          try {
            controller[WRAPPED] = false
          } catch {
            // 忽略
          }
        }
      })
    },
  }
}
