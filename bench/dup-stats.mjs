#!/usr/bin/env node
/**
 * 重复工具结果统计：同一会话里"内容完全一样"的工具结果占多少？
 * 这是"重复读取去重"这条杠杆的天花板 —— 没重复就不用做。
 *
 * 用法：node bench/dup-stats.mjs [--min 200]
 */
import { readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import zlib from 'node:zlib'

const min = Number(process.argv.includes('--min') ? process.argv[process.argv.indexOf('--min') + 1] : 200)
const root = join(homedir(), '.dsh', 'sessions')
const files = []
/** 递归找会话文件。 */
function walk(dir, depth) {
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
    else if (entry.name === 'session.v4.jsonl.zstd') files.push(full)
  }
}
walk(root, 0)

let total = 0
let dupChars = 0
let dupCount = 0
let results = 0
for (const file of files) {
  let out
  try {
    out = zlib.zstdDecompressSync(readFileSync(file)).toString('utf8')
  } catch {
    continue
  }
  const seen = new Set()
  for (const line of out.split('\n')) {
    if (line.length === 0) continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (event.type !== 'tool/result') continue
    let text = ''
    for (const block of event.data?.message?.content ?? []) if (block?.type === 'text') text += block.text
    if (text.length < min) continue
    results += 1
    total += text.length
    const key = `${text.length}:${text.slice(0, 240)}:${text.slice(-120)}`
    if (seen.has(key)) {
      dupChars += text.length
      dupCount += 1
    } else {
      seen.add(key)
    }
  }
}
const pct = (value) => `${((value / Math.max(1, total)) * 100).toFixed(1)}%`
console.log(`会话文件 ${files.length}`)
console.log(`长度≥${min} 的工具结果 ${results} 条，共 ${(total / 1e6).toFixed(1)}M 字符`)
console.log(`其中再次出现 ${dupCount} 条，${(dupChars / 1e6).toFixed(1)}M 字符（占 ${pct(dupChars)}）`)
console.log('→ 这就是"重复读取去重"能省的上限（按字符算）。')
