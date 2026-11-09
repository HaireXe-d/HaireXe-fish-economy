/**
 * 开关文件的读写测试（控制台那个大开关）。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { readState, statePath, writeState } from '../src/state.js'

test('state: 文件不存在时默认按"开"处理', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'fish-state-')), 'state.json')
  assert.deepEqual(readState(file), { enabled: true, updatedAt: 0, exists: false })
})

test('state: 写入后能读回来，且带时间戳', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'fish-state-')), 'state.json')
  const written = writeState(file, false)
  assert.equal(written.enabled, false)
  assert.ok(written.updatedAt > 0)
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(raw.enabled, false)
  const back = readState(file)
  assert.equal(back.enabled, false)
  assert.equal(back.exists, true)
})

test('state: 坏文件当成"开"，不会把功能弄丢', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'fish-state-')), 'state.json')
  writeFileSync(file, '{ not json', 'utf8')
  assert.equal(readState(file).enabled, true)
})

test('state: 路径默认落在 fish-economy 目录，可被 statePath 覆盖', () => {
  assert.match(statePath({}), /fish-economy[\\/]state\.json$/)
  assert.equal(statePath({ meter: { dir: 'C:/tmp/x' } }), join('C:/tmp/x', 'state.json'))
  assert.equal(statePath({ statePath: 'D:/a/b.json' }), 'D:/a/b.json')
})
