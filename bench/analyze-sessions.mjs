#!/usr/bin/env node
/**
 * 拿真实会话账本给"省 token"算账。
 *
 * 数据来源：$DSH_HOME/sessions/<workspace>/<session>/session.v4.jsonl.zstd
 * 里面存着每次请求真实发出的 `request/header`（含全部工具 schema）、一次
 * `system/message`（系统提示正文），以及每条 assistant 消息的 `usage`
 * （inputTokens / outputTokens / cacheReadTokens）。
 *
 * 于是"工具定义到底吃了多少 token"不需要猜：把 header.tools 序列化后按
 * 估算器计价，再和真实 usage 对齐即可。
 *
 * 用法：
 *   node bench/analyze-sessions.mjs [--home ~/.dsh] [--limit 20] [--json out.json] [--calibrate]
 *   node bench/analyze-sessions.mjs --self-test      # 不读真实数据，跑内置样例
 *
 * @module dsh-fish-economy/bench/analyze-sessions
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import zlib from 'node:zlib'
import { estimateTextTokens, estimateToolSchemas, formatTokens } from '../src/token.js'
import { groupSchemas } from '../src/groups.js'

/** 读取命令行参数。 */
function parseArgs(argv) {
  const args = { home: join(homedir(), '.dsh'), limit: 0, json: '', calibrate: false, selfTest: false, exclude: '' }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--home') args.home = argv[++i]
    else if (arg === '--limit') args.limit = Number(argv[++i]) || 0
    else if (arg === '--json') args.json = argv[++i]
    else if (arg === '--exclude') args.exclude = argv[++i]
    else if (arg === '--calibrate') args.calibrate = true
    else if (arg === '--self-test') args.selfTest = true
  }
  return args
}

/**
 * 递归找 session.v4.jsonl.zstd。
 * @param {string} root 根目录。
 * @returns {Array<{ file: string, size: number }>} 文件列表。
 */
function findSessions(root) {
  const out = []
  const walk = (dir, depth) => {
    if (depth > 4) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full, depth + 1)
      else if (entry.name === 'session.v4.jsonl.zstd') out.push({ file: full, size: statSync(full).size })
    }
  }
  walk(root, 0)
  return out
}

/**
 * 解压并解析一个会话。
 * @param {string} file 会话文件。
 * @returns {{ events: Array<object> }} 解析结果。
 */
function loadSession(file) {
  const raw = zlib.zstdDecompressSync(readFileSync(file)).toString('utf8')
  const events = []
  for (const line of raw.split('\n')) {
    if (line.length === 0) continue
    try {
      events.push(JSON.parse(line))
    } catch {
      // 损坏的一行不影响整体统计
    }
  }
  return { events }
}

/**
 * 统计一个会话的账本。
 * @param {string} file 会话文件。
 * @returns {object|null} 统计结果。
 */
export function analyzeSession(file) {
  const { events } = loadSession(file)
  let header = null
  let systemText = ''
  let requests = 0
  let input = 0
  let output = 0
  let cacheRead = 0
  let cacheWrite = 0
  const toolResultChars = []
  const toolCallNames = new Map()
  let turns = 0
  // 入口裁剪的"复利"：第 k 次请求里被裁掉的字符，会被后面 (总请求数-k) 次请求重复带上。
  let trimCompoundedChars = 0
  let trimRawChars = 0
  let prunedEvents = 0
  for (const event of events) {
    if (event.type === 'request/header') header = event.data?.header ?? header
    else if (event.type === 'system/message') {
      const content = event.data?.message?.content ?? []
      systemText = content.map((block) => (block?.type === 'text' ? block.text : '')).join('')
    } else if (event.type === 'assistant/message') {
      const usage = event.data?.usage
      if (usage !== undefined) {
        requests += 1
        input += usage.inputTokens ?? 0
        output += usage.outputTokens ?? 0
        cacheRead += usage.cacheReadTokens ?? 0
        cacheWrite += usage.cacheWriteTokens ?? 0
      }
    } else if (event.type === 'tool/result') {
      const content = event.data?.message?.content ?? []
      let chars = 0
      for (const block of content) if (block?.type === 'text') chars += block.text.length
      toolResultChars.push(chars)
      const excess = Math.max(0, chars - 3000)
      if (excess > 0) {
        trimRawChars += excess
        prunedEvents += 1
        trimCompoundedChars += excess * Math.max(1, requests - 1)
      }
    } else if (event.type === 'tool/call') {
      const name = event.data?.message?.content?.find?.((block) => block?.type === 'tool-call')?.name
      if (typeof name === 'string') toolCallNames.set(name, (toolCallNames.get(name) ?? 0) + 1)
    } else if (event.type === 'turn/start') turns += 1
  }
  if (requests === 0 && header === null) return null
  const tools = header?.tools ?? []
  const schemaCost = estimateToolSchemas(tools)
  const groupView = groupSchemas(tools, { cost: (schema) => schemaCost.byTool.find((item) => item.name === schema.name)?.tokens ?? 0 })
  const systemTokens = estimateTextTokens(systemText)
  const metaNames = new Set(['tool_list', 'tool_enable', 'tool_disable', 'fish_report'])
  const metaTokens = schemaCost.byTool.filter((item) => metaNames.has(item.name)).reduce((sum, item) => sum + item.tokens, 0)
  const gateSavedPerRequest = Math.max(0, schemaCost.total - metaTokens)
  const totalTokens = input + output + cacheRead + cacheWrite
  return {
    file,
    turns,
    requests,
    tools: tools.length,
    toolsTokens: schemaCost.total,
    metaTokens,
    gateSavedPerRequest,
    gateSavedTotal: gateSavedPerRequest * requests,
    systemTokens,
    systemChars: systemText.length,
    groups: groupView.map((group) => ({ id: group.id, tools: group.tools.length, tokens: group.tokens })),
    topTools: schemaCost.byTool.slice(0, 8),
    usage: { input, output, cacheRead, cacheWrite, total: totalTokens },
    cacheHitRate: totalTokens === 0 ? 0 : (cacheRead + cacheWrite) / Math.max(1, input + cacheRead + cacheWrite),
    toolResults: {
      count: toolResultChars.length,
      totalChars: toolResultChars.reduce((sum, chars) => sum + chars, 0),
      over2k: toolResultChars.filter((chars) => chars > 2000).length,
      maxChars: toolResultChars.reduce((max, chars) => Math.max(max, chars), 0),
    },
    trim: {
      prunedEvents,
      rawChars: trimRawChars,
      compoundedChars: trimCompoundedChars,
      compoundedTokens: Math.round(trimCompoundedChars / 3.2),
    },
    toolCalls: [...toolCallNames.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10),
  }
}

/**
 * 用真实 usage 反推 ASCII 密度，用来校准估算器。
 * @param {string} file 会话文件。
 * @returns {{ density: number, actual: number, estimated: number }|null} 校准样本。
 */
export function calibrate(file) {
  const { events } = loadSession(file)
  let header = null
  let systemText = ''
  let first = null
  for (const event of events) {
    if (event.type === 'request/header') header = event.data?.header ?? header
    else if (event.type === 'system/message') {
      systemText = (event.data?.message?.content ?? []).map((block) => (block?.type === 'text' ? block.text : '')).join('')
    } else if (event.type === 'assistant/message' && first === null) {
      first = event.data?.usage ?? null
    }
    if (header !== null && first !== null && systemText !== '') break
  }
  if (header === null || first === null) return null
  const actual = (first.inputTokens ?? 0) + (first.cacheReadTokens ?? 0)
  if (actual <= 0) return null
  const json = JSON.stringify(header.tools ?? [])
  const asciiChars = (json + systemText).replace(/[^\x00-\x7F]/g, '').length
  const cjkChars = Array.from(json + systemText).filter((char) => char.codePointAt(0) > 127).length
  const overhead = 64
  const density = asciiChars / Math.max(1, actual - cjkChars * 1.0 - overhead)
  return { density, actual, estimated: estimateTextTokens(json) + estimateTextTokens(systemText) }
}

/** 打印一行表格。 */
function row(cells, widths) {
  return cells.map((cell, index) => String(cell).padEnd(widths[index])).join('  ')
}

/** 主流程：自测或真实会话统计。 */
function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.selfTest) {
    const sample = {
      tools: [
        { name: 'read', description: 'Read a file from disk.', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
        { name: 'pwsh', description: 'Run PowerShell.', parameters: { type: 'object', properties: { command: { type: 'string' } } } },
        { name: 'tool_list', description: 'List tool groups.', parameters: { type: 'object', properties: {} } },
      ],
    }
    const cost = estimateToolSchemas(sample.tools)
    console.log('自测：样例工具成本 =', formatTokens(cost.total), 'token')
    console.log('自测：估算密度 =', cost.byTool.map((item) => `${item.name}:${item.tokens}`).join(', '))
    return
  }

  const sessions = findSessions(join(args.home, 'sessions'))
    .filter((session) => args.exclude === '' || !session.file.toLowerCase().includes(args.exclude.toLowerCase()))
    .sort((a, b) => b.size - a.size)
  const picked = args.limit > 0 ? sessions.slice(0, args.limit) : sessions
  const rows = []
  for (const session of picked) {
    try {
      const stats = analyzeSession(session.file)
      if (stats !== null) rows.push(stats)
    } catch (error) {
      console.error('跳过', session.file, error instanceof Error ? error.message : error)
    }
  }
  if (rows.length === 0) {
    console.log('没找到可读的会话。用 --home 指定 DSH_HOME。')
    return
  }

  rows.sort((a, b) => b.usage.total - a.usage.total)
  const widths = [30, 6, 8, 9, 10, 11, 12, 12]
  console.log(row(['会话', '请求', '工具数', '工具token', '系统提示tk', '总token', '缓存命中率', '闸门可省'], widths))
  for (const stats of rows) {
    const name = stats.file.split(/[\\/]/).slice(-2, -1)[0] ?? stats.file
    console.log(row([
      name.slice(0, 29),
      stats.requests,
      stats.tools,
      formatTokens(stats.toolsTokens),
      formatTokens(stats.systemTokens),
      formatTokens(stats.usage.total),
      `${(stats.cacheHitRate * 100).toFixed(1)}%`,
      formatTokens(stats.gateSavedTotal),
    ], widths))
  }

  const sum = rows.reduce((acc, stats) => ({
    requests: acc.requests + stats.requests,
    toolsTokens: acc.toolsTokens + stats.toolsTokens,
    gateSaved: acc.gateSaved + stats.gateSavedTotal,
    total: acc.total + stats.usage.total,
    output: acc.output + stats.usage.output,
    toolResultChars: acc.toolResultChars + stats.toolResults.totalChars,
  }), { requests: 0, toolsTokens: 0, gateSaved: 0, total: 0, output: 0, toolResultChars: 0 })

  console.log('\n== 汇总 ==')
  console.log(`会话数            ${rows.length}`)
  console.log(`请求数            ${sum.requests}`)
  console.log(`平均工具定义      ${formatTokens(rows.reduce((n, s) => n + s.toolsTokens, 0) / rows.length)} token/请求`)
  console.log(`真实总 token      ${formatTokens(sum.total)}（其中输出 ${formatTokens(sum.output)}）`)
  console.log(`闸门全开可省      ${formatTokens(sum.gateSaved)} token（占总量 ${(sum.gateSaved / Math.max(1, sum.total) * 100).toFixed(1)}%，仅工具 schema 一项）`)
  console.log(`工具结果总字符    ${formatTokens(sum.toolResultChars)}`)

  const groupTotals = new Map()
  for (const stats of rows) for (const group of stats.groups) groupTotals.set(group.id, (groupTotals.get(group.id) ?? 0) + group.tokens)
  console.log('\n== 工具定义按组拆分（单个会话平均）==')
  for (const [id, tokens] of [...groupTotals.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${id.padEnd(10)} ${formatTokens(tokens / rows.length).padStart(8)} token`)
  }

  const top = new Map()
  for (const stats of rows) for (const item of stats.topTools) top.set(item.name, Math.max(top.get(item.name) ?? 0, item.tokens))
  console.log('\n== 最贵的单个工具 ==')
  for (const [name, tokens] of [...top.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    console.log(`  ${name.padEnd(24)} ${String(tokens).padStart(6)} token`)
  }

  if (args.calibrate) {
    const samples = picked.map((session) => calibrate(session.file)).filter((item) => item !== null)
    samples.sort((a, b) => a.density - b.density)
    if (samples.length > 0) {
      const median = samples[Math.floor(samples.length / 2)].density
      console.log(`\n== 校准 ==\n样本 ${samples.length} 个，ASCII 密度中位数 ${median.toFixed(2)} 字符/token`)
    }
  }

  if (args.json !== '') {
    writeFileSync(args.json, JSON.stringify({ rows, sum }, null, 2))
    console.log(`\n明细已写入 ${args.json}`)
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main()
