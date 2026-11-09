#!/usr/bin/env node
/**
 * 场景模拟：拿真实会话账本，算"如果当时挂着鱼缸经济学"会是什么样。
 *
 * 三个场景：
 *   A 现状           —— 工具定义每次都全量下发。
 *   B 只开闸门       —— 默认只发 meta 工具，其余按需唤醒。唤醒会让工具集合变化，
 *                       DeepSeek 的缓存前缀随之失效一次（这就是"断链代价"）。
 *   C 闸门 + 入口裁剪 —— 在 B 之上把超长工具结果在进历史前掐掉，收益按"后面还有几次
 *                       请求"复利累加（analyze-sessions 已按事件位置算好）。
 *
 * 全部数字来自 $DSH_HOME/sessions 里真实的 request/header 与 usage，不是拍脑袋；
 * 假设只有两条，都写在输出末尾，方便对着视频讲清楚。
 *
 * 用法：node bench/simulate.mjs [--json bench/out/simulate.json] [--cache 0.1]
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { estimateToolSchemas, formatTokens } from '../src/token.js'
import { apply } from '../index.js'
import { createFakeCtx } from '../tests/fake-ctx.mjs'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * 读命令行参数。
 * @param {string[]} argv 参数。
 * @returns {{ json: string, cache: number, file: string }} 选项。
 */
function parseArgs(argv) {
  const args = { json: '', cache: 0.1, file: join(here, 'out/real-sessions.json') }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--json') args.json = argv[++i]
    else if (argv[i] === '--cache') args.cache = Number(argv[++i]) || 0.1
    else if (argv[i] === '--file') args.file = argv[++i]
  }
  return args
}

/**
 * 量一下本插件自己的工具定义成本（闸门开着时要下发的那几个）。
 * @returns {number} token 数。
 */
function measureMetaTokens() {
  const fake = createFakeCtx()
  apply(fake.ctx, {})
  const schemas = fake.ctx.tools.schemas(undefined)
  return estimateToolSchemas(schemas).total
}

/** 主流程。 */
function main() {
  const args = parseArgs(process.argv.slice(2))
  const data = JSON.parse(readFileSync(args.file, 'utf8'))
  const rows = data.rows ?? []
  if (rows.length === 0) {
    console.log(`没读到会话数据：${args.file}（先跑 npm run bench:sessions -- --json bench/out/real-sessions.json）`)
    return
  }
  const metaTokens = measureMetaTokens()

  const summary = {
    metaTokens,
    cacheWeight: args.cache,
    sessions: 0,
    requests: 0,
    baselineTools: 0,
    baselineTotal: 0,
    billableTotal: 0,
    gateSaved: 0,
    breakCost: 0,
    netGate: 0,
    trimTokens: 0,
    netGateEffective: 0,
    breakCostEffective: 0,
  }

  const lines = []
  lines.push(`本插件 meta 工具定义成本：${metaTokens} token（tool_list / tool_enable / tool_disable / fish_report）`)
  lines.push('')
  const widths = [30, 7, 10, 11, 11, 11, 10, 10]
  const header = ['会话', '请求', '现状总token', '闸门省', '断链代价', '净省', '裁剪复利', '净省%']
  lines.push(header.map((cell, index) => String(cell).padEnd(widths[index])).join('  '))
  for (const row of rows) {
    const requests = row.requests ?? 0
    if (requests === 0) continue
    const perRequestTools = row.toolsTokens ?? 0
    const gateSaved = Math.max(0, perRequestTools - metaTokens) * requests
    // 断链代价：会话里唤醒一次分组 ⇒ 一次 prompt 重整，代价按"平均一次请求的体量"估。
    // 只有 1-2 次请求的会话来不及唤醒，也就没有断链。
    const transitions = requests >= 3 ? 1 : 0
    const avgRequest = row.usage.total / requests
    const breakCost = transitions * avgRequest
    const trimTokens = row.trim?.compoundedTokens ?? 0
    const net = gateSaved - breakCost + trimTokens
    const billable = row.usage.input + row.usage.output + args.cache * (row.usage.cacheRead + row.usage.cacheWrite)
    const billableSaved = (gateSaved + trimTokens) * args.cache - breakCost + (1 - args.cache) * 0
    summary.sessions += 1
    summary.requests += requests
    summary.baselineTools += perRequestTools
    summary.baselineTotal += row.usage.total
    summary.billableTotal += billable
    summary.gateSaved += gateSaved
    summary.breakCost += breakCost
    summary.trimTokens += trimTokens
    summary.netGate += net
    // 计费口径：缓存读按 cacheWeight 折算，断链是全价。
    summary.netGateEffective += billableSaved
    summary.breakCostEffective += breakCost
    lines.push([
      String(row.file.split(/[\\/]/).slice(-2, -1)[0] ?? row.file).slice(0, 29),
      requests,
      formatTokens(row.usage.total),
      formatTokens(gateSaved),
      formatTokens(breakCost),
      formatTokens(net),
      formatTokens(trimTokens),
      `${((net / Math.max(1, row.usage.total)) * 100).toFixed(1)}%`,
    ].map((cell, index) => String(cell).padEnd(widths[index])).join('  '))
  }

  const total = summary.baselineTotal
  lines.push('')
  lines.push('== 汇总 ==')
  lines.push(`会话 ${summary.sessions} / 请求 ${summary.requests}`)
  lines.push(`现状总 token            ${formatTokens(total)}`)
  lines.push(`A 现状工具面            ${formatTokens(summary.baselineTools / summary.sessions)} token/请求`)
  lines.push(`B 闸门省下              ${formatTokens(summary.gateSaved)}（下发面 ${summary.metaTokens}/请求）`)
  lines.push(`B 断链代价（一次）      ${formatTokens(summary.breakCost)}`)
  lines.push(`C 入口裁剪复利          ${formatTokens(summary.trimTokens)}`)
  lines.push(`净省（token 口径）      ${formatTokens(summary.netGate)}  = ${((summary.netGate / Math.max(1, total)) * 100).toFixed(1)}%`)
  lines.push(`计费口径基线            ${formatTokens(summary.billableTotal)}（输入+输出+${args.cache}×缓存）`)
  lines.push(`净省（计费口径）        ${formatTokens(summary.netGateEffective)}  = ${((summary.netGateEffective / Math.max(1, summary.billableTotal)) * 100).toFixed(1)}%`)
  lines.push('')
  lines.push('假设：① 每个会话只唤醒一次分组（断链一次）；② 缓存读按 cacheWeight 折算、断链按全价；')
  lines.push('      ③ 入口裁剪阈值 3000 字符（analyze-sessions 按同一阈值算的复利）。')

  console.log(lines.join('\n'))
  if (args.json !== '') {
    writeFileSync(args.json, `${JSON.stringify({ ...summary, generatedAt: new Date().toISOString() }, null, 2)}\n`)
    console.log(`\n已写入 ${args.json}`)
  }
}

main()
