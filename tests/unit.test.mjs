/**
 * 纯函数层的单测：token 估算、分组、配置、闸门算式、瘦身、提示词去重。
 * 跑法：node --test tests/*.test.mjs
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { estimateTextTokens, estimateToolSchemaTokens, estimateToolSchemas, formatTokens } from '../src/token.js'
import { classifyTool, groupSchemas, suggestGroups } from '../src/groups.js'
import { DEFAULTS, resolveConfig } from '../src/config.js'
import { computeDenyList, computeKeepSet, renderToolList, schemaBudget, toolsOfGroup } from '../src/gate.js'
import { dedupeBatch, trimContent, trimText } from '../src/trim.js'
import { normalizeSectionText, slimSections } from '../src/prompt.js'

const SCHEMAS = [
  { name: 'read', description: 'Read a file.', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
  { name: 'write', description: 'Write a file.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } } },
  { name: 'pwsh', description: 'Run PowerShell.', parameters: { type: 'object', properties: { command: { type: 'string' } } } },
  { name: 'web_search', description: 'Search.', parameters: { type: 'object', properties: { queries: { type: 'array', items: { type: 'string' } } } } },
  { name: 'tool_list', description: 'List groups.', parameters: { type: 'object', properties: {} } },
  { name: 'tool_enable', description: 'Enable a group.', parameters: { type: 'object', properties: { group: { type: 'string' } } } },
  { name: 'tool_disable', description: 'Disable a group.', parameters: { type: 'object', properties: { group: { type: 'string' } } } },
]

test('token: 中文按字计价，英文按密度计价', () => {
  assert.equal(estimateTextTokens('你好世界'), 4)
  assert.ok(estimateTextTokens('hello world') < 6)
  assert.ok(estimateTextTokens('hello world') > 1)
  assert.equal(estimateTextTokens(''), 0)
  assert.ok(estimateTextTokens('a'.repeat(370)) >= 95, '370 个 ASCII≈100 token')
})

test('token: 工具 schema 成本随字段增长', () => {
  const small = estimateToolSchemaTokens({ name: 'a', description: 'x', parameters: { type: 'object', properties: {} } })
  const big = estimateToolSchemaTokens({
    name: 'big',
    description: 'x'.repeat(400),
    parameters: { type: 'object', properties: { a: { type: 'string', description: 'y'.repeat(200) } } },
  })
  assert.ok(big > small * 3)
  assert.equal(estimateToolSchemaTokens(undefined), 0)
})

test('token: 批量估算按成本降序，总数等于明细之和', () => {
  const result = estimateToolSchemas(SCHEMAS)
  assert.equal(result.total, result.byTool.reduce((sum, item) => sum + item.tokens, 0))
  assert.ok(result.byTool[0].tokens >= result.byTool.at(-1).tokens)
})

test('token: formatTokens 好读', () => {
  assert.equal(formatTokens(999), '999')
  assert.equal(formatTokens(1234), '1.23K')
  assert.equal(formatTokens(12345), '12.3K')
  assert.equal(formatTokens(1_234_567), '1.2M')
})

test('groups: 按名字归组，用户覆盖优先', () => {
  assert.equal(classifyTool('read'), 'fs')
  assert.equal(classifyTool('pwsh'), 'shell')
  assert.equal(classifyTool('web_fetch'), 'web')
  assert.equal(classifyTool('subagent_fork'), 'delegate')
  assert.equal(classifyTool('tool_list'), 'meta')
  assert.equal(classifyTool('whatever_unknown'), 'other')
  assert.equal(classifyTool('read', { shell: ['read'] }), 'shell')
})

test('groups: groupSchemas 汇总成本并按 order 排序', () => {
  const view = groupSchemas(SCHEMAS, { cost: (schema) => estimateToolSchemaTokens(schema) })
  assert.deepEqual(view.map((group) => group.id), ['meta', 'fs', 'shell', 'web'])
  const fs = view.find((group) => group.id === 'fs')
  assert.deepEqual(fs.tools.map((tool) => tool.name).sort(), ['read', 'write'])
  assert.ok(fs.tokens > 0)
})

test('groups: 用户话术能命中要用的组', () => {
  assert.ok(suggestGroups('帮我看看这个文件 C:\\a\\b.md').includes('fs'))
  assert.ok(suggestGroups('跑一下 npm test').includes('shell'))
  assert.ok(suggestGroups('帮我搜一下这个库的官网').includes('web'))
  assert.deepEqual(suggestGroups('今天天气不错'), [])
})

test('config: 默认值 + 未知键报错 + 非法模式报错', () => {
  const config = resolveConfig({})
  assert.equal(config.gate.enabled, true)
  assert.equal(config.ops.writes, false)
  assert.equal(config.trim.enabled, false)
  assert.throws(() => resolveConfig({ nope: 1 }), /未知配置项/)
  assert.throws(() => resolveConfig({ trim: { mode: 'weird' } }), /trim\.mode/)
  assert.throws(() => resolveConfig({ gate: { startGroups: 'fs' } }), /字符串数组/)
  assert.equal(DEFAULTS.gate.ttlTurns, 0, '默认永不过期，避免反复触发缓存失效')
})

test('config: 养鱼模式两种形态，显式配置仍优先', () => {
  const work = resolveConfig({ fish: { enabled: true } })
  assert.equal(work.fish.preset, 'work')
  assert.equal(work.trim.enabled, true)
  assert.equal(work.trim.mode, 'budget')
  assert.equal(work.ops.enabled, false)
  assert.deepEqual(work.gate.startGroups, ['fs', 'shell'], '机器人会读写日记，这两组预唤醒')

  const chat = resolveConfig({ fish: { enabled: true, preset: 'chat' } })
  assert.deepEqual(chat.gate.startGroups, [], '纯聊天版工具面归零')

  const custom = resolveConfig({ fish: { enabled: true }, trim: { pruneToolResultChars: 9999 } })
  assert.equal(custom.trim.pruneToolResultChars, 9999)
  assert.throws(() => resolveConfig({ fish: { preset: 'nope' } }), /fish\.preset/)
  assert.equal(resolveConfig({}).trim.enabled, false)
})

test('gate: 休眠组被 deny，meta 永远保留', () => {
  const names = SCHEMAS.map((schema) => schema.name)
  const keep = computeKeepSet(names, new Set(), {})
  assert.deepEqual([...keep].sort(), ['fish_report', 'tool_disable', 'tool_enable', 'tool_list'])
  const deny = computeDenyList(names, keep)
  assert.deepEqual(deny, ['pwsh', 'read', 'web_search', 'write'])
})

test('gate: 唤醒分组后该组工具回到保留集合', () => {
  const names = SCHEMAS.map((schema) => schema.name)
  const keep = computeKeepSet(names, new Set(['fs']), {})
  assert.ok(keep.has('read'))
  assert.ok(keep.has('write'))
  assert.ok(!keep.has('pwsh'))
})

test('gate: schemaBudget 给出全量/下发/省下三块钱', () => {
  const budget = schemaBudget(SCHEMAS, new Set(['fs']), {})
  assert.ok(budget.baseline > budget.announced)
  assert.equal(budget.saved, budget.baseline - budget.announced)
  const dormant = schemaBudget(SCHEMAS, new Set(), {})
  assert.ok(dormant.saved > budget.saved, '唤醒一个组之后省得更少')
})

test('gate: tool_list 文本标出在线/休眠与数量', () => {
  const text = renderToolList(SCHEMAS, { enabled: new Set(['fs']) })
  assert.match(text.text, /\[已启用\] fs/)
  assert.match(text.text, /\[休眠\] shell/)
  assert.match(text.text, /个休眠/)
})

test('gate: toolsOfGroup 返回组内工具名', () => {
  assert.deepEqual(toolsOfGroup(SCHEMAS, 'shell').sort(), ['pwsh'])
})

test('trim: 超预算文本掐头去尾且标注省了多少', () => {
  const source = `${'a'.repeat(5000)}TAIL`
  const result = trimText(source, 1000)
  assert.ok(result.text.length < source.length)
  assert.match(result.text, /入口裁剪/)
  assert.ok(result.text.endsWith('TAIL'))
  assert.equal(trimText('short', 1000).removed, 0)
})

test('trim: 多块内容只裁超预算的部分，非文本块保留', () => {
  const content = [
    { type: 'text', text: 'x'.repeat(9000) },
    { type: 'image', source: { kind: 'path', path: 'a.png' } },
  ]
  const result = trimContent(content, { budget: 2000 })
  assert.ok(result.removed > 6000)
  assert.equal(result.content[1].type, 'image')
  assert.equal(trimContent([{ type: 'text', text: 'tiny' }], { budget: 2000 }).removed, 0)
})

test('trim: 批次内重复长文本折叠成指路', () => {
  const block = '很长的重复文本'.repeat(100)
  const messages = [
    { role: 'user', content: [{ type: 'text', text: block }] },
    { role: 'user', content: [{ type: 'text', text: block }] },
  ]
  const result = dedupeBatch(messages, { minChars: 100 })
  assert.equal(result.duplicated, 1)
  assert.match(result.messages[1].content[0].text, /重复/)
  assert.equal(dedupeBatch(messages, { minChars: 100000 }).duplicated, 0)
})

test('prompt: 格式规范化只动空白', () => {
  assert.equal(normalizeSectionText('a  \n\n\n\nb  '), 'a\n\nb')
})

test('prompt: 去重 + 丢弃指定段 + complete 段不碰', () => {
  const sections = [
    { name: 'a', text: 'same '.repeat(60) },
    { name: 'b', text: 'same '.repeat(60) },
    { name: 'c', text: 'drop me' },
    { name: 'persona', text: 'keep', complete: true },
    { name: 'd', text: 'short' },
  ]
  const result = slimSections(sections, { dedupe: true, dropSections: ['c'], maxSectionChars: 0 })
  assert.equal(result.deduped, 1)
  assert.deepEqual(result.dropped, ['c'])
  assert.equal(result.sections.find((section) => section.name === 'persona').complete, true)
  assert.equal(result.sections.find((section) => section.name === 'persona').text, 'keep')
})
