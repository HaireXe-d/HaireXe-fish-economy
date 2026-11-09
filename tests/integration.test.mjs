/**
 * 集成测试：把 index.js 的 apply() 挂到假上下文上，验证"注册了哪些工具、
 * 闸门有没有真的摘掉 schema、唤醒之后能不能回来、账本记不记得住"。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { createFakeCtx } from './fake-ctx.mjs'

/**
 * 造一个带若干"宿主工具"的假环境。
 * @param {object} [config] 插件配置（默认打开闸门，方便测闸门行为）。
 * @returns {object} 环境。
 */
function setup(config = {}) {
  const fake = createFakeCtx()
  // 先注册一批"宿主自带工具"，模拟真实 profile 的工具面。
  for (const name of ['read', 'write', 'edit', 'glob', 'grep', 'pwsh', 'web_search', 'web_fetch', 'todo_write', 'subagent', 'workflow', 'present']) {
    fake.ctx.tools.register({
      name,
      description: `${name} 的说明`,
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
      output: { schema: { type: 'string' }, render: () => [] },
      async execute() {
        return 'ok'
      },
    })
  }
  apply(fake.ctx, { gate: { enabled: true }, ops: { enabled: true }, statePath: join(tmpdir(), 'fish-budget-1.json'), ...config })
  const agent = fake.agent('session-test-1', process.cwd())
  fake.emit('agent/created', { agent }, undefined)
  return { ...fake, agent }
}

test('apply: 注册 5 个工具（4 个闸门 + ops）', () => {
  const { registry } = setup()
  for (const name of ['tool_list', 'tool_enable', 'tool_disable', 'fish_report', 'ops']) {
    assert.ok(registry.has(name), `${name} 应该注册`)
  }
})

test('agent/created 后：只有 meta 工具可见，其余被 deny', () => {
  const { ctx, agent } = setup()
  const visible = ctx.tools.schemas(agent).map((schema) => schema.name).sort()
  assert.deepEqual(visible, ['fish_report', 'ops', 'tool_disable', 'tool_enable', 'tool_list'].filter((name) => name !== 'ops').sort())
})

test('tool_list 报告休眠组与可省 token', async () => {
  const { registry, agent } = setup()
  const text = await registry.get('tool_list').execute({}, { agent })
  assert.match(text, /\[休眠\] fs/)
  assert.match(text, /\[休眠\] shell/)
  assert.match(text, /tool_enable/)
})

test('tool_enable 之后：该组工具回到可见集合', async () => {
  const { ctx, registry, agent } = setup()
  const reply = await registry.get('tool_enable').execute({ group: 'fs' }, { agent })
  assert.match(reply, /已唤醒：fs/)
  const visible = ctx.tools.schemas(agent).map((schema) => schema.name).sort()
  assert.ok(visible.includes('read'))
  assert.ok(visible.includes('write'))
  assert.ok(!visible.includes('pwsh'), '未唤醒的组仍然休眠')
})

test('tool_enable all 之后：全部工具可见', async () => {
  const { ctx, registry, agent } = setup()
  await registry.get('tool_enable').execute({ group: 'all' }, { agent })
  const visible = ctx.tools.schemas(agent).map((schema) => schema.name)
  assert.ok(visible.includes('pwsh'))
  assert.ok(visible.includes('workflow'))
})

test('tool_disable 之后：重新休眠', async () => {
  const { ctx, registry, agent } = setup()
  await registry.get('tool_enable').execute({ group: 'fs' }, { agent })
  await registry.get('tool_disable').execute({ group: 'fs' }, { agent })
  const visible = ctx.tools.schemas(agent).map((schema) => schema.name)
  assert.ok(!visible.includes('read'))
})

test('未知分组给出提示而不是报错', async () => {
  const { registry, agent } = setup()
  const reply = await registry.get('tool_enable').execute({ group: 'nope' }, { agent })
  assert.match(reply, /未知分组/)
})

test('pre-step 话术预唤醒：说"跑测试"就把 shell 叫起来', async () => {
  const { ctx, runAgent, agent } = setup()
  const decision = { kind: 'enter', messages: [{ role: 'user', content: [{ type: 'text', text: '跑一下 npm test 看看' }] }] }
  await runAgent(agent, 'agent/pre-step', { messages: decision.messages }, decision)
  const visible = ctx.tools.schemas(agent).map((schema) => schema.name)
  assert.ok(visible.includes('pwsh'))
})

test('assemble 记账：工具成本与瘦身都在里面', async () => {
  const fake = createFakeCtx()
  for (const name of ['read', 'pwsh']) {
    fake.ctx.tools.register({
      name,
      description: `${name} 说明`.repeat(20),
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
      output: { schema: { type: 'string' }, render: () => [] },
      async execute() {
        return 'ok'
      },
    })
  }
  apply(fake.ctx, { prompt: { enabled: true } })
  const agent = fake.agent('s2', process.cwd())
  fake.emit('agent/created', { agent }, undefined)
  const assembly = {
    sections: [
      { name: 'a', text: 'x'.repeat(400) },
      { name: 'b', text: 'x'.repeat(400) },
    ],
    variables: {},
    contexts: [],
    tools: fake.ctx.tools.schemas(agent),
  }
  const result = await fake.emitArgs('system-prompt/assemble', [assembly, { agent }], assembly)
  assert.equal(result.sections.length, 2)
  assert.match(result.sections[1].text, /重复/)
  const report = await fake.registry.get('fish_report').execute({}, { agent })
  assert.match(report, /工具定义/)
})

test('tools/post-execute：超长结果被裁剪（trim 打开时）', async () => {
  const fake = createFakeCtx()
  apply(fake.ctx, { trim: { enabled: true, mode: 'budget', pruneToolResultChars: 1000 } })
  const content = [{ type: 'text', text: 'y'.repeat(20000) }]
  const decision = await fake.emitArgs('tools/post-execute', [{ name: 'read', agent: undefined }, { content }], { kind: 'accept' })
  assert.ok(decision.content[0].text.length < 20000)
  assert.match(decision.content[0].text, /入口裁剪/)
})

test('trim 关闭时不动工具结果', async () => {
  const fake = createFakeCtx()
  apply(fake.ctx, {})
  const content = [{ type: 'text', text: 'z'.repeat(20000) }]
  const decision = await fake.emitArgs('tools/post-execute', [{ name: 'read' }, { content }], { kind: 'accept' })
  assert.deepEqual(decision, { kind: 'accept' })
})

test('账本：usage 事件之后 fish_report 有真实用量', async () => {
  const { registry, broadcast, agent } = setup()
  const session = { header: { id: 'session-test-1' } }
  broadcast('session/event', session, {
    type: 'assistant/message',
    data: { usage: { inputTokens: 1000, outputTokens: 50, cacheReadTokens: 20000, cacheWriteTokens: 0 } },
  })
  const report = await registry.get('fish_report').execute({}, { agent })
  assert.match(report, /缓存命中率/)
  assert.match(report, /21\.1K|20\.0K|cacheRead|缓存读/)
})

test('ops：读目录 / 读文件 / grep 一把过，越界路径被拒', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fish-ops-'))
  writeFileSync(join(dir, 'a.txt'), 'hello\nworld\n', 'utf8')
  const fake = createFakeCtx()
  apply(fake.ctx, { ops: { enabled: true } })
  const agent = fake.agent('s3', dir)
  const text = await fake.registry.get('ops').execute({
    calls: [
      { op: 'list', path: '.' },
      { op: 'read', path: 'a.txt' },
      { op: 'grep', pattern: 'wor', path: '.' },
      { op: 'read', path: '..\\..\\boot.ini' },
    ],
  }, { agent })
  assert.match(text, /a\.txt/)
  assert.match(text, /hello/)
  assert.match(text, /a\.txt:2: world/)
  assert.match(text, /失败/)
  assert.match(text, /工作目录之外/)
})

test('ops：默认只读，write 被拒绝', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fish-ops-'))
  const fake = createFakeCtx()
  apply(fake.ctx, { ops: { enabled: true } })
  const agent = fake.agent('s4', dir)
  const text = await fake.registry.get('ops').execute({ calls: [{ op: 'write', path: 'b.txt', content: 'x' }] }, { agent })
  assert.match(text, /ops\.writes 未开启/)
})

test('预算闸：上下文超过阈值时调用 compactNow', async () => {
  let calls = 0
  const fake = createFakeCtx({
    services: {
      compaction: {
        async compactNow() {
          calls += 1
          return { shadowedSeqs: [1, 2, 3], shadowedTokenCount: 120000, summarySeq: 99 }
        },
      },
    },
  })
  apply(fake.ctx, { statePath: join(tmpdir(), 'fish-budget-2.json'), budget: { enabled: true, compactAtTokens: 100000, minIntervalMs: 0 } })
  const agent = fake.agent('s9', process.cwd())
  fake.emit('agent/created', { agent }, undefined)
  fake.broadcast('session/event', agent.session, {
    type: 'assistant/message',
    data: { usage: { inputTokens: 50000, cacheReadTokens: 100000, outputTokens: 10 } },
  })
  fake.broadcast('session/event', agent.session, { type: 'turn/end', data: {} })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(calls, 1, '超过 100K 应该压一次')
  const report = await fake.registry.get('fish_report').execute({}, { agent })
  assert.match(report, /压缩/)
})

test('预算闸：上下文低于阈值时不动作', async () => {
  let calls = 0
  const fake = createFakeCtx({
    services: {
      compaction: {
        async compactNow() {
          calls += 1
          return null
        },
      },
    },
  })
  apply(fake.ctx, { statePath: join(tmpdir(), 'fish-budget-3.json'), budget: { enabled: true, compactAtTokens: 100000, minIntervalMs: 0 } })
  const agent = fake.agent('s10', process.cwd())
  fake.emit('agent/created', { agent }, undefined)
  fake.broadcast('session/event', agent.session, {
    type: 'assistant/message',
    data: { usage: { inputTokens: 8000, cacheReadTokens: 12000, outputTokens: 10 } },
  })
  fake.broadcast('session/event', agent.session, { type: 'turn/end', data: {} })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(calls, 0, '20K 不该触发压缩')
})

test('预算闸：compactNow 抛 busy 时不影响会话', async () => {
  const fake = createFakeCtx({
    services: {
      compaction: {
        async compactNow() {
          throw Object.assign(new Error('busy'), { code: 'busy' })
        },
      },
    },
  })
  apply(fake.ctx, { statePath: join(tmpdir(), 'fish-budget-4.json'), budget: { enabled: true, compactAtTokens: 1000, minIntervalMs: 0 } })
  const agent = fake.agent('s11', process.cwd())
  fake.emit('agent/created', { agent }, undefined)
  fake.broadcast('session/event', agent.session, { type: 'assistant/message', data: { usage: { inputTokens: 5000 } } })
  fake.broadcast('session/event', agent.session, { type: 'turn/end', data: {} })
  await new Promise((resolve) => setTimeout(resolve, 20))
  // 没有崩就行：还能正常出报告
  const report = await fake.registry.get('fish_report').execute({}, { agent })
  assert.match(report, /鱼缸账本/)
})

test('作用范围：gate.scope 只对匹配 cwd 的会话动手', () => {
  const fake = createFakeCtx()
  for (const name of ['read', 'pwsh', 'workflow']) {
    fake.ctx.tools.register({
      name,
      description: `${name} 说明`,
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'string' }, render: () => [] },
      async execute() {
        return 'ok'
      },
    })
  }
  apply(fake.ctx, { gate: { enabled: true, scope: ['whale'], startGroups: [] } })
  const bot = fake.agent('bot', 'C:\\Users\\x\\.dsh\\whale-work')
  const coder = fake.agent('coder', 'C:\\Users\\x\\Documents\\code')
  fake.emit('agent/created', { agent: bot }, undefined)
  fake.emit('agent/created', { agent: coder }, undefined)

  const botTools = fake.ctx.tools.schemas(bot).map((schema) => schema.name)
  const coderTools = fake.ctx.tools.schemas(coder).map((schema) => schema.name)
  assert.ok(!botTools.includes('pwsh'), '养鱼会话里 pwsh 应该休眠')
  assert.ok(coderTools.includes('pwsh'), '写代码的会话不受影响')
  assert.ok(coderTools.includes('workflow'))
})

test('装完不配置：零开销（不注册工具、不挂钩子）', () => {
  const fake = createFakeCtx()
  apply(fake.ctx, {})
  assert.equal(fake.registry.size, 0, '默认配置下不该注册任何工具')
  assert.equal((fake.listeners.get('session/event') ?? []).length, 0)
})

test('配置错误在 apply 阶段就炸，不会静默失效', () => {
  const fake = createFakeCtx()
  assert.throws(() => apply(fake.ctx, { trim: { mode: 'nonsense' } }), /trim\.mode/)
})

test('enabled=false 时一个工具都不注册', () => {
  const fake = createFakeCtx()
  apply(fake.ctx, { enabled: false })
  assert.equal(fake.registry.size, 0)
})
