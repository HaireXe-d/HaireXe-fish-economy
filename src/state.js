/**
 * 运行时开关：控制台里的那个总开关。
 *
 * 为什么不用配置项：配置在 cordis.patch.yml 里，改完要重载 profile；
 * 而"养鱼经济学"这个开关是天天要点的东西，必须点一下立刻生效。
 * 所以状态放在 $DSH_HOME/fish-economy/state.json（UI 和插件都读它），
 * 插件每秒轮询一次，变了就即时开/关，不用重启。
 *
 * @module dsh-fish-economy/src/state
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * 开关文件的路径。
 * @param {{ statePath?: string, meter?: { dir?: string } }} config 配置。
 * @returns {string} 绝对路径。
 */
export function statePath(config = {}) {
  if (typeof config.statePath === 'string' && config.statePath !== '') return config.statePath
  const dir = config.meter?.dir !== undefined && config.meter.dir !== '' ? config.meter.dir : join(homedir(), '.dsh', 'fish-economy')
  return join(dir, 'state.json')
}

/**
 * 读开关；文件不存在或坏了就按"开"处理（配置本身就是开着的，默认别把功能弄丢）。
 * @param {string} file 文件路径。
 * @returns {{ enabled: boolean, updatedAt: number, exists: boolean }} 状态。
 */
export function readState(file) {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    return { enabled: raw?.enabled !== false, updatedAt: Number(raw?.updatedAt) || 0, exists: true }
  } catch {
    return { enabled: true, updatedAt: 0, exists: false }
  }
}

/**
 * 写开关。
 * @param {string} file 文件路径。
 * @param {boolean} enabled 是否启用。
 * @returns {{ enabled: boolean, updatedAt: number, exists: boolean }} 写入后的状态。
 */
export function writeState(file, enabled) {
  const now = Date.now()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify({ enabled: enabled === true, updatedAt: now }, null, 2)}\n`, 'utf8')
  return { enabled: enabled === true, updatedAt: now, exists: true }
}
