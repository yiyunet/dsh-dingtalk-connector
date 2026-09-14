/**
 * dws 子命令注册表测试。
 *
 * 注册表是"全插件唯一声明能跑什么的地方"，所以它必须：
 *   ① 拒绝未注册的子命令（受控直通的安全前提）
 *   ② 参数**逐元素**产出（绝不拼成一条 shell 字符串）
 *   ③ 布尔开关只推 `--flag`，不推 `--flag false`（dws 会报 unknown）
 *   ④ 0 是合法值，不能被当空值丢掉（pageLimit=0 表示无限制）
 *   ⑤ 危险操作被正确标记（门禁据此拦截）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  AITABLE_COMMANDS,
  baseDocUri,
  buildCommand,
  commandKeys,
  isDestructive,
} from '../plugin-src/host/endpoints.mjs'

test('buildCommand：未注册命令直接抛错', () => {
  assert.throws(() => buildCommand('nope.nothing', {}), /未注册/)
  assert.throws(() => buildCommand('', {}), /未注册/)
})

test('buildCommand：路径与全局 --format json 就位', () => {
  const argv = buildCommand('record.query', { 'base-id': 'B1', 'table-id': 'T1' })
  assert.deepEqual(argv, ['aitable', 'record', 'query', '--base-id', 'B1', '--table-id', 'T1', '--format', 'json'])
})

test('buildCommand：逐元素产出，绝不拼 shell 字符串', () => {
  const argv = buildCommand('record.query', { 'base-id': 'B1', 'table-id': 'T1' })
  assert.ok(Array.isArray(argv))
  assert.ok(!argv.some(item => item.includes(' ')), '每个参数元素都不该含空格拼接痕迹')
})

test('buildCommand：必填缺失 → 抛错并点名参数', () => {
  assert.throws(() => buildCommand('base.search', {}), /--query/)
  assert.throws(() => buildCommand('record.create', { 'base-id': 'B', 'table-id': 'T' }), /--records/)
})

test('buildCommand：布尔 true 只推 --flag，false 与未给都跳过', () => {
  const on = buildCommand('record.query', { 'base-id': 'B', 'table-id': 'T', all: true })
  assert.ok(on.includes('--all'))
  const off = buildCommand('record.query', { 'base-id': 'B', 'table-id': 'T', all: false })
  assert.ok(!off.includes('--all'))
  assert.ok(!off.includes('false'), '不能推出 --all false')
})

test('buildCommand：0 是合法值，不被当空值丢掉', () => {
  const argv = buildCommand('record.query', { 'base-id': 'B', 'table-id': 'T', 'page-limit': 0 })
  assert.ok(argv.includes('--page-limit'))
  assert.equal(argv[argv.indexOf('--page-limit') + 1], '0')
})

test('buildCommand：空串按未给处理（非必填则跳过，必填则报错）', () => {
  const argv = buildCommand('record.query', { 'base-id': 'B', 'table-id': 'T', keyword: '' })
  assert.ok(!argv.includes('--keyword'))
  assert.throws(() => buildCommand('base.search', { query: '' }), /--query/)
})

test('buildCommand：对象参数被 JSON 化（filters / records）', () => {
  const filters = { operator: 'and', operands: [{ operator: 'is', operands: ['fldA', '甲'] }] }
  const argv = buildCommand('record.query', { 'base-id': 'B', 'table-id': 'T', filters })
  const value = argv[argv.indexOf('--filters') + 1]
  assert.deepEqual(JSON.parse(value), filters)
})

test('isDestructive：只有不可逆操作被标记', () => {
  for (const key of ['base.delete', 'table.delete', 'field.delete', 'record.delete']) {
    assert.equal(isDestructive(key), true, `${key} 应标记为 destructive`)
  }
  for (const key of ['base.list', 'base.search', 'base.get', 'table.get', 'record.query', 'record.create', 'record.update']) {
    assert.equal(isDestructive(key), false, `${key} 不应被标记为 destructive`)
  }
  assert.equal(isDestructive('nope.nothing'), false)
})

test('注册表自身健全：每条都有 path，且 path 非空', () => {
  for (const [key, spec] of Object.entries(AITABLE_COMMANDS)) {
    assert.ok(Array.isArray(spec.path) && spec.path.length > 0, `${key} 的 path 不能为空`)
    assert.ok(Object.keys(spec.flags ?? {}).length >= 0)
  }
  assert.equal(commandKeys().length, Object.keys(AITABLE_COMMANDS).length)
})

test('注册表：已知子命令齐全（防误删）', () => {
  const expected = [
    'base.list', 'base.search', 'base.get', 'base.create', 'base.update', 'base.delete',
    'table.get', 'table.create', 'table.update', 'table.delete',
    'field.get', 'field.create', 'field.update', 'field.delete',
    'record.query', 'record.create', 'record.update', 'record.delete',
    'template.search',
  ]
  for (const key of expected) {
    assert.ok(Object.hasOwn(AITABLE_COMMANDS, key), `缺少已注册命令：${key}`)
  }
})

test('baseDocUri：把 baseId 变成可点的官方链接', () => {
  assert.equal(baseDocUri('ABC123'), 'https://alidocs.dingtalk.com/i/nodes/ABC123')
})
