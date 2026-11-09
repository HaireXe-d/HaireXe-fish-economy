# NOTICE

本仓库的代码是独立实现（MIT），**没有复制**下列项目的源代码。列出它们是因为思路来自它们。

## 思路来源

### dsh-flash-presets

- 作者：LarryE135
- 仓库：https://github.com/LarryE135/dsh-flash-presets
- 许可：MIT
- 借用：按场景收紧预设、关掉用不上的工具以削减固定 schema 开销。
- 未采用：整卡替换系统提示（会覆盖用户 persona）、profile 级 `ptc-runtime` 覆盖。

### dsh-ops

- 作者：T-Auto
- 仓库：https://github.com/T-Auto/dsh-ops
- 许可：MIT（其 NOTICE 中另含 FastCtx 的历史归属与 Windows bash 载荷的第三方许可说明）
- 借用：门面工具思路（一个工具顶一组能力）、紧凑输出、批量调用、错误即数据。
- 未采用：Rust worker、原生 shell 载荷、隐藏官方工具、读去重（实测收益仅 0.3%）。

### 本机"养鱼"插件（未公开）

- 借用的只有场景：长人设 + 高频短对话 + 几乎不用工具。
- 没有修改它的任何文件，也没有把它的代码并入本仓库。

## 宿主 API

本插件只调用 DeepSeek Harness 暴露的公开接口（`ctx.tools.register/restrict/schemas`、
`ctx.on('system-prompt/assemble' | 'agent/pre-step' | 'tools/post-execute' | 'agent/created' |
'agent/disposed' | 'session/event')`、`ctx.effect`）。源码中的 `@deepseek-ai/*` 包仅用于阅读规格，
不参与构建、不作为依赖分发。
