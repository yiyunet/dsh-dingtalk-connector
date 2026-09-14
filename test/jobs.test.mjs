/**
 * 定时任务定义与持久化测试。
 *
 * 守的是"宁可拒绝，不要静默跑错"这条纪律：非法输入必须抛错，不能悄悄归一化成别的东西。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { FREQUENCIES, JobStore, normalizeJob, parseTime } from '../plugin-src/host/jobs.mjs'

const validInput = (overrides = {}) => ({
  baseId: 'B1',
  tableId: 'T1',
  outputPath: '/tmp/out.csv',
  time: '09:00',
  ...overrides,
})

test('parseTime：合法与非法', () => {
  assert.deepEqual(parseTime('09:05'), { hour: 9, minute: 5 })
  assert.deepEqual(parseTime('0:00'), { hour: 0, minute: 0 })
  assert.deepEqual(parseTime('23:59'), { hour: 23, minute: 59 })
  assert.equal(parseTime('24:00'), undefined)
  assert.equal(parseTime('09:60'), undefined)
  assert.equal(parseTime('9'), undefined)
  assert.equal(parseTime('09:00:00'), undefined)
  assert.equal(parseTime(''), undefined)
  assert.equal(parseTime(undefined), undefined)
})

test('normalizeJob：缺 baseId / tableId / outputPath 一律抛错', () => {
  assert.throws(() => normalizeJob(validInput({ baseId: '' })), /baseId/)
  assert.throws(() => normalizeJob(validInput({ tableId: '' })), /tableId/)
  assert.throws(() => normalizeJob(validInput({ outputPath: '' })), /outputPath/)
})

test('normalizeJob：frequency 只接受 daily / weekly', () => {
  assert.equal(normalizeJob(validInput()).frequency, FREQUENCIES.DAILY)
  assert.equal(normalizeJob(validInput({ frequency: 'WEEKLY', weekday: 3 })).frequency, 'weekly')
  assert.throws(() => normalizeJob(validInput({ frequency: 'monthly' })), /daily 或 weekly/)
})

test('normalizeJob：weekly 必须给 1-7 的 weekday', () => {
  assert.throws(() => normalizeJob(validInput({ frequency: 'weekly' })), /weekday/)
  assert.throws(() => normalizeJob(validInput({ frequency: 'weekly', weekday: 0 })), /weekday/)
  assert.throws(() => normalizeJob(validInput({ frequency: 'weekly', weekday: 8 })), /weekday/)
  assert.equal(normalizeJob(validInput({ frequency: 'weekly', weekday: 7 })).weekday, 7)
})

test('normalizeJob：daily 不带 weekday（不留脏字段）', () => {
  const job = normalizeJob(validInput())
  assert.equal('weekday' in job, false)
})

test('normalizeJob：time 被补齐为两位（"9:5" 不是合法输入，但 "09:00" 保留原形）', () => {
  assert.equal(normalizeJob(validInput({ time: '9:05' })).time, '09:05')
})

test('normalizeJob：id 自动生成，显式 id 被保留', () => {
  assert.match(normalizeJob(validInput()).id, /^[0-9a-f]{8}$/)
  assert.equal(normalizeJob(validInput({ id: 'abc12345' })).id, 'abc12345')
})

test('normalizeJob：label 默认拼 baseId/tableId', () => {
  assert.equal(normalizeJob(validInput()).label, 'B1/T1')
  assert.equal(normalizeJob(validInput({ label: ' 订单日更 ' })).label, '订单日更')
})

test('normalizeJob：enabled 默认 true，显式 false 保留', () => {
  assert.equal(normalizeJob(validInput()).enabled, true)
  assert.equal(normalizeJob(validInput({ enabled: false })).enabled, false)
})

test('JobStore：add → list → get → update → remove 全链路 + 原子落盘', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dingtalk-jobs-test-'))
  const file = join(directory, 'nested', 'jobs.json')
  try {
    const store = new JobStore(file)
    await store.load()
    assert.deepEqual(store.list(), [])

    const job = await store.add(validInput({ id: 'job00001', label: '订单日更' }))
    assert.equal(job.id, 'job00001')
    assert.equal(store.list().length, 1)

    // 落盘内容可直接解析，且没有残留 .tmp
    const raw = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(raw.version, 1)
    assert.equal(raw.jobs.length, 1)
    await assert.rejects(() => readFile(`${file}.tmp`, 'utf8'), /ENOENT/)

    await store.update('job00001', { enabled: false })
    assert.equal(store.get('job00001').enabled, false)

    await store.remove('job00001')
    assert.equal(store.list().length, 0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('JobStore：重复 id 与不存在的 id 都明确报错', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dingtalk-jobs-test-'))
  try {
    const store = new JobStore(join(directory, 'jobs.json'))
    await store.add(validInput({ id: 'dup00001' }))
    await assert.rejects(() => store.add(validInput({ id: 'dup00001' })), /已存在/)
    await assert.rejects(() => store.update('nope', { enabled: false }), /未找到任务/)
    await assert.rejects(() => store.remove('nope'), /未找到任务/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('JobStore：load 时对存量数据做同样校验（坏数据不静默放行）', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dingtalk-jobs-test-'))
  try {
    const file = join(directory, 'jobs.json')
    const store = new JobStore(file)
    await store.add(validInput({ id: 'good0001', outputPath: join(directory, 'out.csv') }))
    await store.update('good0001', {})          // 确保文件已写出

    // 手工写入一条坏数据：前三项（baseId / tableId / outputPath）都合法，
    // 只有 time 非法 —— 这样反射出的错误才一定是 time 校验，而不是被前面的必填项先拦下。
    const raw = JSON.parse(await readFile(file, 'utf8'))
    raw.jobs.push({
      id: 'bad00001',
      baseId: 'B',
      tableId: 'T',
      outputPath: join(directory, 'bad.csv'),
      time: '99:99',
    })
    await writeFile(file, JSON.stringify(raw), 'utf8')

    const reopened = new JobStore(file)
    await assert.rejects(() => reopened.load(), /HH:MM/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('normalizeJob 的校验顺序：必填项先于取值域（错误信息才指向真正的病根）', () => {
  // 必填缺失 → 报必填，而不是报 time
  assert.throws(
    () => normalizeJob({ baseId: 'B', tableId: 'T', time: '99:99' }),
    /outputPath/,
  )
  // 必填齐全但 time 非法 → 报 time
  assert.throws(
    () => normalizeJob({ baseId: 'B', tableId: 'T', outputPath: '/tmp/x.csv', time: '99:99' }),
    /HH:MM/,
  )
})
