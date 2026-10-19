/**
 * 同步任务的持久化存储。
 *
 * 任务落在 DSH home 下的独立 JSON 文件（默认 ~/.dsh/dingtalk-connector/jobs.json），
 * 与插件代码分离 —— 升级插件不丢任务定义。
 *
 * 调度语义（维护者约定）："接受 DSH 开着才执行"。
 * 即：定时器跑在 DSH host 进程内，host 一停就不执行；重启后由 scheduler 重算下次触发点。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

export const FREQUENCIES = Object.freeze({ DAILY: 'daily', WEEKLY: 'weekly' })
export const WEEKDAY_NAMES = Object.freeze(['周一', '周二', '周三', '周四', '周五', '周六', '周日'])

/** 默认任务文件路径。 */
export function defaultJobsFile() {
  return join(homedir(), '.dsh', 'dingtalk-connector', 'jobs.json')
}

/** 校验 "HH:MM"（24 小时制）。 */
export function parseTime(text) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(text ?? '').trim())
  if (!match) return undefined
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return undefined
  return { hour, minute }
}

/** 归一化任务定义；非法输入抛错（宁可拒绝，不要静默跑错）。 */
export function normalizeJob(input = {}) {
  const baseId = String(input.baseId ?? '').trim()
  const tableId = String(input.tableId ?? '').trim()
  const outputPath = String(input.outputPath ?? '').trim()
  if (!baseId) throw new Error('job 需要 baseId')
  if (!tableId) throw new Error('job 需要 tableId')
  if (!outputPath) throw new Error('job 需要 outputPath（CSV 绝对路径）')

  const frequency = String(input.frequency ?? FREQUENCIES.DAILY).toLowerCase()
  if (frequency !== FREQUENCIES.DAILY && frequency !== FREQUENCIES.WEEKLY) {
    throw new Error('frequency 只能是 daily 或 weekly')
  }
  const time = parseTime(input.time)
  if (!time) throw new Error('time 需要 "HH:MM" 24 小时制，例如 "09:00"')

  let weekday
  if (frequency === FREQUENCIES.WEEKLY) {
    const raw = Number(input.weekday)
    if (!Number.isInteger(raw) || raw < 1 || raw > 7) {
      throw new Error('frequency=weekly 时 weekday 需要 1-7（1=周一 … 7=周日）')
    }
    weekday = raw
  }

  return {
    id: String(input.id ?? randomUUID().slice(0, 8)),
    label: String(input.label ?? '').trim() || `${baseId}/${tableId}`,
    baseId,
    tableId,
    outputPath,
    frequency,
    time: `${String(time.hour).padStart(2, '0')}:${String(time.minute).padStart(2, '0')}`,
    ...(weekday === undefined ? {} : { weekday }),
    pageLimit: Number.isInteger(Number(input.pageLimit)) ? Number(input.pageLimit) : 0,
    fieldIds: input.fieldIds ? String(input.fieldIds) : undefined,
    enabled: input.enabled !== false,
    createdAt: input.createdAt ?? new Date().toISOString(),
    lastRun: input.lastRun ?? null,
    nextRun: input.nextRun ?? null,
  }
}

/** 任务存储。 */
export class JobStore {
  /** @param {string} [file] 任务文件绝对路径 */
  constructor(file = defaultJobsFile()) {
    this.file = file
    /** @type {ReturnType<typeof normalizeJob>[]} */
    this.jobs = []
  }

  async load() {
    try {
      const text = await readFile(this.file, 'utf8')
      const parsed = JSON.parse(text)
      const list = Array.isArray(parsed?.jobs) ? parsed.jobs : []
      this.jobs = list.map(job => normalizeJob(job))
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      this.jobs = []
    }
    return this.jobs
  }

  async save() {
    await mkdir(dirname(this.file), { recursive: true })
    const payload = JSON.stringify({ version: 1, savedAt: new Date().toISOString(), jobs: this.jobs }, null, 2)
    const temp = `${this.file}.tmp`
    await writeFile(temp, payload, 'utf8')
    await rename(temp, this.file)          // 原子替换，避免半截文件
  }

  list() {
    return [...this.jobs]
  }

  get(id) {
    return this.jobs.find(job => job.id === id)
  }

  async add(input) {
    const job = normalizeJob(input)
    if (this.get(job.id)) throw new Error(`任务 id 已存在：${job.id}`)
    this.jobs.push(job)
    await this.save()
    return job
  }

  async update(id, patch) {
    const index = this.jobs.findIndex(job => job.id === id)
    if (index === -1) throw new Error(`未找到任务：${id}`)
    this.jobs[index] = normalizeJob({ ...this.jobs[index], ...patch, id })
    await this.save()
    return this.jobs[index]
  }

  async remove(id) {
    const index = this.jobs.findIndex(job => job.id === id)
    if (index === -1) throw new Error(`未找到任务：${id}`)
    const [removed] = this.jobs.splice(index, 1)
    await this.save()
    return removed
  }
}
