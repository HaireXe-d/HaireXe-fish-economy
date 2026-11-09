/**
 * 工具分组表。
 *
 * 工具定义是每次请求都重发的固定开销（DSH 默认把全部 schema 塞进系统提示），
 * "分组 + 按需唤醒"是这里唯一能真正砍掉这块钱的手段：模型默认只看到
 * tool_list / tool_enable / tool_disable 三个小 schema，其余按组休眠。
 *
 * 分组规则：先看 config.groups（用户可覆盖），再按 REGISTRY 的正则顺序匹配，
 * 都不中落到 fallback 组。名称以 dsh-fish-economy 自己的工具永远固定在 meta 组。
 *
 * @module dsh-fish-economy/src/groups
 */

/**
 * 内置分组。order 决定 tool_list 的输出顺序；autoHints 用于按用户话术预唤醒。
 * @type {Array<{
 *   id: string, label: string, hint: string, order: number,
 *   match: RegExp, autoHints?: RegExp, locked?: boolean
 * }>}
 */
export const REGISTRY = [
  {
    id: 'meta',
    label: '闸门自身',
    hint: '分组目录与开关，常驻不睡',
    order: 0,
    match: /^(tool_list|tool_enable|tool_disable|fish_report|fish_economy)$/,
    locked: true,
  },
  {
    id: 'fs',
    label: '文件读写',
    hint: 'read / write / edit / glob / grep / 目录与图片',
    order: 10,
    match: /^(read|read_image|write|edit|str_replace_editor|apply_patch|move|move_path|delete|delete_path|mkdir|list_dir|ls|glob|grep)$/,
    autoHints: /(读一下|看一下|看下|打开|写|改|存|保存|路径|目录|文件|搜索|查找|grep|glob|\.(md|json|js|mjs|ts|tsx|py|txt|ya?ml|toml|log|csv|html|css|png|jpe?g|webp)\b|[A-Za-z]:\\|\/[\w.-]+\/)/i,
  },
  {
    id: 'shell',
    label: '命令行',
    hint: 'pwsh / bash / 终端会话',
    order: 20,
    match: /^(pwsh|pwsh_persistent|bash|bash_persistent|terminal|exec|shell)$/,
    autoHints: /(运行|执行|跑一下|命令|终端|安装|编译|构建|测试|npm|pnpm|yarn|node |git |pip|python |powershell|pwsh|bash|ffmpeg|curl)/i,
  },
  {
    id: 'jobs',
    label: '后台任务',
    hint: 'job_list / job_output / job_kill',
    order: 25,
    match: /^(job_list|job_output|job_kill|jobs)$/,
    autoHints: /(后台|进度|日志|跑完了|任务列表|job)/i,
  },
  {
    id: 'web',
    label: '联网',
    hint: 'web_search / web_fetch',
    order: 30,
    match: /^(web_search|web_fetch|firecrawl_search|firecrawl_fetch|fetch|search_web)$/,
    autoHints: /(搜一下|搜索一下|查一下|上网|联网|最新|官网|链接|下载|资源|github|https?:\/\/|版本号|新闻)/i,
  },
  {
    id: 'delegate',
    label: '分身与编排',
    hint: 'subagent / workflow / 子代理通信',
    order: 40,
    match: /^(subagent|subagent_fork|list_agents|send_message|interrupt_agent|workflow|structured_output|ralph)$/,
    autoHints: /(子代理|分身|并行|批量处理|编排|workflow|审一遍|调研|分开做)/i,
  },
  {
    id: 'plan',
    label: '计划与待办',
    hint: 'todo_write / exit_plan_mode',
    order: 50,
    match: /^(todo_write|todowrite|exit_plan_mode|update_plan|plan)$/,
    autoHints: /(计划|规划|拆解|步骤|待办|todo|先做什么)/i,
  },
  {
    id: 'goal',
    label: '长期目标',
    hint: 'create_goal / update_goal / get_goal',
    order: 55,
    match: /^(create_goal|update_goal|get_goal)$/,
    autoHints: /(长期目标|持续做|目标|goal|慢慢来)/i,
  },
  {
    id: 'interact',
    label: '与人交互',
    hint: 'ask_user_question / present',
    order: 60,
    match: /^(ask_user_question|present|deliverable)$/,
    autoHints: /(选一个|让我选|确认一下|给我选项|交付|展示)/i,
  },
  {
    id: 'skill',
    label: '技能',
    hint: 'skill（docx/xlsx/pptx 等）',
    order: 70,
    match: /^(skill)$/,
    autoHints: /(文档|表格|幻灯片|ppt|word|excel|pdf|技能|skill)/i,
  },
  {
    id: 'deps',
    label: '依赖环境',
    hint: 'load_workspace_dependencies',
    order: 80,
    match: /^(load_workspace_dependencies|workspace_dependencies)$/,
    autoHints: /(python|node 路径|依赖|pandas|openpyxl|环境)/i,
  },
  {
    id: 'fish',
    label: '原生批量操作',
    hint: 'ops：一次调用干多件事（本插件提供）',
    order: 15,
    match: /^(ops)$/,
    autoHints: /(批量|一次性|好几个文件|把.*都|遍历)/i,
  },
]

/**
 * 兜底分组：没被任何正则认领的工具都进这里，保证"永远不会因为没分组而消失"。
 */
export const FALLBACK_GROUP = {
  id: 'other',
  label: '其它',
  hint: '未归类的工具，默认休眠',
  order: 99,
  match: /.*/,
}

/**
 * 按工具名查分组 id。
 * @param {string} name 工具名。
 * @param {Record<string, string[]>} [overrides] 用户覆盖：group id -> 工具名数组。
 * @returns {string} 分组 id。
 */
export function classifyTool(name, overrides) {
  const toolName = String(name ?? '')
  if (overrides !== undefined && overrides !== null) {
    for (const [groupId, names] of Object.entries(overrides)) {
      if (Array.isArray(names) && names.includes(toolName)) return groupId
    }
  }
  for (const group of REGISTRY) {
    if (group.match.test(toolName)) return group.id
  }
  return FALLBACK_GROUP.id
}

/**
 * 取某个分组 id 的元数据，未知分组按兜底组返回。
 * @param {string} id 分组 id。
 * @returns {{ id: string, label: string, hint: string, order: number, match?: RegExp, autoHints?: RegExp, locked?: boolean }} 分组元数据。
 */
export function groupMeta(id) {
  return REGISTRY.find((group) => group.id === id) ?? { ...FALLBACK_GROUP, id }
}

/**
 * 把一批工具 schema 按分组整理，固定小组在前、大组在后，同组内按 token 降序。
 * @param {Array<{ name: string }>} schemas 工具 schema（至少要有 name）。
 * @param {{ overrides?: Record<string, string[]>, cost?: (schema: object) => number }} [options] 分类选项。
 * @returns {Array<{ id: string, label: string, hint: string, tools: Array<{ name: string, tokens: number }>, tokens: number }>} 分组视图。
 */
export function groupSchemas(schemas, options = {}) {
  const cost = options.cost ?? (() => 0)
  /** @type {Map<string, { id: string, label: string, hint: string, order: number, tools: Array<{ name: string, tokens: number }>, tokens: number }>} */
  const buckets = new Map()
  for (const schema of schemas ?? []) {
    const id = classifyTool(schema?.name, options.overrides)
    const meta = groupMeta(id)
    let bucket = buckets.get(id)
    if (bucket === undefined) {
      bucket = { id, label: meta.label, hint: meta.hint, order: meta.order, tools: [], tokens: 0 }
      buckets.set(id, bucket)
    }
    const tokens = cost(schema)
    bucket.tools.push({ name: String(schema.name), tokens })
    bucket.tokens += tokens
  }
  const groups = [...buckets.values()]
  for (const group of groups) group.tools.sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name))
  groups.sort((a, b) => a.order - b.order || b.tokens - a.tokens || a.id.localeCompare(b.id))
  return groups
}

/**
 * 按用户话术猜要唤醒哪些组（只看最后一轮用户输入，命中即唤醒）。
 * @param {string} text 用户输入文本。
 * @param {{ groups?: string[], overrides?: Record<string, string[]> }} [options] 额外条件。
 * @returns {string[]} 命中的分组 id（不含 meta，调用方自行加）。
 */
export function suggestGroups(text, options = {}) {
  const source = String(text ?? '')
  if (source.trim().length === 0) return []
  const hits = []
  for (const group of REGISTRY) {
    if (group.locked === true || group.autoHints === undefined) continue
    if (options.groups !== undefined && !options.groups.includes(group.id)) continue
    if (group.autoHints.test(source)) hits.push(group.id)
  }
  return hits
}
