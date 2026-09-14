/**
 * AI 表格扫描：多渠道候选发现 + **可读性实测**。
 *
 * ★ 设计依据（2026-09-14 本机实测结论，非推测）：
 *   - `base list` 只返回**最近访问**的 Base，不是全部。
 *   - `base search --query X` 每次**最多约 4 条**，且其 `hasMore: true` 是**误报**——
 *     用返回的 `nextCursor` 翻第二页得到 0 条；不同查询返回**完全相同**的 cursor 串。
 *     ⇒ **"枚举全部 Base"在钉钉侧做不到**，因此本模块做"多渠道候选 + 实测 + 人工勾选"，
 *       而不是"全量扫描"。
 *   - 多渠道确有互补性：实测 3 次查询发现 7 个 Base，其中 3 个是 `base list` 漏掉的。
 *
 * 权限判定采用老板裁决的**实测法**：`base get` 成功即"可读"，失败记录原因。
 * 不承诺"可下载/可编辑"的精确分类（钉钉侧角色↔成员绑定 CLI 不支持）。
 */

/** 简易并发池。 */
async function mapWithLimit(items, limit, worker) {
  const results = []
  let index = 0
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (index < items.length) {
      const current = index
      index += 1
      results[current] = await worker(items[current], current)
    }
  })
  await Promise.all(runners)
  return results
}

/** 从 base list / search 的返回里抽出 bases 数组（dws 的 envelope 有两层 data）。 */
function extractBases(body) {
  return body?.data?.bases ?? body?.bases ?? []
}

/**
 * 发现候选 Base。
 * @param {object} runner
 * @param {{keywords?: string[], extraBaseIds?: string[], listRounds?: number, logger?: object}} options
 * @returns {Promise<Map<string, {baseId: string, baseName: string, sources: string[]}>>}
 */
export async function discoverBases(runner, options = {}) {
  const { keywords = [], extraBaseIds = [], listRounds = 5, logger } = options
  const found = new Map()

  const remember = (base, source) => {
    if (!base?.baseId) return
    const existing = found.get(base.baseId)
    if (existing) {
      if (!existing.sources.includes(source)) existing.sources.push(source)
      if (!existing.baseName && base.baseName) existing.baseName = base.baseName
      return
    }
    found.set(base.baseId, { baseId: base.baseId, baseName: base.baseName ?? '(未命名)', sources: [source] })
  }

  // 渠道 1：base list（最近访问）—— 带游标翻页尝试
  let cursor
  for (let round = 0; round < listRounds; round += 1) {
    const args = { limit: 10, ...(cursor ? { cursor } : {}) }
    let body
    try {
      body = await runner.call('base.list', args)
    } catch (error) {
      logger?.warn?.(`[dingtalk-connector] base list 失败：${error?.message ?? error}`)
      break
    }
    for (const base of extractBases(body)) remember(base, 'list')
    const next = body?.data?.nextCursor ?? body?.nextCursor
    if (typeof next !== 'string' || next === '' || next === cursor) break
    cursor = next
  }

  // 渠道 2：base search（按关键词；实测每次约 4 条、游标无效，故各关键词只取首页）
  for (const keyword of keywords) {
    if (typeof keyword !== 'string' || keyword.trim() === '') continue
    try {
      const body = await runner.call('base.search', { query: keyword.trim() })
      for (const base of extractBases(body)) remember(base, `search:${keyword.trim()}`)
    } catch (error) {
      logger?.warn?.(`[dingtalk-connector] base search "${keyword}" 失败：${error?.message ?? error}`)
    }
  }

  // 渠道 3：人工补录（用户直接给 baseId 或从 URL 解析所得）
  for (const baseId of extraBaseIds) {
    if (typeof baseId === 'string' && baseId.trim() !== '') {
      remember({ baseId: baseId.trim(), baseName: '' }, 'manual')
    }
  }

  return found
}

/**
 * 扫描：候选发现 → 逐个可读性实测 →（可选）取数据表清单。
 * @param {object} runner
 * @param {{keywords?: string[], extraBaseIds?: string[], withTables?: boolean, tableLimit?: number, concurrency?: number, logger?: object}} options
 */
export async function scanAitable(runner, options = {}) {
  const { withTables = false, tableLimit = 0, concurrency = 4, logger } = options
  const discovered = await discoverBases(runner, { ...options, logger })
  const candidates = [...discovered.values()]

  const probed = await mapWithLimit(candidates, concurrency, async (candidate) => {
    const row = { ...candidate, readable: false }
    try {
      const body = await runner.call('base.get', { 'base-id': candidate.baseId })
      const data = body?.data ?? body
      row.readable = true
      row.baseName = data?.baseName ?? candidate.baseName
      const tables = data?.tables ?? []
      row.tableCount = tables.length
      row.dashboardCount = (data?.dashboards ?? []).length
      if (withTables) {
        const trimmed = tableLimit > 0 ? tables.slice(0, tableLimit) : tables
        row.tables = trimmed.map(table => ({ tableId: table.tableId, tableName: table.tableName }))
        if (tableLimit > 0 && tables.length > tableLimit) row.tablesTruncated = true
      }
      row.probeResult = 'readable'
    } catch (error) {
      row.readable = false
      row.probeResult = 'unreadable'
      row.errorCode = error?.code ?? 'UNKNOWN'
      row.errorHint = error?.hint ?? String(error?.message ?? error)
    }
    return row
  })

  const readable = probed.filter(row => row.readable)
  return {
    candidates: probed,
    stats: {
      discovered: probed.length,
      readable: readable.length,
      unreadable: probed.length - readable.length,
      bySource: probed.reduce((acc, row) => {
        for (const source of row.sources) acc[source] = (acc[source] ?? 0) + 1
        return acc
      }, {}),
    },
    note: '钉钉侧没有"列出我全部 Base"的接口：base list 只给最近访问，base search 每次约 4 条且游标翻页无效。'
      + '本清单是"多渠道候选 ∪ 人工补录"，不保证穷尽；补录更多关键词或直接给 baseId 可扩大覆盖。',
  }
}
