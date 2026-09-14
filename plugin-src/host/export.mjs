/**
 * 全量导出：把一张 AI 表格数据表拉全，写成 **带 BOM 的 UTF-8 CSV**（Excel 直开不乱码）。
 *
 * 为什么自己写 CSV 而不用 `dws aitable export data`：
 *   官方文档明确 `export data` 的 `--format` 是**导出格式（excel/attachment）**且**禁止追加全局
 *   `--format json`**，并且**没有 csv 选项**（见 aitable-export-import.md:7）。所以 CSV 自建。
 *
 * 全量拉取用显式游标翻页（见 fetchAllRecords 的注释：为什么不用 --all）。
 */

import { mkdir, open, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

/** Excel 认 UTF-8 CSV 的充要条件：文件以 BOM 开头。漏了中文必乱码。 */
const BOM = '\uFEFF'

/** 把任意单元格值压成可读文本（多维表的单元格是按字段类型包装的）。 */
export function flattenCell(value) {
  if (value === null || value === undefined) return ''
  if (Array.isArray(value)) {
    return value.map(flattenCell).filter(text => text !== '').join(' | ')
  }
  if (typeof value === 'object') {
    // 顺序有讲究：name（singleSelect/multipleSelect/user）> value（formula/filterUp）> 常见文本载体
    if ('name' in value) return String(value.name ?? '')
    if ('value' in value) return flattenCell(value.value)
    if ('markdown' in value) return String(value.markdown ?? '')
    if ('text' in value) return String(value.text ?? '')
    if ('link' in value) return String(value.link ?? '')
    if ('filename' in value) return String(value.filename ?? '')
    return JSON.stringify(value)
  }
  return String(value)
}

/** CSV 字段转义：含逗号/引号/换行时加引号并把内部引号翻倍。 */
function escapeCsv(text) {
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

/** 拉字段目录，得到 fieldId → 字段名（表头用中文名远比用 fldXXX 可读）。 */
export async function fetchFieldCatalog(runner, baseId, tableId) {
  const body = await runner.call('table.get', { 'base-id': baseId, 'table-ids': tableId })
  const table = body?.data?.tables?.[0] ?? body?.tables?.[0]
  const fields = table?.fields ?? []
  const byId = new Map()
  for (const field of fields) {
    if (field?.fieldId) byId.set(field.fieldId, { name: field.fieldName ?? field.fieldId, type: field.type })
  }
  return byId
}

/**
 * 全量拉取记录。
 *
 * ★ 为什么**不用** `--all`（2026-09-14 实测教训）：
 *   `--all` 配合 `--page-limit N` 触顶时，dws **以退出码 1 结束**，把已取到的 500 条塞进
 *   `error.details.incomplete_result`（而不是 `data.records`），仅靠 `cause: "paging: page-limit reached"`
 *   提示可续拉。这会让"正常的部分成功"被当成失败。此外大表单次 `--all` 还可能撞上调用超时。
 *   ⇒ 改用**显式游标翻页**：`--limit 100` + `--cursor`，永远退出码 0、单次调用快、进度可观测。
 *
 * @returns {{records: object[], pages: number, truncated: boolean, cursor?: string}}
 */
export async function fetchAllRecords(runner, baseId, tableId, options = {}) {
  const { pageLimit = 0, fieldIds, pageSize = 100, logger } = options
  // pageLimit 语义＝最大页数；0/未给 → 默认 200 页（约 2 万条）作为安全上限
  const maxPages = pageLimit > 0 ? pageLimit : 200
  const limit = Math.max(1, Math.min(Number(pageSize) || 100, 100))   // dws 单页上限 100

  const records = []
  let cursor
  let pages = 0
  let truncated = false

  while (pages < maxPages) {
    const args = ['aitable', 'record', 'query', '--base-id', baseId, '--table-id', tableId, '--limit', String(limit)]
    if (fieldIds) args.push('--field-ids', fieldIds)
    if (cursor) args.push('--cursor', cursor)

    const body = await runner.run(args)
    const data = body?.data ?? body
    const batch = Array.isArray(data?.records) ? data.records : []
    records.push(...batch)
    pages += 1
    logger?.info?.(`[dingtalk-connector] 导出推进：第 ${pages} 页，累计 ${records.length} 条`)

    const next = data?.nextCursor ?? data?.cursor
    if (typeof next !== 'string' || next === '' || next === cursor || batch.length === 0) break
    cursor = next
    if (pages >= maxPages) { truncated = true; break }
  }

  return { records, pages, truncated, ...(cursor === undefined ? {} : { cursor }) }
}

/**
 * 计算 CSV 的列集（recordId 之外）。
 *
 * ★ 列集以**字段目录**为准（全量字段、固定顺序），而不是"本批数据里出现过的字段"。
 *   教训（2026-09-14 实测）：某表结构 50 字段，但首批 2000 条记录里只有 37 个字段有值 ——
 *   若按"出现过的字段"出列，空列被省略，**列集会随数据变化而漂移**，
 *   下游按列位解析的消费者（Excel 模板、脚本）会错位。固定 schema 才是可用导出。
 */
export function csvColumns(records, fieldCatalog) {
  const knownIds = fieldCatalog instanceof Map ? [...fieldCatalog.keys()] : []
  const presentIds = new Set()
  for (const record of records) {
    for (const key of Object.keys(record?.cells ?? {})) presentIds.add(key)
  }
  return [...knownIds, ...[...presentIds].filter(id => !knownIds.includes(id))]
}

/** 记录数组 → CSV 文本（含 BOM）。表头用字段中文名，列序按表结构。 */
export function recordsToCsvWithBom(records, fieldCatalog) {
  const columns = csvColumns(records, fieldCatalog)

  const header = ['recordId', ...columns.map(id => fieldCatalog?.get?.(id)?.name ?? id)]
  const lines = [header.map(escapeCsv).join(',')]
  for (const record of records) {
    const cells = record?.cells ?? {}
    lines.push([record?.recordId ?? '', ...columns.map(id => flattenCell(cells[id]))].map(escapeCsv).join(','))
  }
  return BOM + lines.join('\r\n') + '\r\n'
}

/**
 * 导出单张表为 CSV（默认覆盖同名文件）。
 * @returns {{path: string, count: number, pages: number, bytes: number, truncated: boolean, columns: number, fetchedAt: string}}
 */
export async function exportTableCsv(runner, options) {
  const { baseId, tableId, outputPath, pageLimit = 0, fieldIds, withHeaderNames = true } = options
  if (!baseId || !tableId) throw new Error('exportTableCsv 需要 baseId 与 tableId')
  if (!outputPath) throw new Error('exportTableCsv 需要 outputPath')

  const target = resolve(String(outputPath))
  let catalog = new Map()
  if (withHeaderNames) {
    try {
      catalog = await fetchFieldCatalog(runner, baseId, tableId)
    } catch (error) {
      runner.logger?.warn?.(`[dingtalk-connector] 取字段目录失败，表头回退为 fieldId：${error?.message ?? error}`)
    }
  }

  const { records, pages, truncated } = await fetchAllRecords(runner, baseId, tableId, { pageLimit, fieldIds, logger: runner.logger })
  const content = recordsToCsvWithBom(records, catalog)

  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, content, 'utf8')      // 直接覆盖同名文件（老板裁决的默认行为）

  // 自证：回读首 3 字节确认 BOM 真的落盘。编辑器看不见 BOM，ripgrep 还会主动剥掉它 —— 只有字节可信。
  const head = Buffer.alloc(3)
  const handle = await open(target, 'r')
  try {
    await handle.read(head, 0, 3, 0)
  } finally {
    await handle.close()
  }
  const bomPresent = head[0] === 0xEF && head[1] === 0xBB && head[2] === 0xBF

  return {
    path: target,
    count: records.length,
    pages,
    bytes: Buffer.byteLength(content),
    truncated,
    columns: 1 + csvColumns(records, catalog).length,   // 实际写出的列数（recordId + 字段，固定 schema）
    bomPresent,
    headBytes: head.toString('hex').toUpperCase(),
    fetchedAt: new Date().toISOString(),
  }
}
