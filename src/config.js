/**
 * 配置解析。
 *
 * DSH 插件侧的 config 来自 cordis.patch.yml 的那一行（用户 profile 的补丁层），
 * 这里不用 schemastery（插件侧拿不到宿主包），手写归一化 + 严格校验：
 * 未知的顶层键直接报错，避免"改了配置但没生效"的静默失败。
 *
 * @module dsh-fish-economy/src/config
 */

/** 全部默认值。金额与价格都只是默认估计，按自己账号的实际报价在 config 覆盖。 */
export const DEFAULTS = Object.freeze({
  enabled: true,
  gate: Object.freeze({
    // 默认关闭：装完不做任何配置时，所有会话的行为和以前一模一样。
    // 打开 fish.enabled 或显式写 gate.enabled: true 才生效。
    enabled: false,
    startGroups: Object.freeze([]),
    alwaysGroups: Object.freeze([]),
    scope: Object.freeze([]),
    autoEnable: true,
    ttlTurns: 0,
    overrides: Object.freeze({}),
    pins: Object.freeze([]),
  }),
  trim: Object.freeze({
    enabled: false,
    mode: 'dedupe',
    keepRecentToolResults: 2,
    pruneToolResultChars: 3000,
    dedupeMinChars: 400,
  }),
  prompt: Object.freeze({
    // 默认关闭：不配置时连系统提示都不碰。
    enabled: false,
    dedupeSections: true,
    dropSections: Object.freeze([]),
    maxSectionChars: 0,
  }),
  meter: Object.freeze({
    enabled: true,
    dir: '',
    pricePerMTok: 1,
    cachePricePerMTok: 0.2,
  }),
  budget: Object.freeze({
    // 默认关闭：压缩会改变会话历史，装完不乱动。
    enabled: false,
    compactAtTokens: 200000,
    minIntervalMs: 60000,
    timeoutMs: 180000,
  }),
  ops: Object.freeze({
    // 默认关闭：装了不配置就什么都不注册（零开销）。
    enabled: false,
    writes: false,
    allowOutside: false,
    maxChars: 20000,
  }),
  fish: Object.freeze({
    enabled: false,
    preset: 'work',
    label: '',
  }),
  debug: false,
})

/**
 * 养鱼模式预设。
 *
 * 两种形态（`fish.preset`）：
 *   - `work`（默认）：机器人会读写日记、跑命令，所以**预先唤醒 fs + shell**，其余组休眠。
 *     实测某个 QQ 养鱼机器人：6469 次请求里 5367 次工具调用（0.83 次/请求），其中 pwsh 占 65%、
 *     read/edit/write/grep/glob 占 34% —— 把这两组关掉只会换来一堆 tool_enable 往返。
 *   - `chat`：纯聊天、完全不碰工具，工具面归零（只剩 4 个 meta 工具）。
 *
 * 两者都开入口裁剪，并把阈值收紧到 2500 字符。
 */
export const FISH_PRESET_WORK = Object.freeze({
  gate: Object.freeze({
    enabled: true,
    startGroups: Object.freeze(['fs', 'shell']),
    // 只作用于养鱼的工作目录（路径里带 whale），写代码的会话完全不受影响。
    scope: Object.freeze(['whale']),
    autoEnable: true,
    ttlTurns: 0,
  }),
  trim: Object.freeze({ enabled: true, mode: 'budget', pruneToolResultChars: 2500 }),
  prompt: Object.freeze({ enabled: true, dedupeSections: true }),
  ops: Object.freeze({ enabled: false }),
  // 养鱼会话从没触发过压缩（峰值 664K），所以阈值压到 150K：一超过就压。
  budget: Object.freeze({ enabled: true, compactAtTokens: 150000 }),
})

/** 纯聊天版：工具面归零。 */
export const FISH_PRESET_CHAT = Object.freeze({
  gate: Object.freeze({
    enabled: true,
    startGroups: Object.freeze([]),
    scope: Object.freeze(['whale']),
    autoEnable: true,
    ttlTurns: 0,
  }),
  trim: Object.freeze({ enabled: true, mode: 'budget', pruneToolResultChars: 2500 }),
  prompt: Object.freeze({ enabled: true, dedupeSections: true }),
  ops: Object.freeze({ enabled: false }),
  budget: Object.freeze({ enabled: true, compactAtTokens: 150000 }),
})

/** 兼容旧名字：默认给 work 版。 */
export const FISH_PRESET = FISH_PRESET_WORK

export const TOP_LEVEL_KEYS = Object.freeze(Object.keys(DEFAULTS))

/**
 * 深合并默认值与用户配置；undefined 不覆盖，数组整体替换。
 * @param {unknown} base 默认值。
 * @param {unknown} override 用户值。
 * @returns {unknown} 合并结果。
 */
function merge(base, override) {
  if (override === undefined) return base
  if (Array.isArray(base) || Array.isArray(override)) return override
  if (base !== null && typeof base === 'object' && override !== null && typeof override === 'object') {
    const out = { ...base }
    for (const [key, value] of Object.entries(override)) {
      out[key] = key in base ? merge(base[key], value) : value
    }
    return out
  }
  return override
}

/**
 * 断言是正整数。
 * @param {string} name 字段名。
 * @param {unknown} value 值。
 * @param {boolean} [allowZero] 是否允许 0。
 * @returns {void}
 */
function assertCount(name, value, allowZero = false) {
  if (!Number.isInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new Error(`dsh-fish-economy: ${name} 必须是${allowZero ? '非负' : '正'}整数，收到 ${JSON.stringify(value)}`)
  }
}

/**
 * 断言是字符串数组。
 * @param {string} name 字段名。
 * @param {unknown} value 值。
 * @returns {void}
 */
function assertStringArray(name, value) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`dsh-fish-economy: ${name} 必须是字符串数组，收到 ${JSON.stringify(value)}`)
  }
}

/**
 * 解析并校验插件配置。
 * @param {object} [raw] cordis.patch.yml 里这一行的 config。
 * @returns {object} 冻结后的配置。
 */
export function resolveConfig(raw = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('dsh-fish-economy: config 必须是对象')
  }
  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL_KEYS.includes(key)) {
      throw new Error(`dsh-fish-economy: 未知配置项 "${key}"（允许：${TOP_LEVEL_KEYS.join(', ')}）`)
    }
  }
  const preset = raw.fish?.enabled === true
    ? (raw.fish?.preset === 'chat' ? FISH_PRESET_CHAT : FISH_PRESET_WORK)
    : {}
  const config = merge(merge(DEFAULTS, preset), raw)

  assertStringArray('gate.startGroups', config.gate.startGroups)
  assertStringArray('gate.alwaysGroups', config.gate.alwaysGroups)
  assertStringArray('gate.pins', config.gate.pins)
  assertStringArray('gate.scope', config.gate.scope)
  assertCount('gate.ttlTurns', config.gate.ttlTurns, true)

  if (!['dedupe', 'budget', 'off'].includes(config.trim.mode)) {
    throw new Error(`dsh-fish-economy: trim.mode 只能是 dedupe / budget / off，收到 ${JSON.stringify(config.trim.mode)}`)
  }
  if (!['work', 'chat'].includes(config.fish.preset)) {
    throw new Error(`dsh-fish-economy: fish.preset 只能是 work / chat，收到 ${JSON.stringify(config.fish.preset)}`)
  }
  assertCount('trim.keepRecentToolResults', config.trim.keepRecentToolResults, true)
  assertCount('trim.pruneToolResultChars', config.trim.pruneToolResultChars)
  assertCount('trim.dedupeMinChars', config.trim.dedupeMinChars)

  assertStringArray('prompt.dropSections', config.prompt.dropSections)
  assertCount('prompt.maxSectionChars', config.prompt.maxSectionChars, true)
  assertCount('ops.maxChars', config.ops.maxChars)
  assertCount('budget.compactAtTokens', config.budget.compactAtTokens)
  assertCount('budget.minIntervalMs', config.budget.minIntervalMs, true)
  assertCount('budget.timeoutMs', config.budget.timeoutMs)

  for (const [groupId, names] of Object.entries(config.gate.overrides ?? {})) {
    assertStringArray(`gate.overrides.${groupId}`, names)
  }

  return deepFreeze(config)
}

/**
 * 递归冻结。
 * @template T
 * @param {T} value 任意值。
 * @returns {T} 冻结后的同一个值。
 */
export function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const item of Object.values(value)) deepFreeze(item)
  return Object.freeze(value)
}
