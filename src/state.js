/**
 * 运行时开关：控制台卡片上的两个开关。
 *
 * 为什么不用配置项：配置在 cordis.patch.yml 里，改完要重载 profile；
 * 而"养鱼经济学""压缩会话"是天天要点的东西，必须点一下立刻生效。
 * 所以状态放在 $DSH_HOME/fish-economy/state.json（UI 和插件都读它），
 * 插件每秒轮询一次，变了就即时开/关，不用重启。
 *
 *   enabled     总开关：关掉 = 闸门解除、裁剪停手、压缩停手，跟没装一样
 *   compaction  压缩会话：只控制"上下文超阈值自动压"，其它两刀不受影响
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
 * 读开关；文件不存在或坏了就按"全开"处理（配置本身就是开着的，默认别把功能弄丢）。
 * @param {string} file 文件路径。
 * @returns {{ enabled: boolean, compaction: boolean, updatedAt: number, exists: boolean }} 状态。
 */
export function readState(file) {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    return {
      enabled: raw?.enabled !== false,
      compaction: raw?.compaction !== false,
      updatedAt: Number(raw?.updatedAt) || 0,
      exists: true,
    }
  } catch {
    return { enabled: true, compaction: true, updatedAt: 0, exists: false }
  }
}

/**
 * 写开关（只传要改的字段，其它保持原样）。
 * @param {string} file 文件路径。
 * @param {{ enabled?: boolean, compaction?: boolean }} patch 要改的字段。
 * @returns {{ enabled: boolean, compaction: boolean, updatedAt: number, exists: boolean }} 写入后的状态。
 */
export function writeState(file, patch = {}) {
  const previous = readState(file)
  const next = {
    enabled: patch.enabled === undefined ? previous.enabled : patch.enabled === true,
    compaction: patch.compaction === undefined ? previous.compaction : patch.compaction === true,
  }
  const updatedAt = Date.now()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify({ ...next, updatedAt }, null, 2)}\n`, 'utf8')
  return { ...next, updatedAt, exists: true }
}
