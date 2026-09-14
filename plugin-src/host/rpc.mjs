/**
 * 客户端 ↔ 宿主 RPC：把面板要用到的能力以 HTTP RPC 端点暴露给浏览器半侧。
 *
 * 契约（经官方客户端模块系统与我方实测反推，非推测）：
 *   客户端：ctx.connection.rpc.call('/api', '<endpoint>', { method, payload }, signal)
 *   宿主：  ctx.connection.fetch.register({ path:'/api/<endpoint>', methods:['POST'],
 *            requestBody:'buffered', fetch })
 *
 * 请求信封：{ type:'client-request', rpcId, method:'<endpoint>', payload:{ method, payload } }
 * 响应信封：{ type:'server-response', rpcId, result }
 *
 * 安全：DSH 在进入本 handler 之前已做浏览器认证与 Host/Origin 信任检查；
 * 本插件不额外放宽。所有方法**只读或本地文件**，不触碰钉钉写接口。
 */

/** 端点名（不含 /api/ 前缀）。客户端必须用同一个名字。 */
export const RPC_ENDPOINT = 'dsh-dingtalk-connector'

/**
 * 拼装 Connection 的响应信封。
 *
 * ★ 形状是硬性的（DSH 源码 packages/client/connection/src/client/rpc.ts 的
 *   parseConnectionResponse 是唯一裁判）：
 *     成功 → { type:'server-response', rpcId, result: { ok:true,  value:<载荷> } }
 *     失败 → { type:'server-response', rpcId, result: { ok:false, error:{code,message,details} } }
 *   教训（2026-09-14 实测）：早先把载荷直接放在 `result` 上（result:{ok:true, cliVersion…}），
 *   客户端读到的是 result.value === undefined —— 面板因此渲染出一片"空壳"
 *   （未绑定 / CLI 未知 / 凭证来源 — ），而 RPC 本身并未报错。
 *   注意 error.details 必须是对象，缺了会被客户端判为非法响应。
 */
function reply(rpcId, result) {
  if (result?.ok === false) {
    return Response.json({
      type: 'server-response',
      rpcId,
      result: { ok: false, error: { ...result.error, details: result.error?.details ?? {} } },
    })
  }
  return Response.json({
    type: 'server-response',
    rpcId,
    result: { ok: true, value: result },
  })
}

/**
 * 注册 RPC 端点。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} deps - 与工具层共享的依赖（runner / 任务存储 / 调度器 / 服务函数）
 * @returns {(() => void) | undefined} 释放函数
 */
export function registerConnectorRpc(ctx, deps) {
  const { runner, jobStore, scheduler, jobsSummary, scanAitable, exportTableCsv, connectorStatus,
    listAccounts, unbindAccount, loginManager } = deps

  if (typeof ctx?.connection?.fetch?.register !== 'function') {
    ctx.logger?.warn?.('[dingtalk-connector] 宿主未提供 connection.fetch.register —— 设置面板不可用（工具不受影响）')
    return undefined
  }

  /** 方法表：客户端 method 名 → 处理函数。 */
  const methods = {
    /** 连接与授权状态（面板加载时调用）。 */
    async status() {
      return connectorStatus()
    },

    // ── 多账号：列出 / 移除接入 / 扫码绑定 ──────────────────────────────
    /** 列出全部已绑定钉钉账号（dws profile list）。 */
    async accounts() {
      const result = await listAccounts(runner)
      return { ok: true, ...result }
    },

    /**
     * 移除单个账号接入。
     * ⚠️ 不可逆（需重新扫码才能恢复）——客户端必须做二次确认后带 confirm:true。
     */
    async unbind(payload = {}) {
      if (!payload.selector) return { ok: false, error: { code: 'bad-request', message: '需要 selector' } }
      if (payload.confirm !== true) {
        return {
          ok: false,
          error: {
            code: 'confirm-required',
            message: '移除接入不可逆，需二次确认（confirm: true）',
            details: { selector: payload.selector },
          },
        }
      }
      const result = await unbindAccount(runner, payload.selector)
      const after = await listAccounts(runner)
      return { ok: true, ...result, ...after }
    },

    /** 启动扫码绑定会话（设备流）。probeMs>0 为探针模式。 */
    async loginStart(payload = {}) {
      return loginManager.start({
        device: payload.device !== false,
        probeMs: Number(payload.probeMs ?? 0),
      })
    },

    /** 查询登录会话状态（含原始输出与抽出的 URL）。 */
    async loginStatus() {
      return { ok: true, session: loginManager.status() }
    },

    /** 取消登录会话。 */
    async loginCancel() {
      return loginManager.cancel()
    },

    /** 扫描：候选发现 + 可读性实测。 */
    async scan(payload = {}) {
      const report = await scanAitable(runner, {
        keywords: Array.isArray(payload.keywords) ? payload.keywords : [],
        extraBaseIds: Array.isArray(payload.extraBaseIds) ? payload.extraBaseIds : [],
        withTables: payload.withTables === true,
        tableLimit: Number(payload.tableLimit ?? 0),
        concurrency: 4,
        logger: ctx.logger,
      })
      return { ok: true, ...report }
    },

    /** 取某 Base 的数据表清单（含 tableId，供勾选）。 */
    async tables(payload = {}) {
      if (!payload.baseId) return { ok: false, error: { code: 'bad-request', message: '需要 baseId' } }
      const body = await runner.call('base.get', { 'base-id': payload.baseId })
      const data = body?.data ?? body
      return {
        ok: true,
        baseId: data?.baseId ?? payload.baseId,
        baseName: data?.baseName,
        tables: (data?.tables ?? []).map(table => ({ tableId: table.tableId, tableName: table.tableName })),
      }
    },

    /** 立即导出一次（面板上的「立即导出」按钮）。 */
    async exportNow(payload = {}) {
      if (!payload.baseId || !payload.tableId || !payload.outputPath) {
        return { ok: false, error: { code: 'bad-request', message: '需要 baseId / tableId / outputPath' } }
      }
      const stats = await exportTableCsv(runner, {
        baseId: payload.baseId,
        tableId: payload.tableId,
        outputPath: payload.outputPath,
        pageLimit: Number(payload.pageLimit ?? 0),
      })
      return { ok: true, ...stats }
    },

    /** 任务清单。 */
    async jobsList() {
      return { ok: true, ...jobsSummary() }
    },

    /** 新建任务。 */
    async jobCreate(payload = {}) {
      const job = await jobStore.add({
        baseId: payload.baseId,
        tableId: payload.tableId,
        outputPath: payload.outputPath,
        frequency: payload.frequency ?? 'daily',
        time: payload.time,
        weekday: payload.weekday,
        label: payload.label,
        pageLimit: Number(payload.pageLimit ?? 0),
      })
      await scheduler.reschedule(job.id)
      return { ok: true, ...jobsSummary() }
    },

    /** 删除任务。 */
    async jobRemove(payload = {}) {
      if (!payload.id) return { ok: false, error: { code: 'bad-request', message: '需要 id' } }
      await jobStore.remove(payload.id)
      scheduler.stop()
      await scheduler.start()
      return { ok: true, ...jobsSummary() }
    },

    /** 启停任务。 */
    async jobToggle(payload = {}) {
      if (!payload.id) return { ok: false, error: { code: 'bad-request', message: '需要 id' } }
      await jobStore.update(payload.id, { enabled: payload.enabled === true })
      await scheduler.reschedule(payload.id)
      return { ok: true, ...jobsSummary() }
    },

    /** 立即跑一次任务。 */
    async jobRunNow(payload = {}) {
      if (!payload.id) return { ok: false, error: { code: 'bad-request', message: '需要 id' } }
      const outcome = await scheduler.runNow(payload.id)
      return { ok: true, outcome, ...jobsSummary() }
    },
  }

  const dispose = ctx.connection.fetch.register({
    path: `/api/${RPC_ENDPOINT}`,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      if (request.method !== 'POST') return new Response('method not allowed', { status: 405 })
      if (request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
        return new Response('content type must be application/json', { status: 415 })
      }
      let message
      try {
        message = await request.json()
      } catch {
        return new Response('body is not JSON', { status: 400 })
      }
      const rpcId = typeof message?.rpcId === 'string' ? message.rpcId : 'invalid-request'
      const call = message?.payload
      if (message?.type !== 'client-request' || typeof message.rpcId !== 'string'
        || message.method !== RPC_ENDPOINT || call === null || typeof call !== 'object'
        || typeof call.method !== 'string') {
        return reply(rpcId, { ok: false, error: { code: 'bad-request', message: '请求信封不合法' } })
      }
      const handler = methods[call.method]
      if (typeof handler !== 'function') {
        return reply(rpcId, {
          ok: false,
          error: { code: 'unknown-method', message: `未知方法：${call.method}`, details: { available: Object.keys(methods) } },
        })
      }
      try {
        return reply(rpcId, await handler(call.payload ?? {}))
      } catch (error) {
        ctx.logger?.warn?.(`[dingtalk-connector] RPC ${call.method} 失败：${error?.message ?? error}`)
        return reply(rpcId, {
          ok: false,
          error: { code: error?.code ?? 'handler-failed', message: String(error?.message ?? error), details: { hint: error?.hint } },
        })
      }
    },
  })

  ctx.logger?.info?.(`[dingtalk-connector] RPC 端点已注册：/api/${RPC_ENDPOINT}（方法：${Object.keys(methods).join(', ')}）`)
  return dispose
}
