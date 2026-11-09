/**
 * 开关文件的读写测试（控制台那两个开关）。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { readState, statePath, writeState } from '../src/state.js'

test('state: 文件不存在时默认全开', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'fish-state-')), 'state.json')
  assert.deepEqual(readState(file), { enabled: true, compaction: true, updatedAt: 0, exists: false })
})

test('state: 写入后能读回来，且带时间戳', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'fish-state-')), 'state.json')
  const written = writeState(file, { enabled: false, compaction: false })
  assert.equal(written.enabled, false)
  assert.equal(written.compaction, false)
  assert.ok(written.updatedAt > 0)
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(raw.enabled, false)
  assert.equal(raw.compaction, false)
  const back = readState(file)
  assert.equal(back.enabled, false)
  assert.equal(back.compaction, false)
  assert.equal(back.exists, true)
})

test('state: 只改一个字段时另一个保持不变', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'fish-state-')), 'state.json')
  writeState(file, { enabled: true, compaction: true })
  writeState(file, { compaction: false })
  const state = readState(file)
  assert.equal(state.enabled, true, '总开关不该被动到')
  assert.equal(state.compaction, false)
  writeState(file, { enabled: false })
  assert.equal(readState(file).compaction, false, '压缩开关也不该被动到')
})

test('state: 坏文件当成全开，不会把功能弄丢', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'fish-state-')), 'state.json')
  writeFileSync(file, '{ not json', 'utf8')
  const state = readState(file)
  assert.equal(state.enabled, true)
  assert.equal(state.compaction, true)
})

test('state: 路径默认落在 fish-economy 目录，可被 statePath 覆盖', () => {
  assert.match(statePath({}), /fish-economy[\\/]state\.json$/)
  assert.equal(statePath({ meter: { dir: 'C:/tmp/x' } }), join('C:/tmp/x', 'state.json'))
  assert.equal(statePath({ statePath: 'D:/a/b.json' }), 'D:/a/b.json')
})
