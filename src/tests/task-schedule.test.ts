import assert from "node:assert/strict"
import { test } from "node:test"
import {
  nextCronAt,
  nextTaskRunAt,
  parseCronExpression,
  parseTaskTime,
  validateTaskSchedule,
  type ScheduleDefinition,
} from "../lib/schedule"

function schedule(patch: Partial<ScheduleDefinition> = {}): ScheduleDefinition {
  return {
    triggerId: "daily",
    time: "09:00",
    interval: 1,
    cron: "",
    timezone: "UTC",
    ...patch,
  }
}

test("cron parser accepts lists, ranges, steps and weekday/month names", () => {
  const spec = parseCronExpression("*/15 9-10 * JAN-MAR MON-FRI")
  assert.ok(spec)
  assert.deepEqual(spec.minutes, [0, 15, 30, 45])
  assert.deepEqual(spec.hours, [9, 10])
  assert.deepEqual(spec.months, [1, 2, 3])
  assert.deepEqual(spec.weekdays, [1, 2, 3, 4, 5])
  assert.equal(parseCronExpression("60 * * * *"), null)
  assert.equal(parseCronExpression("* 24 * * *"), null)
  assert.equal(parseCronExpression("* * 0 * *"), null)
  assert.equal(parseCronExpression("* * * *"), null)
  assert.equal(parseCronExpression("* * * * 1-2-3"), null)
})

test("cron next run respects UTC clock and standard day-of-month/day-of-week OR semantics", () => {
  const after = Date.parse("2026-01-01T00:00:00Z")
  assert.equal(
    nextCronAt("*/15 9-10 * * 1-5", after, "UTC"),
    Date.parse("2026-01-01T09:00:00Z"),
  )
  assert.equal(
    nextCronAt("*/15 9-10 * * 1-5", Date.parse("2026-01-02T10:45:00Z"), "UTC"),
    Date.parse("2026-01-05T09:00:00Z"),
  )
  // 13 号与星期五都受限时按“或”匹配：1 月 2 日星期五先于 1 月 13 日。
  assert.equal(
    nextCronAt("0 0 13 * 5", after, "UTC"),
    Date.parse("2026-01-02T00:00:00Z"),
  )
})

test("daily and weekly recurrence honor IANA timezones and DST offsets", () => {
  const shanghai = schedule({ triggerId: "daily", time: "09:00", timezone: "Asia/Shanghai" })
  assert.equal(
    nextTaskRunAt(shanghai, Date.parse("2026-01-01T00:00:00Z")),
    Date.parse("2026-01-01T01:00:00Z"),
  )

  const newYork = schedule({ triggerId: "daily", time: "03:00", timezone: "America/New_York" })
  assert.equal(
    nextTaskRunAt(newYork, Date.parse("2026-03-08T00:00:00Z")),
    Date.parse("2026-03-08T07:00:00Z"),
  )

  const biweekly = schedule({ triggerId: "weekly", time: "09:00", interval: 2, timezone: "Asia/Shanghai" })
  const previous = Date.parse("2026-01-05T01:00:00Z")
  assert.equal(
    nextTaskRunAt(biweekly, Date.parse("2026-01-05T02:00:00Z"), previous),
    Date.parse("2026-01-19T01:00:00Z"),
  )
})

test("schedule validation rejects invalid time, cron and timezone values", () => {
  assert.equal(validateTaskSchedule(schedule()), null)
  assert.match(validateTaskSchedule(schedule({ time: "9:00" })) ?? "", /HH:mm/)
  assert.match(validateTaskSchedule(schedule({ interval: 0 })) ?? "", /重复间隔/)
  assert.match(validateTaskSchedule(schedule({ triggerId: "cron", cron: "bad" })) ?? "", /Cron/)
  assert.match(validateTaskSchedule(schedule({ timezone: "Mars/Olympus" })) ?? "", /时区/)
  assert.equal(validateTaskSchedule(schedule({ triggerId: "logon" })), null)
  assert.deepEqual(parseTaskTime("23:59"), { hour: 23, minute: 59 })
  assert.equal(parseTaskTime("24:00"), null)
})
