/**
 * 浏览器半边的冒烟测试：把 lib/client.js 当成宿主会加载的模块跑一遍。
 *
 * 宿主的加载方式：先注入 window.__ModuleLoader__，脚本调 load({id, factory})，
 * factory(require) 返回 { inject, apply }。这里用一个最小 React 替身，确认：
 *   1) 工厂能跑通并返回 apply；
 *   2) apply 会把卡片注册到 settings.section，且 id/order/label 正确；
 *   3) 组件是个函数（不会在渲染前就炸）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

/** 造一个够用的 React 替身。 */
function reactStub() {
  return {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
  }
}

/**
 * 在沙箱里加载 lib/client.js，返回宿主视角看到的东西。
 * @returns {{ ids: string[], factory: Function }} 加载结果。
 */
function loadClient() {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const captured = []
  const window = {
    __ModuleLoader__: {
      load({ id, factory }) {
        captured.push({ id, factory })
      },
    },
  }
  const sandbox = {
    window,
    fetch: async () => ({ ok: false, json: async () => null }),
    setInterval: () => 0,
    clearInterval: () => {},
    console,
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)
  assert.equal(captured.length, 1, '应该只注册一个模块')
  return { ids: [captured[0].id], factory: captured[0].factory }
}

test('client: 模块 id 与包名一致，工厂能跑通', () => {
  const { ids, factory } = loadClient()
  assert.equal(ids[0], 'dsh-fish-economy')
  const exported = factory((name) => (name === 'react' ? reactStub() : {}))
  assert.equal(typeof exported.apply, 'function')
  // 注意：沙箱里造出来的数组跨 realm，deepEqual 会因为原型不同失败
  assert.equal(Array.from(exported.inject).join(','), 'slots')
})

test('client: apply 把卡片注册到 settings.section', () => {
  const { factory } = loadClient()
  const exported = factory(() => reactStub())

  const registered = []
  const ctx = {
    slots: {
      inject(_owner, register) {
        register()
      },
      register(options, component) {
        registered.push({ options, component })
        return () => {}
      },
    },
  }
  exported.apply(ctx)

  assert.equal(registered.length, 1)
  const { options, component } = registered[0]
  assert.equal(options.name, 'settings.section')
  assert.equal(options.id, 'fish-economy')
  assert.equal(options.order, 6)
  assert.equal(options.label(), '养鱼经济学')
  assert.equal(typeof component, 'function', '卡片应该是 React 组件函数')
})
