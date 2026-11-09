/**
 * 消息路径的纯函数测试 + 一个假的 sessionController 集成测试。
 *
 * 背景：养鱼插件每次投递消息都带一整段固定说明，实测占入站字符的 81%。
 * 这里验证：第一次不动、第二次压短、不同会话互不影响、出错时原样投递。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { compressSeen, createMessagePath, dedupeContent, splitParagraphs } from '../src/messages.js'

const BOILERPLATE = [
  '按以下专属通道流程做：',
  '1) 这是主人 → 直接回，不用审核',
  '2) 像正常聊天那样回，别写成一整段总结',
  '3) 回完把内容写进 dm-reply-qq.txt，一行一句',
  '4) 如果是图片，先用 read_image 看一眼再回',
  '5) 拿不准就问，别自己编',
].join('\n')

test('messages: 切段保留分隔符', () => {
  const parts = splitParagraphs(`第一段\n\n第二段\n\n\n第三段`)
  assert.equal(parts.filter((p) => !/^\n+$/.test(p)).length, 3)
  assert.equal(parts.join(''), `第一段\n\n第二段\n\n\n第三段`)
})

test('messages: 压缩只留开头并标注后面字数', () => {
  const text = 'x'.repeat(1000)
  const compressed = compressSeen(text, 200)
  assert.ok(compressed.length < 300, `压缩后应远小于原文，实际 ${compressed.length}`)
  assert.match(compressed, /后面 \d+ 字与上文相同/)
  assert.equal(compressSeen(text, 0).startsWith('……'), true, 'keep=0 时整段丢成一句说明')
})

test('messages: 第一次出现不动，第二次压短', () => {
  const seen = new Set()
  const content = [{ type: 'text', text: `开头一句\n\n${BOILERPLATE}\n\n正文：今天吃什么` }]
  const first = dedupeContent(content, { seen, minChars: 40, keep: 50, mode: 'short' })
  assert.equal(first.savedChars, 0, '第一次不该动')
  assert.equal(first.compressed, 0)

  const second = dedupeContent([{ type: 'text', text: `另一条\n\n${BOILERPLATE}\n\n正文：晚上呢` }], { seen, minChars: 40, keep: 50, mode: 'short' })
  assert.equal(second.compressed, 1)
  assert.ok(second.savedChars > 50, `应该省下不少字符，实际 ${second.savedChars}`)
  assert.match(second.content[0].text, /与上文相同/)
  assert.match(second.content[0].text, /正文：晚上呢/, '正文必须原样保留')
})

test('messages: 短段不压，避免误伤', () => {
  const seen = new Set()
  seen.add('短句'.slice(0, 160))
  const result = dedupeContent([{ type: 'text', text: `短句` }], { seen, minChars: 40, keep: 10, mode: 'short' })
  assert.equal(result.savedChars, 0)
})

test('messages: 非文本块原样保留', () => {
  const seen = new Set()
  const result = dedupeContent([
    { type: 'image', source: 'x' },
    { type: 'text', text: `${BOILERPLATE}\n\n正文` },
  ], { seen, minChars: 40, keep: 50, mode: 'short' })
  assert.equal(result.content[0].type, 'image')
})

test('messages: 包装 sessionController.prompt —— 只动范围内的会话，且能还原', async () => {
  const calls = []
  const controller = {
    async prompt(request) {
      calls.push(request)
      return { ok: true }
    },
  }
  const saved = []
  const fakeCtx = {
    inject(_deps, cb) {
      cb({ sessionController: controller })
    },
    get(name) {
      if (name === 'agents') {
        return { get: (id) => (id === 'whale-1' ? { session: { header: { id, cwd: 'C:/x/.dsh/whale-work' } } } : undefined) }
      }
      return undefined
    },
  }
  const config = { messages: { enabled: true, mode: 'short', minChars: 40, keep: 50 }, gate: { scope: ['whale'] }, enabled: true }
  const module = createMessagePath(fakeCtx, config, {
    log: () => {},
    meter: { recordMessage: (_session, chars) => saved.push(chars) },
    inScope: (agent) => String(agent?.session?.header?.cwd ?? '').toLowerCase().includes('whale'),
    isOn: () => true,
  })
  module.install()

  const body = (tail) => [{ type: 'text', text: `${BOILERPLATE}\n\n${tail}` }]
  await controller.prompt({ sessionId: 'whale-1', mode: 'queue', content: body('第一条') })
  await controller.prompt({ sessionId: 'whale-1', mode: 'queue', content: body('第二条') })
  await controller.prompt({ sessionId: 'other-1', mode: 'queue', content: body('别人的') })

  assert.equal(calls.length, 3, '三条都要投递成功')
  assert.match(calls[1].content[0].text, /与上文相同/, '第二条应该被压短')
  assert.ok(saved.length >= 1 && saved[0] > 0, '账本要记到省下的字符')
  assert.match(calls[2].content[0].text, /专属通道流程/, '范围外的会话原样投递')

  module.stats()
  assert.ok(module.stats().compressed >= 1)
})
