/**
 * 测试用的最小 cordis 上下文替身。
 *
 * 只实现插件真正用到的那几个面：tools.register/schemas、agent scope 的
 * tools.restrict、事件总线、effect、get()。故意写得很笨（同步、无依赖），
 * 方便断言"闸门有没有真的把工具摘掉"。
 *
 * @module dsh-fish-economy/tests/fake-ctx
 */

/**
 * 建一个假上下文。
 * @param {{ services?: Record<string, unknown> }} [options] 选项。
 * @returns {{ ctx: object, registry: Map<string, object>, restrictions: Map<object, Set<string>>, listeners: Map<string, Function[]>, emit: Function, agent: Function }} 测试工具集。
 */
export function createFakeCtx(options = {}) {
  /** @type {Map<string, object>} 全部已注册工具 */
  const registry = new Map()
  /** @type {Map<object, Set<string>>} agent -> deny 集合 */
  const restrictions = new Map()
  /** @type {Map<string, Function[]>} 事件 -> 监听器 */
  const listeners = new Map()

  /**
   * 注册监听。
   * @param {string} event 事件名。
   * @param {Function} handler 处理函数。
   * @returns {Function} disposer。
   */
  function on(event, handler) {
    const list = listeners.get(event) ?? []
    list.push(handler)
    listeners.set(event, list)
    return () => {
      const current = listeners.get(event) ?? []
      const index = current.indexOf(handler)
      if (index >= 0) current.splice(index, 1)
    }
  }

  /**
   * 触发一次 waterfall 事件：listener(payload, next)，next() 走后面的监听器。
   * @param {string} event 事件名。
   * @param {unknown} payload 输入。
   * @param {unknown} fallback 没有任何监听器时的默认返回值。
   * @param {Function[]} [chain] 指定监听器链（默认取全局）。
   * @returns {Promise<unknown>} 决策。
   */
  async function emit(event, payload, fallback, chain) {
    const list = chain ?? listeners.get(event) ?? []
    const run = async (index) => {
      if (index >= list.length) return fallback
      return list[index](payload, () => run(index + 1))
    }
    return run(0)
  }

  /**
   * 触发一次多参数 waterfall（例如 tools/post-execute 的 (exec, result, next)）。
   * @param {string} event 事件名。
   * @param {Array<unknown>} args 前 N 个参数。
   * @param {unknown} fallback 没有监听器时的默认返回值。
   * @returns {Promise<unknown>} 决策。
   */
  async function emitArgs(event, args, fallback) {
    const list = listeners.get(event) ?? []
    const run = async (index) => {
      if (index >= list.length) return fallback
      return list[index](...args, () => run(index + 1))
    }
    return run(0)
  }

  /**
   * 触发一次观察型事件（session/event 那种，多个参数、无返回值）。
   * @param {string} event 事件名。
   * @param {...unknown} args 参数。
   * @returns {number} 调用到的监听器数量。
   */
  function broadcast(event, ...args) {
    const list = listeners.get(event) ?? []
    for (const handler of list) handler(...args)
    return list.length
  }

  const ctx = {
    tools: {
      /**
       * 注册工具。
       * @param {object} definition 定义。
       * @returns {Function} disposer。
       */
      register(definition) {
        if (registry.has(definition.name)) throw new Error(`duplicate tool ${definition.name}`)
        registry.set(definition.name, definition)
        return () => registry.delete(definition.name)
      },
      /**
       * 某个 agent 视角下的可见 schema。
       * @param {object} agent agent。
       * @returns {Array<object>} schema 列表。
       */
      schemas(agent) {
        const denied = agent === undefined ? new Set() : restrictions.get(agent) ?? new Set()
        return [...registry.values()]
          .filter((definition) => !denied.has(definition.name))
          .map((definition) => ({ name: definition.name, description: definition.description, parameters: definition.parameters }))
      },
      /**
       * agent scope 的 restrict。
       * @param {object} agent agent。
       * @param {{ deny?: string[] }} filter 过滤。
       * @returns {Function} disposer。
       */
      restrictFor(agent, filter) {
        const previous = restrictions.get(agent)
        restrictions.set(agent, new Set(filter.deny ?? []))
        return () => restrictions.set(agent, previous ?? new Set())
      },
    },
    on,
    /**
     * 注册一个 effect：立即执行，返回值即清理函数。
     * @param {Function} fn 函数。
     * @returns {void}
     */
    effect(fn) {
      fn()
    },
    /**
     * 取服务。
     * @param {string} name 服务名。
     * @returns {unknown} 服务。
     */
    get(name) {
      return options.services?.[name]
    },
    systemPrompt: {
      /**
       * 注册 section（测试里只记录）。
       * @returns {Function} disposer。
       */
      section() {
        return () => {}
      },
    },
  }

  /**
   * 造一个 agent。
   * @param {string} id 会话 id。
   * @param {string} cwd 工作目录。
   * @returns {object} agent。
   */
  function agent(id, cwd) {
    const instance = {
      id,
      session: { header: { id, cwd } },
      /** @type {Map<string, Function[]>} */
      local: new Map(),
      ctx: {
        tools: {
          restrict(filter) {
            return ctx.tools.restrictFor(instance, filter)
          },
          schemas(viewed) {
            return ctx.tools.schemas(viewed ?? instance)
          },
        },
        on(event, handler) {
          const list = instance.local.get(event) ?? []
          list.push(handler)
          instance.local.set(event, list)
          return () => {}
        },
      },
    }
    return instance
  }

  /**
   * 跑某个 agent 上注册的 scope 内监听器（agent.ctx.on 注册的那些）。
   * @param {object} agent agent。
   * @param {string} event 事件名。
   * @param {unknown} payload 输入。
   * @param {unknown} fallback 默认返回值。
   * @returns {Promise<unknown>} 决策。
   */
  async function runAgent(agent, event, payload, fallback) {
    return emit(event, payload, fallback, agent.local.get(event) ?? [])
  }

  return { ctx, registry, restrictions, listeners, emit, emitArgs, broadcast, runAgent, agent }
}
