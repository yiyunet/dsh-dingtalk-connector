/**
 * 调度器纯函数测试。
 *
 * ★ 边界口径（必须记牢，否则测试会写错）：`computeNextRun` 只在**同一时刻或之后**才推后。
 *   daily：候选时刻 <= from 时推一天（**等于也算推**）。
 *   weekly：probe 必须 **严格晚于** from（`>`），所以"恰好等于目标时刻"会顺延到下周同一天。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { computeNextRun } from '../plugin-src/host/scheduler.mjs'
import { FREQUENCIES } from '../plugin-src/host/jobs.mjs'

const at = (text) => new Date(text)

test('daily：当天目标时刻未到时，取当天', () => {
  const next = computeNextRun({ frequency: FREQUENCIES.DAILY, time: '09:00' }, at('2026-09-14T07:30:00'))
  assert.equal(next.getFullYear(), 2026)
  assert.equal(next.getMonth(), 8)          // 0-based：9 月
  assert.equal(next.getDate(), 14)
  assert.equal(next.getHours(), 9)
  assert.equal(next.getMinutes(), 0)
  assert.equal(next.getSeconds(), 0)
})

test('daily：候选时刻早于 from → 推后一天', () => {
  const next = computeNextRun({ frequency: FREQUENCIES.DAILY, time: '09:00' }, at('2026-09-14T10:00:00'))
  assert.equal(next.getDate(), 15)
  assert.equal(next.getHours(), 9)
})

test('daily：恰好等于 from → 按实现口径推后一天（不重复触发同一秒）', () => {
  const next = computeNextRun({ frequency: FREQUENCIES.DAILY, time: '09:00' }, at('2026-09-14T09:00:00'))
  assert.equal(next.getDate(), 15)
})

test('daily：秒与毫秒被清零（避免“每天飘一秒”）', () => {
  const next = computeNextRun({ frequency: FREQUENCIES.DAILY, time: '09:00' }, at('2026-09-14T05:00:37.912'))
  assert.equal(next.getSeconds(), 0)
  assert.equal(next.getMilliseconds(), 0)
})

test('daily：跨月边界', () => {
  const next = computeNextRun({ frequency: FREQUENCIES.DAILY, time: '09:00' }, at('2026-09-30T10:00:00'))
  assert.equal(next.getMonth(), 9)          // 10 月
  assert.equal(next.getDate(), 1)
})

test('weekly：weekday 1 = 周一', () => {
  // 2026-09-14 是周一
  const next = computeNextRun({ frequency: FREQUENCIES.WEEKLY, time: '09:00', weekday: 1 }, at('2026-09-14T07:00:00'))
  assert.equal(next.getDay(), 1)
  assert.equal(next.getDate(), 14)
})

test('weekly：同一周的周一但已过点 → 顺延到下周周一', () => {
  const next = computeNextRun({ frequency: FREQUENCIES.WEEKLY, time: '09:00', weekday: 1 }, at('2026-09-14T10:00:00'))
  assert.equal(next.getDay(), 1)
  assert.equal(next.getDate(), 21)
})

test('weekly：weekday 7 = 周日（JS getDay()=0），验证 7 % 7 的映射', () => {
  const next = computeNextRun({ frequency: FREQUENCIES.WEEKLY, time: '09:00', weekday: 7 }, at('2026-09-14T07:00:00'))
  assert.equal(next.getDay(), 0)            // 周日
  assert.equal(next.getDate(), 20)          // 9/20 是周日（9/14 周一之后的第一个周日）
})

test('weekly：所有 weekday 1..7 都能落到对应星期几', () => {
  for (let weekday = 1; weekday <= 7; weekday += 1) {
    const next = computeNextRun(
      { frequency: FREQUENCIES.WEEKLY, time: '09:00', weekday },
      at('2026-09-14T00:00:00'),
    )
    assert.equal(next.getDay(), weekday % 7, `weekday=${weekday} 应映射到 getDay()=${weekday % 7}`)
    assert.ok(next.getTime() > at('2026-09-14T00:00:00').getTime(), `weekday=${weekday} 必须晚于基准时刻`)
  }
})

test('weekly：padding 后的 time 字符串可被解析（"09:05"）', () => {
  const next = computeNextRun({ frequency: FREQUENCIES.WEEKLY, time: '09:05', weekday: 1 }, at('2026-09-14T07:00:00'))
  assert.equal(next.getHours(), 9)
  assert.equal(next.getMinutes(), 5)
})
