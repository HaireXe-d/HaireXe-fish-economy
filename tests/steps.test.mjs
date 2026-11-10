/**
 * 省步骤：提示段只在养鱼会话里出现，别的时候是空串（宿主会把空段丢掉）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSteps, DEFAULT_HINT } from '../src/steps.js'

/**
 * 造一个只记录 section 调用的假上下文。
 * @returns {{ ctx: object, sections: Array<object> }} 测试上下文。
 */
function fakeCtx() {
  const sections = []
  return {
    sections,
    ctx: {
      systemPrompt: {
        section(options) {
          sections.push(options)
          return () => {}
        },
      },
    },
  }
}

test('steps: 范围内给提示，范围外返回空串', () => {
  const { ctx, sections } = fakeCtx()
  const module = createSteps(ctx, { steps: { enabled: true, hint: DEFAULT_HINT } }, {
    log: () => {},
    inScope: (agent) => String(agent?.session?.header?.cwd ?? '').includes('whale'),
    isOn: () => true,
  })
  module.install()

  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, 'fish-economy:steps')
  const text = sections[0].text
  assert.equal(typeof text, 'function', 'text 必须是函数，才能按会话决定')
  assert.equal(text({ agent: { session: { header: { cwd: 'C:/x/.dsh/whale-work' } } } }), DEFAULT_HINT)
  assert.equal(text({ agent: { session: { header: { cwd: 'C:/x/Documents/code' } } } }), '')
})

test('steps: 总开关关着时不出现', () => {
  const { ctx, sections } = fakeCtx()
  const module = createSteps(ctx, { steps: { enabled: true, hint: DEFAULT_HINT } }, {
    log: () => {},
    inScope: () => true,
    isOn: () => false,
  })
  module.install()
  assert.equal(sections[0].text({ agent: {} }), '')
})

test('steps: 配置关着时压根不注册', () => {
  const { ctx, sections } = fakeCtx()
  const module = createSteps(ctx, { steps: { enabled: false, hint: DEFAULT_HINT } }, {
    log: () => {},
    inScope: () => true,
    isOn: () => true,
  })
  assert.equal(module.install(), undefined)
  assert.equal(sections.length, 0)
})

test('steps: 可以用自定义提示语', () => {
  const { ctx, sections } = fakeCtx()
  createSteps(ctx, { steps: { enabled: true, hint: '自定义一句话' } }, {
    log: () => {},
    inScope: () => true,
    isOn: () => true,
  }).install()
  assert.equal(sections[0].text({ agent: {} }), '自定义一句话')
})
