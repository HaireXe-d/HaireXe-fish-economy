/**
 * ops 工具的宿主包装：schema 定义 + 工作目录解析 + 批量执行。
 *
 * 设计上 `src/ops.js` 是纯函数（好测），这里只负责把它接成一个 DSH 工具。
 * 默认只读：写操作要用户显式打开 `ops.writes`，因为绕过宿主的 fs 观察策略
 * （先读后写的账本）是有代价的。
 *
 * @module dsh-fish-economy/src/ops-tool
 */
import { renderBatch, runBatch } from './ops.js'
import { formatTokens } from './token.js'

/** 支持的操作名（写进 description，模型才知道能干什么）。 */
const OPS = ['read', 'stat', 'list', 'glob', 'grep', 'write', 'edit', 'mkdir']

/**
 * 建 ops 工具定义。
 * @param {object} ctx 插件上下文。
 * @param {object} config 已解析配置。
 * @param {{ log: Function }} deps 依赖。
 * @returns {object|undefined} 工具定义；关闭时返回 undefined。
 */
export function createOpsTool(ctx, config, deps) {
  if (!config.ops.enabled) return undefined
  const log = deps.log
  const writes = config.ops.writes === true

  return {
    name: 'ops',
    description: [
      '一个工具顶一组：files 的 read/stat/list/glob/grep 与（可选的）write/edit/mkdir，',
      `一次调用可以塞多个操作（calls 数组），省掉一个个来回。参数按 op 各取所需。`,
      writes ? '写操作已开启。' : '当前只读（写操作请用宿主自带的 write/edit）。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        calls: {
          type: 'array',
          description: '要执行的操作，按顺序串行执行；一个失败不影响其它',
          items: {
            type: 'object',
            additionalProperties: true,
            properties: {
              op: { type: 'string', enum: OPS, description: '操作名' },
              path: { type: 'string', description: '目标路径，相对会话工作目录或绝对路径（默认锁在工作目录内）' },
              offset: { type: 'number', description: 'read 起始行（1 基）' },
              limit: { type: 'number', description: 'read 最多读多少行' },
              pattern: { type: 'string', description: 'glob 的匹配式（支持 * ** ?）或 grep 的正则' },
              include: { type: 'string', description: 'grep 只看匹配这个 glob 的文件' },
              ignoreCase: { type: 'boolean', description: 'grep 忽略大小写' },
              maxMatches: { type: 'number', description: 'grep 最多返回多少处（默认 80）' },
              maxResults: { type: 'number', description: 'glob 最多返回多少个文件（默认 200）' },
              content: { type: 'string', description: 'write 的内容' },
              find: { type: 'string', description: 'edit 要替换的原文' },
              replace: { type: 'string', description: 'edit 的替换文本' },
              all: { type: 'boolean', description: 'edit 替换全部 / list 包含隐藏文件' },
              maxChars: { type: 'number', description: '单个操作的输出上限（字符）' },
            },
            required: ['op'],
          },
        },
        maxChars: { type: 'number', description: '整体输出上限（字符），默认取插件配置' },
      },
      required: ['calls'],
      additionalProperties: false,
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    async execute(args, exec) {
      const calls = Array.isArray(args?.calls) ? args.calls : []
      if (calls.length === 0) return '需要 calls 数组，例如 {"calls":[{"op":"list","path":"."}]}'
      const cwd = String(exec?.agent?.session?.header?.cwd ?? process.cwd())
      const budget = Math.max(500, Number(args?.maxChars) || config.ops.maxChars)
      const started = Date.now()
      const result = await runBatch(calls, {
        cwd,
        writes,
        allowOutside: config.ops.allowOutside === true,
        maxChars: budget,
      })
      const text = renderBatch(result)
      log('debug', `ops 执行 ${calls.length} 个操作，${Date.now() - started}ms，输出 ≈${formatTokens(result.tokens)} token`)
      return text
    },
  }
}
