/**
 * 工具闸门：把"每次请求都重发全部工具定义"改成"默认只发一张目录，用的时候再开门"。
 *
 * 机制（只用宿主公开接口）：
 *   - agent/created → 拿 agent.ctx.tools.restrict({ deny }) 把休眠组的工具从该 agent
 *     的可见集合里摘掉。restrict 是 agent scope 的，天然不影响别的 agent。
 *   - 工具 schema 在每次 assembly 时重新投影，所以"改 deny 名单"立刻在下一轮生效。
 *   - tool_enable / tool_disable 改状态 → 重新计算 deny → 旧的 restriction 先 dispose。
 *
 * 设计约束（很重要，来自实测）：
 *   - 工具集合一变，DeepSeek 的上下文缓存前缀就失效（命中率 99.8% → 掉到 0 一次），
 *     一次 cache miss 的成本可能高于省下的 schema。所以默认策略是"粘住"：
 *     一旦唤醒就保持，直到显式关闭或超过 ttlTurns 轮没再用到。
 *   - meta 组（tool_list/tool_enable/tool_disable/fish_report）永远可见，否则模型没有
 *     任何办法把工具叫回来。
 *
 * @module dsh-fish-economy/src/gate
 */
import { classifyTool, groupMeta, groupSchemas, suggestGroups } from './groups.js'
import { estimateToolSchemaTokens, formatTokens } from './token.js'

/** 永远不让休眠的工具名（本插件自己的闸门）。 */
export const META_TOOLS = Object.freeze(['tool_list', 'tool_enable', 'tool_disable', 'fish_report'])

/**
 * 计算某个 agent 当前应该保留的工具集合。
 * @param {Iterable<string>} names 基线里的全部工具名。
 * @param {Set<string>} enabled 已唤醒的分组 id。
 * @param {{ overrides?: Record<string, string[]>, pins?: string[], alwaysGroups?: string[] }} options 配置。
 * @returns {Set<string>} 应保留的工具名。
 */
export function computeKeepSet(names, enabled, options = {}) {
  const keep = new Set(META_TOOLS)
  for (const pin of options.pins ?? []) keep.add(pin)
  const active = new Set(enabled)
  for (const group of options.alwaysGroups ?? []) active.add(group)
  for (const name of names) {
    const groupId = classifyTool(name, options.overrides)
    if (active.has(groupId)) keep.add(name)
  }
  return keep
}

/**
 * 计算要 deny 的工具名（基线减去保留）。
 * @param {Iterable<string>} names 基线工具名。
 * @param {Set<string>} keep 保留集合。
 * @returns {string[]} deny 名单，按名字排序便于对比日志。
 */
export function computeDenyList(names, keep) {
  const deny = []
  for (const name of names) {
    if (name === 'run_code') continue
    if (!keep.has(name)) deny.push(name)
  }
  return deny.sort()
}

/**
 * 生成给模型看的工具目录（tool_list 的返回值）。
 * @param {Array<{ name: string }>} schemas 全量 schema（带 name）。
 * @param {{ enabled: Set<string>, overrides?: Record<string, string[]>, alwaysGroups?: string[], verbose?: boolean, group?: string }} options 选项。
 * @returns {{ text: string, tokens: number, groups: Array<object> }} 目录文本与统计。
 */
export function renderToolList(schemas, options) {
  const view = groupSchemas(schemas, {
    overrides: options.overrides,
    cost: (schema) => estimateToolSchemaTokens(schema),
  })
  const active = new Set(options.enabled)
  for (const group of options.alwaysGroups ?? []) active.add(group)
  const lines = []
  let shown = 0
  let hidden = 0
  const groupsOut = []
  for (const group of view) {
    const on = group.id === 'meta' || active.has(group.id)
    if (options.group !== undefined && options.group !== group.id) continue
    const names = group.tools.map((tool) => tool.name)
    if (on) shown += names.length
    else hidden += names.length
    groupsOut.push({ id: group.id, on, tools: group.tools, tokens: group.tokens })
    const label = on ? '[已启用]' : '[休眠]'
    lines.push(`${label} ${group.id}（${group.label}） ${names.length} 个 · ${formatTokens(group.tokens)} token`)
    lines.push(`    ${group.hint}`)
    if (options.verbose === true || options.group === group.id) {
      lines.push(`    ${names.join(', ')}`)
    }
  }
  lines.push('')
  lines.push(`共 ${shown} 个工具在线，${hidden} 个休眠。唤醒：tool_enable {"group":"fs"}；收起：tool_disable {"group":"all"}。`)
  const text = lines.join('\n')
  return { text, groups: groupsOut }
}

/**
 * 把"用户这一句话大概要哪些工具"翻译成一组要唤醒的分组。
 * @param {string} text 用户输入。
 * @returns {string[]} 分组 id。
 */
export function groupsForText(text) {
  return suggestGroups(text)
}

/**
 * 估算"全部唤醒"和"当前唤醒"的工具定义成本差。
 * @param {Array<{ name: string }>} schemas 全量 schema。
 * @param {Set<string>} enabled 已启用分组。
 * @param {{ overrides?: Record<string, string[]>, alwaysGroups?: string[] }} [options] 配置。
 * @returns {{ baseline: number, announced: number, saved: number }} 三种成本。
 */
export function schemaBudget(schemas, enabled, options = {}) {
  const keep = computeKeepSet(schemas.map((schema) => schema.name), enabled, options)
  let baseline = 0
  let announced = 0
  for (const schema of schemas) {
    const tokens = estimateToolSchemaTokens(schema)
    baseline += tokens
    if (keep.has(schema.name)) announced += tokens
  }
  return { baseline, announced, saved: Math.max(0, baseline - announced) }
}

/**
 * 某个分组里有哪些工具（用于 tool_enable 的回执）。
 * @param {Array<{ name: string }>} schemas 全量 schema。
 * @param {string} groupId 分组 id。
 * @param {{ overrides?: Record<string, string[]> }} [options] 配置。
 * @returns {string[]} 工具名。
 */
export function toolsOfGroup(schemas, groupId, options = {}) {
  return schemas
    .filter((schema) => classifyTool(schema.name, options.overrides) === groupId)
    .map((schema) => schema.name)
}

/**
 * 列出现存分组 id（不含 meta）。
 * @param {Array<{ name: string }>} schemas 全量 schema。
 * @param {{ overrides?: Record<string, string[]> }} [options] 配置。
 * @returns {string[]} 分组 id。
 */
export function groupIds(schemas, options = {}) {
  const ids = new Set()
  for (const schema of schemas) ids.add(classifyTool(schema.name, options.overrides))
  return [...ids].sort()
}

export { groupMeta }
