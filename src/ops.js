/**
 * ops：一个工具干完以前六七个工具干的事。
 *
 * 动机（和 dsh-ops 同一个观察）：工具定义的成本是按"个数"收的，不是按能力收的。
 * 把 read/write/edit/list/glob/grep/stat 压成一个 ops，schema 从 ~1400 token 降到
 * 一个，且一次调用可以塞多个操作，省掉"读一个文件一个来回"的轮次。
 *
 * 取舍：默认只读（ops.writes=false）。写操作绕过宿主 fs-observation-policy 的
 * "先读后写"账本，所以默认关闭，需要用户自己开；路径默认锁在会话工作目录内。
 *
 * @module dsh-fish-economy/src/ops
 */
import { mkdir, readdir, readFile, stat as fsStat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { estimateTextTokens } from './token.js'

/** 遍历时永远跳过的目录名。 */
const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', 'dist', 'build', '.next', '.cache', '__pycache__', '.venv', 'venv', 'target', 'coverage'])
/** 单个文件参与 grep 的最大字节数。 */
const MAX_GREP_FILE_BYTES = 2 * 1024 * 1024
/** 一次遍历扫描的最大文件数。 */
const MAX_SCAN_FILES = 20000

/** 省略号标记，和 DSH 自带的 head/tail 截断保持同一种视觉。 */
export const ELISION = '\n…（中间省略 {removed} 字符）…\n'

/**
 * 把过长的文本按头尾保留截断。
 * @param {string} text 原文。
 * @param {number} maxChars 上限（字符）。
 * @returns {{ text: string, truncated: boolean, removed: number }} 截断结果。
 */
export function truncateMiddle(text, maxChars) {
  const source = String(text ?? '')
  const limit = Math.max(0, Number(maxChars) || 0)
  if (limit === 0 || source.length <= limit) return { text: source, truncated: false, removed: 0 }
  const head = Math.ceil(limit * 0.62)
  const tail = Math.max(0, limit - head)
  const removed = source.length - head - tail
  return {
    text: source.slice(0, head) + ELISION.replace('{removed}', String(removed)) + (tail > 0 ? source.slice(source.length - tail) : ''),
    truncated: true,
    removed,
  }
}

/**
 * 把相对路径解析到工作目录内，越界直接报错。
 * @param {string} input 用户给的路径。
 * @param {string} cwd 会话工作目录。
 * @param {boolean} allowOutside 是否允许越界。
 * @returns {string} 绝对路径。
 */
export function resolveInside(input, cwd, allowOutside) {
  const base = resolve(cwd)
  const target = isAbsolute(input) ? resolve(input) : resolve(base, input)
  if (!allowOutside) {
    const rel = relative(base, target)
    const outside = rel.startsWith('..') || (rel !== '' && rel.split(sep)[0] === '..') || isAbsolute(rel)
    if (outside) {
      throw new Error(`路径在工作目录之外：${target}（工作目录 ${base}；确需访问请设置 ops.allowOutside）`)
    }
  }
  return target
}

/**
 * 按行号渲染文本，附带行号便于后续 edit 定位。
 * @param {string[]} lines 行数组。
 * @param {number} startLine 起始行号（1 基）。
 * @returns {string} 带行号的文本。
 */
function numbered(lines, startLine) {
  return lines.map((line, index) => `${String(startLine + index).padStart(4, ' ')}| ${line}`).join('\n')
}

/**
 * 递归遍历文件。
 * @param {string} root 根目录。
 * @param {(file: string) => boolean} want 是否收集该文件。
 * @param {number} maxFiles 最大收集数。
 * @returns {Promise<string[]>} 文件绝对路径列表。
 */
async function walkFiles(root, want, maxFiles) {
  const found = []
  const queue = [root]
  let scanned = 0
  while (queue.length > 0 && found.length < maxFiles && scanned < MAX_SCAN_FILES) {
    const dir = queue.shift()
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      scanned += 1
      if (scanned >= MAX_SCAN_FILES) break
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) queue.push(join(dir, entry.name))
      } else if (entry.isFile() && want(join(dir, entry.name))) {
        found.push(join(dir, entry.name))
        if (found.length >= maxFiles) break
      }
    }
  }
  return found
}

/**
 * 把 glob 模式转成正则（只支持 * ? ** 与字面量，够用且不引依赖）。
 * @param {string} pattern glob 模式。
 * @returns {RegExp} 正则。
 */
export function globToRegExp(pattern) {
  const source = String(pattern ?? '').replaceAll('\\', '/')
  let out = '^'
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i]
    if (char === '*') {
      if (source[i + 1] === '*') {
        out += '.*'
        i += 1
        if (source[i + 1] === '/') i += 1
      } else {
        out += '[^/]*'
      }
    } else if (char === '?') {
      out += '[^/]'
    } else if ('\\^$+.()|{}[]'.includes(char)) {
      out += `\\${char}`
    } else {
      out += char
    }
  }
  return new RegExp(`${out}$`)
}

/**
 * 执行一个操作。
 * @param {object} call 操作参数，带 op 字段。
 * @param {{ cwd: string, writes: boolean, allowOutside: boolean, maxChars: number }} options 运行选项。
 * @returns {Promise<{ header: string, text: string, tokens: number }>} 渲染好的结果块。
 */
async function runOne(call, options) {
  const op = String(call?.op ?? '').trim()
  const maxChars = Math.min(Number(call?.maxChars) || options.maxChars, options.maxChars)
  const at = (path) => resolveInside(String(path ?? '.'), options.cwd, options.allowOutside)

  switch (op) {
    case 'read': {
      const file = at(call.path ?? call.file)
      const raw = await readFile(file, 'utf8')
      const lines = raw.split(/\r?\n/)
      const offset = Math.max(1, Number(call.offset) || 1)
      const limit = Math.max(1, Number(call.limit) || lines.length)
      const slice = lines.slice(offset - 1, offset - 1 + limit)
      const body = numbered(slice, offset)
      const clipped = truncateMiddle(body, maxChars)
      return {
        header: `read ${relative(resolve(options.cwd), file) || file}  ${slice.length} 行${clipped.truncated ? '（已截断）' : ''}`,
        text: clipped.text,
        tokens: estimateTextTokens(clipped.text),
      }
    }
    case 'stat': {
      const info = await fsStat(at(call.path))
      return {
        header: `stat ${call.path}`,
        text: JSON.stringify({ size: info.size, mtime: info.mtime.toISOString(), isDirectory: info.isDirectory(), isFile: info.isFile() }),
        tokens: 0,
      }
    }
    case 'list': {
      const dir = at(call.path ?? '.')
      const entries = await readdir(dir, { withFileTypes: true })
      const rows = entries
        .filter((entry) => call.all === true || !entry.name.startsWith('.'))
        .map((entry) => `${entry.isDirectory() ? 'd' : '-'} ${entry.name}`)
        .sort()
      const clipped = truncateMiddle(rows.join('\n'), maxChars)
      return { header: `list ${call.path ?? '.'}  ${rows.length} 项${clipped.truncated ? '（已截断）' : ''}`, text: clipped.text, tokens: estimateTextTokens(clipped.text) }
    }
    case 'glob': {
      const root = at(call.path ?? '.')
      const matcher = globToRegExp(call.pattern ?? '*')
      const files = await walkFiles(root, (file) => matcher.test(relative(root, file).replaceAll('\\', '/')), Math.max(1, Number(call.maxResults) || 200))
      const body = files.map((file) => relative(resolve(options.cwd), file)).sort().join('\n')
      const clipped = truncateMiddle(body, maxChars)
      return { header: `glob ${call.pattern}  ${files.length} 个文件`, text: clipped.text, tokens: estimateTextTokens(clipped.text) }
    }
    case 'grep': {
      const root = at(call.path ?? '.')
      const flags = call.ignoreCase === true ? 'i' : ''
      let pattern
      try {
        pattern = new RegExp(String(call.pattern ?? ''), flags)
      } catch (error) {
        throw new Error(`grep 正则无效：${error instanceof Error ? error.message : String(error)}`)
      }
      const includeMatcher = call.include === undefined ? undefined : globToRegExp(call.include)
      const limit = Math.max(1, Number(call.maxMatches) || 80)
      const hits = []
      const files = await walkFiles(root, (file) => includeMatcher === undefined || includeMatcher.test(relative(root, file).replaceAll('\\', '/')), MAX_SCAN_FILES)
      let scanned = 0
      for (const file of files) {
        if (hits.length >= limit) break
        let info
        try {
          info = await fsStat(file)
        } catch {
          continue
        }
        if (info.size > MAX_GREP_FILE_BYTES) continue
        let text
        try {
          text = await readFile(file, 'utf8')
        } catch {
          continue
        }
        if (text.includes('\u0000')) continue
        scanned += 1
        const lines = text.split(/\r?\n/)
        for (let index = 0; index < lines.length && hits.length < limit; index += 1) {
          if (pattern.test(lines[index])) {
            hits.push(`${relative(resolve(options.cwd), file).replaceAll('\\', '/')}:${index + 1}: ${lines[index].trim().slice(0, 240)}`)
          }
        }
      }
      const body = hits.join('\n')
      const clipped = truncateMiddle(body, maxChars)
      return { header: `grep /${call.pattern}/  ${hits.length} 处命中（扫了 ${scanned} 个文件）`, text: clipped.text, tokens: estimateTextTokens(clipped.text) }
    }
    case 'write': {
      if (!options.writes) throw new Error('ops.writes 未开启：写操作请用宿主自带的 write 工具，或在配置里开启 ops.writes')
      const file = at(call.path ?? call.file)
      if (call.mkdir === true) await mkdir(dirname(file), { recursive: true })
      await writeFile(file, String(call.content ?? ''), 'utf8')
      const bytes = Buffer.byteLength(String(call.content ?? ''), 'utf8')
      return { header: `write ${call.path}`, text: `已写入 ${bytes} 字节`, tokens: 0 }
    }
    case 'edit': {
      if (!options.writes) throw new Error('ops.writes 未开启：编辑操作请用宿主自带的 edit 工具，或在配置里开启 ops.writes')
      const file = at(call.path ?? call.file)
      const before = await readFile(file, 'utf8')
      const find = String(call.find ?? '')
      const replacement = String(call.replace ?? '')
      if (find.length === 0) throw new Error('edit 需要 find 参数')
      const occurrences = before.split(find).length - 1
      if (occurrences === 0) throw new Error(`edit 没找到目标文本（${find.slice(0, 60)}）`)
      if (call.all !== true && occurrences > 1) throw new Error(`edit 命中 ${occurrences} 处，请加 all:true 或用更长的 find`)
      const after = call.all === true ? before.split(find).join(replacement) : before.replace(find, replacement)
      await writeFile(file, after, 'utf8')
      return { header: `edit ${call.path}`, text: `替换 ${call.all === true ? occurrences : 1} 处`, tokens: 0 }
    }
    case 'mkdir': {
      if (!options.writes) throw new Error('ops.writes 未开启：目录操作请用宿主自带工具，或在配置里开启 ops.writes')
      await mkdir(at(call.path), { recursive: true })
      return { header: `mkdir ${call.path}`, text: 'ok', tokens: 0 }
    }
    default:
      throw new Error(`未知 op "${op}"（支持 read / stat / list / glob / grep / write / edit / mkdir）`)
  }
}

/**
 * 在一个请求里执行一批操作，任何一个失败都不影响其它操作。
 * @param {Array<object>} calls 操作数组。
 * @param {{ cwd: string, writes?: boolean, allowOutside?: boolean, maxChars?: number }} options 运行选项。
 * @returns {Promise<{ blocks: Array<{ ok: boolean, header: string, text: string, tokens: number }>, tokens: number, chars: number }>} 结果。
 */
export async function runBatch(calls, options) {
  const resolved = {
    cwd: options.cwd,
    writes: options.writes === true,
    allowOutside: options.allowOutside === true,
    maxChars: Math.max(500, Number(options.maxChars) || 20000),
  }
  const blocks = []
  let tokens = 0
  let chars = 0
  for (const call of Array.isArray(calls) ? calls : []) {
    try {
      const block = await runOne(call, resolved)
      blocks.push({ ok: true, ...block })
      tokens += block.tokens
      chars += block.text.length
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      blocks.push({ ok: false, header: `${call?.op ?? '?'} ${call?.path ?? ''}`.trim(), text: `✗ ${message}`, tokens: 0 })
      chars += message.length
    }
  }
  return { blocks, tokens, chars }
}

/**
 * 把批量结果渲染成一段紧凑文本（给模型看的）。
 * @param {{ blocks: Array<{ ok: boolean, header: string, text: string, tokens: number }>, tokens: number }} result runBatch 的返回值。
 * @returns {string} 渲染文本。
 */
export function renderBatch(result) {
  const parts = []
  for (const block of result.blocks) {
    parts.push(`## ${block.header}${block.ok ? '' : '  [失败]'}\n${block.text}`)
  }
  if (parts.length === 0) return '（没有操作）'
  return parts.join('\n\n')
}
