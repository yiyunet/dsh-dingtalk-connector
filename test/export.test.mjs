/**
 * CSV 导出纯函数测试。
 *
 * 重点守三条**已经踩过坑**的行为：
 *   ① 文件必须以 BOM 开头（否则 Excel 打开中文乱码）
 *   ② 列集按**字段目录**固定，不随本批数据出现过的字段漂移（下游按列位解析会错位）
 *   ③ 单元格值按字段类型包装，取值顺序不能乱（name > value > markdown > text）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  csvColumns,
  exportTableCsv,
  flattenCell,
  recordsToCsvWithBom,
} from '../plugin-src/host/export.mjs'

const catalog = () => new Map([
  ['fldA', { name: '任务名称', type: 'text' }],
  ['fldB', { name: '优先级', type: 'singleSelect' }],
  ['fldC', { name: '负责人', type: 'user' }],
])

test('flattenCell：空值 → 空串', () => {
  assert.equal(flattenCell(null), '')
  assert.equal(flattenCell(undefined), '')
})

test('flattenCell：标量与数组', () => {
  assert.equal(flattenCell('文本'), '文本')
  assert.equal(flattenCell(123), '123')
  assert.equal(flattenCell(true), 'true')
  assert.equal(flattenCell(['a', 'b']), 'a | b')
})

test('flattenCell：对象按 name > value > markdown > text 顺序取值', () => {
  assert.equal(flattenCell({ id: 'x', name: '选项名' }), '选项名')
  assert.equal(flattenCell({ value: 42 }), '42')
  assert.equal(flattenCell({ markdown: '**加粗**' }), '**加粗**')
  assert.equal(flattenCell({ text: '显示文本', link: 'https://example.com' }), '显示文本')
  assert.equal(flattenCell({ link: 'https://example.com' }), 'https://example.com')
})

test('csvColumns：以字段目录为准，空列不省略', () => {
  const records = [{ recordId: 'rec1', cells: { fldA: '甲' } }]   // fldB / fldC 本批无值
  assert.deepEqual(csvColumns(records, catalog()), ['fldA', 'fldB', 'fldC'])
})

test('csvColumns：目录外的意外字段追加在后（不丢数据）', () => {
  const records = [{ recordId: 'rec1', cells: { fldA: '甲', fldZ: '野字段' } }]
  assert.deepEqual(csvColumns(records, catalog()), ['fldA', 'fldB', 'fldC', 'fldZ'])
})

test('csvColumns：字段目录为空 Map 时退化为“出现过的字段”', () => {
  const records = [{ cells: { fldA: '甲' } }, { cells: { fldB: '乙' } }]
  assert.deepEqual(csvColumns(records, new Map()), ['fldA', 'fldB'])
})

test('recordsToCsvWithBom：以 BOM 开头，表头用中文名', () => {
  const csv = recordsToCsvWithBom([{ recordId: 'rec1', cells: { fldA: '甲', fldB: '高' } }], catalog())
  assert.ok(csv.startsWith('\uFEFF'), 'CSV 必须以 BOM 开头')
  const firstLine = csv.slice(1).split('\r\n')[0]
  assert.equal(firstLine, 'recordId,任务名称,优先级,负责人')
})

test('recordsToCsvWithBom：含逗号/引号/换行的值被正确转义', () => {
  const csv = recordsToCsvWithBom(
    [{ recordId: 'rec1', cells: { fldA: '含,逗号' } }],
    catalog(),
  )
  assert.ok(csv.includes('"含,逗号"'))

  const quoted = recordsToCsvWithBom(
    [{ recordId: 'rec1', cells: { fldA: '他说"你好"' } }],
    catalog(),
  )
  assert.ok(quoted.includes('"他说""你好"""'))
})

test('recordsToCsvWithBom：CRLF 行尾', () => {
  const csv = recordsToCsvWithBom([], catalog())
  assert.ok(csv.endsWith('\r\n'), '文件应以 CRLF 结束')
  assert.ok(!csv.slice(1).includes('\n\n'), '不应出现裸 LF')
})

test('exportTableCsv：分页拉全 + 落盘 BOM 自证 + 固定列数', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dingtalk-connector-test-'))
  const target = join(directory, 'out.csv')
  try {
    // 假的 runner：两页数据，第二页后给空 cursor 结束
    let call = 0
    const runner = {
      async call() {
        return { data: { tables: [{ fields: [
          { fieldId: 'fldA', fieldName: '任务名称', type: 'text' },
          { fieldId: 'fldB', fieldName: '优先级', type: 'singleSelect' },
        ] }] } }
      },
      async run() {
        call += 1
        if (call === 1) return { data: { records: [{ recordId: 'rec1', cells: { fldA: '甲' } }], nextCursor: 'CUR2' } }
        return { data: { records: [{ recordId: 'rec2', cells: { fldA: '乙' } }] } }
      },
      logger: { info() {}, warn() {} },
    }

    const stats = await exportTableCsv(runner, { baseId: 'B1', tableId: 'T1', outputPath: target })

    assert.equal(stats.count, 2)
    assert.equal(stats.pages, 2)
    assert.equal(stats.truncated, false)
    assert.equal(stats.bomPresent, true, 'BOM 必须真的落盘（回读字节确认）')
    assert.equal(stats.headBytes, 'EFBBBF')
    assert.equal(stats.columns, 3)      // recordId + 两个字段（空列不省略）

    const bytes = await readFile(target)
    assert.deepEqual([...bytes.subarray(0, 3)], [0xEF, 0xBB, 0xBF])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('exportTableCsv：缺 baseId / tableId / outputPath 时明确报错', async () => {
  const runner = { call: async () => ({}), run: async () => ({}), logger: {} }
  await assert.rejects(() => exportTableCsv(runner, { tableId: 'T', outputPath: 'x.csv' }), /baseId/)
  await assert.rejects(() => exportTableCsv(runner, { baseId: 'B', outputPath: 'x.csv' }), /tableId/)
  await assert.rejects(() => exportTableCsv(runner, { baseId: 'B', tableId: 'T' }), /outputPath/)
})
