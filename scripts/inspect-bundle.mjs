/**
 * 产物诊断 —— 当 `npm run build` 或 `npm run verify` 报"找不到某个标记"时用它看实情。
 *
 *   npm run inspect
 *
 * 之所以需要它：同一句"找不到关键标记"背后可能是完全不同的病——
 *   ① 产物根本没写出来        → 空文件 / 不存在
 *   ② 文字被转义了            → esbuild 把非 ASCII 写成 \uXXXX（人眼看不出，includes() 也找不到）
 *   ③ 契约真的漂移了          → 源码里确实没有那句话
 * 不做这一步就会把 ② 误判成 ③，然后去改本来正确的代码。
 */
import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'

import { auditMarkers } from './bundle-markers.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const TARGET = resolve(ROOT, 'lib', 'client.js')

/** 关键标记：每条都是"发布契约里必须成立"的事实，附带它能证明什么。 */
const MARKERS = [
  { label: 'esbuild 全局名', ascii: '__DshDingtalkConnector', why: 'wrapper 靠它取到内联实现' },
  { label: '装载器 id', ascii: '@yiyunet/dsh-dingtalk-connector', why: '平台模块系统按它注册' },
  { label: '面板 id 与 RPC 端点名', ascii: 'dsh-dingtalk-connector', why: '两处同为这个名字，三处必须一致' },
  { label: '面板挂载点', ascii: 'settings.section', why: '设置面板注册用的 name' },
  { label: '面板 label（中文）', text: '钉钉文档', why: '设置里显示的标题；最容易被 esbuild 转义的一项' },
  { label: '默认导出目录字段', ascii: 'defaultExportDir', why: '宿主下发、客户端读取（防硬编码个人路径）' },
]

/** 把 JS 源码里的 \uXXXX / \xXX 转义解回真实字符（只做"还原"，不改动原文件）。 */
function decodeEscapes(source) {
  return source
    .replace(/\\u\{([0-9a-fA-F]{1,6})\}/gu, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/gu, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/\\x([0-9a-fA-F]{2})/gu, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
}

function info(message) { console.log(message) }

let text
try {
  text = await readFile(TARGET, 'utf8')
} catch (error) {
  info(`✗ 读不到 ${TARGET}`)
  info(`  原因：${error?.code ?? error?.message ?? error}`)
  info('  → 先跑 `npm run build`。若不是「不存在」而是权限/占用，请关掉占用该文件的程序后重试。')
  process.exit(1)
}

const size = await stat(TARGET)
const bytes = Buffer.byteLength(text, 'utf8')
void size

info('')
info(`产物：lib/client.js`)
info(`  体量：${(bytes / 1024).toFixed(1)} KB（${bytes} 字节）`)
info(`  行数：${text.split('\n').length}`)
info(`  首行长度：${text.split('\n')[0].length} 字符  ← IIFE 打包体应独占一行，故这里通常极大`)
info(`  BOM：${bytes >= 3 && text.charCodeAt(0) === 0xFEFF ? '有' : '无'}`)
info(`  含非 ASCII 原字符：${/[^\u0000-\u007F]/u.test(text) ? '是' : '否（说明中文被转义成 \\uXXXX）'}`)
info(`  含 \\uXXXX 转义：${/\\u[0-9a-fA-F]{4}/u.test(text) ? '是' : '否'}`)
info('')

info('关键标记检查（同时按「原样」与「解转义后」两种方式匹配）：')
const { missing, escapedOnly } = auditMarkers(text, MARKERS.map(m => ({ label: m.label, needle: m.text ?? m.ascii })))
for (const marker of MARKERS) {
  const needle = marker.text ?? marker.ascii
  const verdict = text.includes(needle)
    ? '✓ 原样命中'
    : escapedOnly.includes(marker.label)
      ? '~ 解转义后命中（被 esbuild 转义了，正常）'
      : '✗ 两种都没命中'
  info(`  ${verdict}  ${marker.label}  「${needle}」`)
  info(`      ${marker.why}`)
}
info('')

if (missing.length === 0) {
  info('结论：产物完整。若 verify 仍报缺失，那是 verify 的匹配方式问题，而不是产物问题。')
  process.exit(0)
}

const first = missing[0]
info(`结论：有 ${missing.length} 项在两处都找不到 —— 这才是真的缺。接下来看源码里有没有：`)
info(`  node -e "console.log(require('node:fs').readFileSync('plugin-src/client/impl.mjs','utf8').includes('${first.needle}'))"`)
info('  源码里有、产物里没有 → 产物过期，重跑 `npm run build`；')
info('  源码里也没有 → 契约漂移，改源码而不是改这里。')
process.exit(1)
