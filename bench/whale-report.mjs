#!/usr/bin/env node
/**
 * 养鱼场景专项报告：QQ / B 站机器人跑出来的会话，到底把 token 花在哪。
 *
 * 和 analyze-sessions 的区别：那个看"工具面占多少"，这个看"聊天型 agent 的账本"——
 * 用户消息多大、跨轮重复多少、工具调用频率、工具结果复利有多大。
 *
 * 用法：
 *   node bench/whale-report.mjs                     # 默认匹配路径里带 whale 的会话
 *   node bench/whale-report.mjs --match whale --json bench/out/whale.json
 *   node bench/whale-report.mjs --all               # 不筛，全量
 *
 * @module dsh-fish-economy/bench/whale-report
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import zlib from 'node:zlib'
import { estimateTextTokens, estimateToolSchemas, formatTokens } from '../src/token.js'
import { groupSchemas } from '../src/groups.js'
import { apply } from '../index.js'
import { createFakeCtx } from '../tests/fake-ctx.mjs'

/**
 * 解析参数。
 * @param {string[]} argv 参数。
 * @returns {{ match: string, all: boolean, json: string, home: string, trimBudget: number }} 选项。
 */
function parseArgs(argv) {
  const out = { match: 'whale', exclude: '', all: false, json: '', home: join(homedir(), '.dsh'), trimBudget: 3000, start: 'fs,shell' }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--match') out.match = argv[++i]
    else if (arg === '--exclude') out.exclude = argv[++i]
    else if (arg === '--start') out.start = argv[++i]
    else if (arg === '--json') out.json = argv[++i]
    else if (arg === '--home') out.home = argv[++i]
    else if (arg === '--trim') out.trimBudget = Number(argv[++i]) || 3000
    else if (arg === '--all') out.all = true
  }
  return out
}

/**
 * 找会话文件。
 * @param {string} root 会话根目录。
 * @returns {Array<{ file: string, size: number, workspace: string }>} 文件列表。
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
      else if (entry.name.startsWith('session.v4.jsonl')) out.push({ file: full, size: statSync(full).size, workspace: basename(dirname(dir)) })
    }
  }
  walk(root, 0)
  return out
}

/**
 * 读一个会话的所有事件。
 * @param {string} file 文件。
 * @returns {Array<object>} 事件。
 */
function load(file) {
  const raw = zlib.zstdDecompressSync(readFileSync(file)).toString('utf8')
  const events = []
  for (const line of raw.split('\n')) {
    if (line.length === 0) continue
    try {
      events.push(JSON.parse(line))
    } catch {
      // 忽略坏行
    }
  }
  return events
}

/**
 * 取一条事件的纯文本。
 *
 * 三种事件形状都要吃：
 *   - user/message:   data.content = [blocks]
 *   - assistant/message / tool/result: data.message.content = [blocks]
 * @param {object} event 事件。
 * @returns {string} 文本。
 */
function textOf(event) {
  const data = event?.data ?? {}
  const content = data.content ?? data.message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter((block) => block?.type === 'text').map((block) => block.text).join('\n')
}

/**
 * 统计一个会话。
 * @param {string} file 文件。
 * @param {number} trimBudget 入口裁剪阈值（字符）。
 * @returns {object|null} 统计。
 */
function analyze(file, trimBudget) {
  const events = load(file)
  let header = null
  let systemText = ''
  let requests = 0
  let input = 0
  let output = 0
  let cacheRead = 0
  let cacheWrite = 0
  let turns = 0
  const toolCalls = new Map()
  let toolCallCount = 0
  let toolResultRawChars = 0
  let toolResultTrimChars = 0
  let toolResultCompounded = 0
  const userTexts = new Map()
  let userMessages = 0
  let userChars = 0
  let userRepeatedRoots = 0
  let userRepeatedChars = 0

  for (const event of events) {
    if (event.type === 'request/header') header = event.data?.header ?? header
    else if (event.type === 'system/message') systemText = textOf(event)
    else if (event.type === 'assistant/message') {
      const usage = event.data?.usage
      if (usage !== undefined) {
        requests += 1
        input += usage.inputTokens ?? 0
        output += usage.outputTokens ?? 0
        cacheRead += usage.cacheReadTokens ?? 0
        cacheWrite += usage.cacheWriteTokens ?? 0
      }
    } else if (event.type === 'turn/start') turns += 1
    else if (event.type === 'user/message') {
      const text = textOf(event)
      if (text.length === 0) continue
      userMessages += 1
      userChars += text.length
      // 用前 160 字符当"同一段开场白"的指纹：养鱼每次唤醒都会重发人设/规则。
      const key = `${text.length}:${text.slice(0, 160)}`
      if (userTexts.has(key)) {
        userRepeatedRoots += 1
        userRepeatedChars += text.length
      } else {
        userTexts.set(key, text.length)
      }
    } else if (event.type === 'tool/call') {
      // 事件形状：{ data: { turn, step, callId, name, arguments } }
      const name = event.data?.name ?? event.data?.message?.content?.find?.((block) => block?.type === 'tool-call')?.name
      if (typeof name === 'string') {
        toolCallCount += 1
        toolCalls.set(name, (toolCalls.get(name) ?? 0) + 1)
      }
    } else if (event.type === 'tool/result') {
      const chars = textOf(event).length
      toolResultRawChars += chars
      const excess = Math.max(0, chars - trimBudget)
      if (excess > 0) {
        toolResultTrimChars += excess
        toolResultCompounded += excess * Math.max(1, requests - 1)
      }
    }
  }
  if (requests === 0 && header === null) return null
  const tools = header?.tools ?? []
  const schema = estimateToolSchemas(tools)
  const costOf = (toolSchema) => estimateToolSchemas([toolSchema]).total
  const groups = new Map(groupSchemas(tools, { cost: costOf }).map((group) => [group.id, group.tokens]))
  return {
    file,
    requests,
    turns,
    tools: tools.length,
    toolsTokens: schema.total,
    groups: Object.fromEntries(groups),
    systemTokens: estimateTextTokens(systemText),
    usage: { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite },
    cacheHitRate: (cacheRead + cacheWrite) / Math.max(1, input + cacheRead + cacheWrite),
    toolCallCount,
    toolCallsPerRequest: requests === 0 ? 0 : toolCallCount / requests,
    topTools: [...toolCalls.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8),
    toolResultRawChars,
    toolResultTrimChars,
    toolResultCompoundedTokens: Math.round(toolResultCompounded / 3.2),
    userMessages,
    userAvgChars: userMessages === 0 ? 0 : userChars / userMessages,
    userRepeatedMessages: userRepeatedRoots,
    userRepeatedChars,
  }
}

/** 主流程。 */
function main() {
  const args = parseArgs(process.argv.slice(2))
  const master = createFakeCtx()
  apply(master.ctx, {})
  const metaTokens = estimateToolSchemas(master.ctx.tools.schemas()).total

  const all = findSessions(join(args.home, 'sessions'))
  const picked = all.filter((session) => {
    if (args.exclude !== '' && session.file.toLowerCase().includes(args.exclude.toLowerCase())) return false
    if (args.all) return true
    return session.file.toLowerCase().includes(args.match.toLowerCase())
  })
  const rows = []
  for (const session of picked) {
    try {
      const stats = analyze(session.file, args.trimBudget)
      if (stats !== null) rows.push({ ...stats, workspace: session.workspace })
    } catch (error) {
      console.error('跳过', session.file, error instanceof Error ? error.message : error)
    }
  }
  if (rows.length === 0) {
    console.log(`没找到匹配 ${args.all ? '(全量)' : args.match} 的会话。`)
    return
  }
  rows.sort((a, b) => b.usage.total - a.usage.total)

  const sum = rows.reduce((acc, row) => ({
    requests: acc.requests + row.requests,
    turns: acc.turns + row.turns,
    total: acc.total + row.usage.total,
    input: acc.input + row.usage.input,
    output: acc.output + row.usage.output,
    cacheRead: acc.cacheRead + row.usage.cacheRead,
    toolsTokens: acc.toolsTokens + row.toolsTokens,
    toolCalls: acc.toolCalls + row.toolCallCount,
    toolResultRaw: acc.toolResultRaw + row.toolResultRawChars,
    toolResultTrim: acc.toolResultTrim + row.toolResultTrimChars,
    trimTokens: acc.trimTokens + row.toolResultCompoundedTokens,
    userMessages: acc.userMessages + row.userMessages,
    userChars: acc.userChars + row.userAvgChars * row.userMessages,
    userRepeated: acc.userRepeated + row.userRepeatedChars,
  }), {
    requests: 0, turns: 0, total: 0, input: 0, output: 0, cacheRead: 0, toolsTokens: 0,
    toolCalls: 0, toolResultRaw: 0, toolResultTrim: 0, trimTokens: 0, userMessages: 0, userChars: 0, userRepeated: 0,
  })

  const gateSaved = Math.max(0, sum.toolsTokens / rows.length - metaTokens) * sum.requests

  // 场景 B：fish.preset=work —— 预唤醒 fs + shell，其余组休眠。
  const perSessionGroups = rows.map((row) => row.groups ?? {})
  const groupAvg = {}
  for (const groups of perSessionGroups) {
    for (const [id, tokens] of Object.entries(groups)) groupAvg[id] = (groupAvg[id] ?? 0) + tokens / rows.length
  }
  const keepGroups = new Set(args.start.split(',').map((id) => id.trim()).filter(Boolean))
  const hiddenTokens = Object.entries(groupAvg)
    .filter(([id]) => !keepGroups.has(id) && id !== 'meta')
    .reduce((total, [, tokens]) => total + tokens, 0)
  const workSavedPerRequest = Math.max(0, hiddenTokens - metaTokens)
  const workSaved = workSavedPerRequest * sum.requests
  // 断链：每个会话唤醒一次分组（聊天场景可能只有第一次发言时唤醒，取 1）
  const breakCost = rows.reduce((acc, row) => acc + (row.requests >= 3 ? row.usage.total / row.requests : 0), 0)
  const net = gateSaved + sum.trimTokens - breakCost
  const billable = sum.input + sum.output + 0.1 * sum.cacheRead
  const netBillable = (gateSaved + sum.trimTokens) * 0.1 - breakCost

  const lines = []
  lines.push(`匹配会话：${rows.length} 个（workspace: ${[...new Set(rows.map((row) => row.workspace))].join(', ')}）`)
  lines.push(`轮次 ${sum.turns} · 请求 ${sum.requests} · 总 token ${formatTokens(sum.total)}`)
  lines.push('')
  lines.push('== 每次请求都在为什么付钱 ==')
  lines.push(`  工具面           ${formatTokens(sum.toolsTokens / rows.length)} token（${rows[0].tools} 个工具）`)
  lines.push(`  系统提示         ${formatTokens(rows.reduce((n, r) => n + r.systemTokens, 0) / rows.length)} token`)
  lines.push(`  平均单请求       ${formatTokens(sum.total / Math.max(1, sum.requests))} token（缓存命中 ${(sum.cacheRead / Math.max(1, sum.cacheRead + sum.input) * 100).toFixed(1)}%）`)
  lines.push('')
  lines.push('== 聊天型 agent 的行为特征 ==')
  lines.push(`  工具调用         ${sum.toolCalls} 次 / ${sum.requests} 请求 = ${(sum.toolCalls / Math.max(1, sum.requests)).toFixed(3)} 次/请求`)
  lines.push(`  工具结果         ${(sum.toolResultRaw / 1e6).toFixed(2)}M 字符，超 ${args.trimBudget} 字的部分 ${(sum.toolResultTrim / 1e6).toFixed(2)}M`)
  lines.push(`  用户消息         ${sum.userMessages} 条，平均 ${Math.round(sum.userChars / Math.max(1, sum.userMessages))} 字符`)
  lines.push(`  跨轮重复消息     ${(sum.userRepeated / Math.max(1, sum.userChars) * 100).toFixed(1)}% 的字符是"上一次发过的同一段"（插件层折叠不到，见下）`)
  lines.push('')
  lines.push('== 挂上鱼缸经济学之后的账 ==')
  lines.push(`  meta 工具面      ${metaTokens} token/请求`)
  lines.push(`  场景 chat（工具面归零）`)
  lines.push(`    闸门省       ${formatTokens(gateSaved)}（${formatTokens(Math.max(0, sum.toolsTokens / rows.length - metaTokens))}/请求）`)
  lines.push(`    断链代价     ${formatTokens(breakCost)}`)
  lines.push(`    入口裁剪复利 ${formatTokens(sum.trimTokens)}`)
  lines.push(`    净省         ${formatTokens(gateSaved + sum.trimTokens - breakCost)} = ${(((gateSaved + sum.trimTokens - breakCost) / Math.max(1, sum.total)) * 100).toFixed(1)}%`)
  lines.push(`  场景 work（预唤醒 fs + shell，推荐）`)
  lines.push(`    闸门省       ${formatTokens(workSaved)}（${formatTokens(workSavedPerRequest)}/请求，休眠 ${Object.keys(groupAvg).filter((id) => !keepGroups.has(id) && id !== 'meta').join('/')}）`)
  lines.push(`    断链代价     0（一开始就是最终名单）`)
  lines.push(`    入口裁剪复利 ${formatTokens(sum.trimTokens)}`)
  lines.push(`    净省         ${formatTokens(workSaved + sum.trimTokens)} = ${(((workSaved + sum.trimTokens) / Math.max(1, sum.total)) * 100).toFixed(1)}%（计费口径 ${(((workSaved + sum.trimTokens) * 0.1 / Math.max(1, billable)) * 100).toFixed(1)}%）`)
  lines.push(`  真实用量基线    ${formatTokens(sum.total)} token（计费口径 ${formatTokens(billable)}）`)

  console.log(lines.join('\n'))
  if (args.json !== '') {
    writeFileSync(args.json, `${JSON.stringify({ filtered: rows.length, metaTokens, sum, gateSaved, breakCost, net, billable, netBillable, rows }, null, 2)}\n`)
    console.log(`\n已写入 ${args.json}`)
  }
}

main()
