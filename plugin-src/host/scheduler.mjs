/**
 * 定时调度器：把"每天/每周某个时间"变成实际触发的导出。
 *
 * 为什么不用 DSH 自带的 `@deepseek-ai/dsh-schedule`（官方文档明文，老板已裁决接受）：
 *   - 它是**会话本地提醒**，交付到同一会话，且"交付需要 live 根 agent"；
 *   - **"重复提醒只按固定间隔运行"**，官方直接劝退日历规则（"需要「每个工作日 9 点」这类日历规则时请避开它"）。
 * ⇒ 本插件自建定时器：随 DSH host 进程存活；host 停则不执行；重启后重算下次触发点。
 */

import { exportTableCsv } from './export.mjs'
import { FREQUENCIES } from './jobs.mjs'

/** Node 的 setTimeout 上限（约 24.8 天）；daily/weekly 都远小于它。 */
const MAX_DELAY_MS = 2 ** 31 - 1

/**
 * 计算下一次触发时刻。
 * @param {object} job - 已归一化的任务
 * @param {Date} [from] - 基准时刻（默认现在）
 * @returns {Date}
 */
export function computeNextRun(job, from = new Date()) {
  const [hour, minute] = String(job.time).split(':').map(Number)
  const candidate = new Date(from.getTime())
  candidate.setSeconds(0, 0)
  candidate.setHours(hour, minute, 0, 0)

  if (job.frequency === FREQUENCIES.WEEKLY) {
    // 任务里 1=周一 … 7=周日；JS 里 0=周日 … 6=周六
    const targetJsDow = job.weekday % 7
    for (let step = 0; step <= 8; step += 1) {
      const probe = new Date(candidate.getTime())
      probe.setDate(probe.getDate() + step)
      probe.setHours(hour, minute, 0, 0)
      if (probe.getDay() === targetJsDow && probe.getTime() > from.getTime()) return probe
    }
    // 理论不可达（8 天内必有一次），保底推 7 天
    candidate.setDate(candidate.getDate() + 7)
    return candidate
  }

  // daily
  if (candidate.getTime() <= from.getTime()) candidate.setDate(candidate.getDate() + 1)
  return candidate
}

/**
 * 创建调度器。
 * @param {object} options
 * @param {object} options.runner - { call, run, logger }
 * @param {import('./jobs.mjs').JobStore} options.store
 * @param {{info?: Function, warn?: Function, error?: Function}} [options.logger]
 */
export function createScheduler({ runner, store, logger }) {
  /** @type {Map<string, NodeJS.Timeout>} */
  const timers = new Map()
  let disposed = false

  function clear(jobId) {
    const timer = timers.get(jobId)
    if (timer !== undefined) {
      clearTimeout(timer)
      timers.delete(jobId)
    }
  }

  async function runJob(job) {
    const startedAt = new Date()
    const result = { at: startedAt.toISOString(), ok: false }
    try {
      const stats = await exportTableCsv(runner, {
        baseId: job.baseId,
        tableId: job.tableId,
        outputPath: job.outputPath,
        pageLimit: job.pageLimit,
        fieldIds: job.fieldIds,
      })
      result.ok = true
      result.count = stats.count
      result.bytes = stats.bytes
      result.pages = stats.pages
      result.truncated = stats.truncated
      result.path = stats.path
      logger?.info?.(`[dingtalk-connector] 任务 ${job.id} 完成：${stats.count} 条 → ${stats.path}`)
    } catch (error) {
      result.error = String(error?.message ?? error)
      result.hint = error?.hint
      logger?.error?.(`[dingtalk-connector] 任务 ${job.id} 失败：${result.error}`)
    }
    result.durationMs = Date.now() - startedAt.getTime()
    return result
  }

  /** 排下一次触发。 */
  async function schedule(job) {
    clear(job.id)
    if (disposed) return
    const next = computeNextRun(job)
    const delay = Math.min(Math.max(next.getTime() - Date.now(), 0), MAX_DELAY_MS)
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const fresh = store.get(job.id) ?? job
          const outcome = await runJob(fresh)
          fresh.lastRun = outcome
          fresh.nextRun = computeNextRun(fresh).toISOString()
          await store.save()
        } catch (error) {
          logger?.error?.(`[dingtalk-connector] 任务 ${job.id} 调度异常：${error?.message ?? error}`)
        } finally {
          const latest = store.get(job.id)
          if (latest?.enabled) void schedule(latest)
          else clear(job.id)
        }
      })()
    }, delay)
    timers.set(job.id, timer)

    job.nextRun = next.toISOString()
    return next
  }

  /** 启动：加载任务并全部排程。 */
  async function start() {
    disposed = false
    await store.load()
    for (const job of store.list()) {
      if (job.enabled) await schedule(job)
    }
    await store.save()
    const active = store.list().filter(job => job.enabled).length
    logger?.info?.(`[dingtalk-connector] 调度器已启动（${active} 个启用任务）`)
    return active
  }

  /** 停止：清空所有定时器（插件卸载时调用）。 */
  function stop() {
    disposed = true
    for (const jobId of [...timers.keys()]) clear(jobId)
  }

  /** 立即执行一次（不影响后续排程）。 */
  async function runNow(id) {
    const job = store.get(id)
    if (!job) throw new Error(`未找到任务：${id}`)
    const outcome = await runJob(job)
    job.lastRun = outcome
    await store.save()
    return outcome
  }

  /** 任务变更后重排这一个。 */
  async function reschedule(id) {
    const job = store.get(id)
    if (!job) return
    if (job.enabled) await schedule(job)
    else clear(job.id)
    await store.save()
  }

  /** 列出内存中的定时器状态（供诊断）。 */
  function status() {
    return store.list().map(job => ({
      id: job.id,
      label: job.label,
      enabled: job.enabled,
      frequency: job.frequency,
      time: job.time,
      weekday: job.weekday,
      outputPath: job.outputPath,
      nextRun: job.nextRun,
      hasLiveTimer: timers.has(job.id),
      lastRun: job.lastRun,
    }))
  }

  return { start, stop, schedule, runNow, reschedule, status, runJob }
}
