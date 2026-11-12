#!/usr/bin/env node
/**
 * 养鱼经济学 · 一键安装（2026-11-12）
 *
 * 干什么：
 *   1. 把插件拷到 ~/.dsh/plugins/dsh-fish-economy
 *   2. 登记到 profile 的 dsh.profile.bundles
 *   3. 建 node_modules 链接（DSH 才加载得到）
 *
 * 它没有任何依赖（不联网、不用 npm）—— 拷过去就能跑 ✓
 *
 * 用法：
 *   node install.mjs            正常安装
 *   node install.mjs --dry      只检查，不动盘
 *   node install.mjs --remove   卸载
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG = 'dsh-fish-economy'
const ARGS = new Set(process.argv.slice(2))
const DRY = ARGS.has('--dry')
const REMOVE = ARGS.has('--remove')

const say = (s = '') => { try { console.log(s) } catch { /* */ } }
const ok = (s) => say('  ✓ ' + s)
const bad = (s) => say('  ✗ ' + s)

function die(msg, hint = '') {
  say('')
  say('  [X] ' + msg)
  if (hint) {
    say('')
    for (const l of hint.split('\n')) say('      ' + l)
  }
  say('')
  process.exit(1)
}

// ── 找 DSH 的 home ──────────────────────────────────────
const home = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || os.homedir(), '.dsh')
const profileDir = path.join(home, 'profiles', 'desktop')
const manifestFile = path.join(profileDir, 'package.json')

say('')
say('  养鱼经济学 · 安装')
say('  ===================')
say('')

if (!fs.existsSync(manifestFile)) {
  die(
    '找不到 DSH 的配置：' + manifestFile,
    '请先安装 DeepSeek Harness，并且**打开过一次**，再回来运行这个脚本。',
  )
}
if (!fs.existsSync(path.join(HERE, 'index.js'))) {
  die('这个目录里没有 index.js —— 你解压的是对的包吗？')
}

// ── 卸载 ────────────────────────────────────────────────
if (REMOVE) {
  const target = path.join(home, 'plugins', PKG)
  const link = path.join(profileDir, 'node_modules', PKG)
  try { fs.rmSync(link, { recursive: true, force: true }) } catch { /* */ }
  try { fs.rmSync(target, { recursive: true, force: true }) } catch { /* */ }
  try {
    const m = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
    if (m?.dsh?.profile?.bundles) m.dsh.profile.bundles = m.dsh.profile.bundles.filter((b) => b !== PKG)
    if (m?.dependencies) delete m.dependencies[PKG]
    fs.writeFileSync(manifestFile, JSON.stringify(m, null, 2) + '\n')
  } catch { /* */ }
  ok('已经卸载。重启 DSH 生效。')
  say('')
  process.exit(0)
}

// ── 版本信息 ────────────────────────────────────────────
let version = '?'
try { version = JSON.parse(fs.readFileSync(path.join(HERE, 'package.json'), 'utf8')).version ?? '?' } catch { /* */ }
say('  版本：' + version)
say('  DSH ：' + home)
say('')

if (DRY) {
  ok('检查通过（--dry 模式，没有动盘）')
  say('')
  process.exit(0)
}

// ── 1. 拷到 plugins ────────────────────────────────────
const target = path.join(home, 'plugins', PKG)
say('  [1/3] 装到 ' + target + ' …')
try {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true })
  fs.cpSync(HERE, target, {
    recursive: true,
    filter: (src) => {
      const base = path.basename(src)
      // 不拷这些：安装器自己、旧数据、.git
      return !['.git', 'node_modules', 'install.mjs', '.gitignore'].includes(base)
        && !base.endsWith('.zip')
    },
  })
  ok('拷好了')
} catch (e) {
  die('拷贝失败：' + String(e?.message ?? e), '检查一下 ' + path.dirname(target) + ' 的写权限。')
}

// ── 2. 登记到 profile ──────────────────────────────────
say('')
say('  [2/3] 登记到 DSH 的插件列表 …')
let manifest
try { manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) } catch {
  die('读不了 ' + manifestFile, '那个文件坏了？可以先备份它，再让 DSH 重新生成一个。')
}
manifest.dependencies ??= {}
manifest.dsh ??= {}
manifest.dsh.profile ??= {}
manifest.dsh.profile.bundles ??= []

manifest.dependencies[PKG] = 'link:' + target.replace(/\\/g, '/')
if (!manifest.dsh.profile.bundles.includes(PKG)) manifest.dsh.profile.bundles.push(PKG)
fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n')
ok('登记好了')

// ── 3. 建链接 ──────────────────────────────────────────
say('')
say('  [3/3] 链接到 node_modules …')
const linkPath = path.join(profileDir, 'node_modules', PKG)
fs.mkdirSync(path.dirname(linkPath), { recursive: true })
let linked = false
try {
  if (fs.existsSync(linkPath)) fs.rmSync(linkPath, { recursive: true, force: true })
  // Windows 用 junction（不需要管理员权限）
  fs.symlinkSync(target, linkPath, 'junction')
  linked = true
  ok('链接好了')
} catch (e) {
  try {
    fs.cpSync(target, linkPath, { recursive: true })
    linked = true
    ok('没有建链接权限，改成拷了一份')
  } catch (e2) {
    bad('链接失败：' + String(e2?.message ?? e2).slice(0, 120))
  }
}
if (!linked) {
  die('装上了但 DSH 找不到它 —— 手动把 ' + target + ' 链接到 ' + linkPath)
}

say('')
say('  ============================================')
say('    装好了')
say('  ============================================')
say('')
say('  接下来：')
say('')
say('    1. 完全退出 DSH（托盘里也退），重新打开')
say('    2. 设置 → 养鱼经济学 —— 能看到那一节就说明生效了')
say('')
say('  它是干什么的：')
say('    少带工具说明书、长输出先剪短、记忆太长自动压缩，')
say('    省掉请求里三处重复开销（实测能省 40% 左右）。')
say('')
say('  不想用了：')
say('    node install.mjs --remove')
say('')
