import type { TriggerId } from "../types"

/** 任务默认时区；旧数据与未携带 timezone 的客户端按 UTC 解释。 */
export const DEFAULT_TASK_TIMEZONE = "UTC"

/** 由服务端定时器驱动的触发器；事件类触发器不参与服务端排期。 */
export function isRecurringTrigger(triggerId: TriggerId): triggerId is "daily" | "weekly" | "cron" {
  return triggerId === "daily" || triggerId === "weekly" || triggerId === "cron"
}

export type ScheduleDefinition = {
  triggerId: TriggerId
  time: string
  interval: number
  cron: string
  timezone: string
}

export type ZonedDateParts = {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

export type CronSpec = {
  minutes: number[]
  hours: number[]
  days: number[]
  months: number[]
  weekdays: number[]
  dayOfMonthRestricted: boolean
  dayOfWeekRestricted: boolean
}

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/
const MAX_CRON_SEARCH_DAYS = 366 * 8 + 1

const MONTH_NAMES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
}

const WEEKDAY_NAMES: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
}

const partsFormatters = new Map<string, Intl.DateTimeFormat>()

function getPartsFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = partsFormatters.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
    partsFormatters.set(timeZone, formatter)
  }
  return formatter
}

/** 校验并规范化 IANA 时区名；非法时返回 null。 */
export function normalizeTimeZone(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 64) return null
  try {
    const formatter = new Intl.DateTimeFormat("en-US", { timeZone: trimmed })
    return formatter.resolvedOptions().timeZone || trimmed
  } catch {
    return null
  }
}

export function parseTaskTime(value: string): { hour: number; minute: number } | null {
  const match = TIME_PATTERN.exec(value.trim())
  if (!match) return null
  return { hour: Number(match[1]), minute: Number(match[2]) }
}

function tokenValue(token: string, names: Record<string, number> | undefined): number | null {
  if (/^\d+$/.test(token)) return Number(token)
  const named = names?.[token.toLowerCase()]
  return named === undefined ? null : named
}

function parseCronField(
  raw: string,
  minimum: number,
  maximum: number,
  names?: Record<string, number>,
): number[] | null {
  if (!raw) return null
  const values = new Set<number>()
  for (const segment of raw.split(",")) {
    if (!segment) return null
    const pieces = segment.split("/")
    if (pieces.length > 2) return null
    const rangePart = pieces[0]
    const step = pieces.length === 2 ? Number(pieces[1]) : 1
    if (!Number.isInteger(step) || step < 1) return null

    let start: number
    let end: number
    if (rangePart === "*") {
      start = minimum
      end = maximum
    } else if (rangePart.includes("-")) {
      const bounds = rangePart.split("-")
      if (bounds.length !== 2) return null
      const parsedStart = tokenValue(bounds[0], names)
      const parsedEnd = tokenValue(bounds[1], names)
      if (parsedStart === null || parsedEnd === null) return null
      start = parsedStart
      end = parsedEnd
    } else {
      const parsed = tokenValue(rangePart, names)
      if (parsed === null) return null
      start = parsed
      // “5/15”按标准 crontab 解释为从 5 开始到字段上限。
      end = pieces.length === 2 ? maximum : parsed
    }

    if (start < minimum || start > maximum || end < minimum || end > maximum || start > end) return null

    // 星期字段允许 0-7，其中 7 与 0 都代表周日；先按原范围枚举，再归一化。
    for (let value = start; value <= end; value += step) {
      const normalized = maximum === 7 && value === 7 ? 0 : value
      values.add(normalized)
    }
  }
  return values.size > 0 ? [...values].sort((a, b) => a - b) : null
}

/** 解析 5 字段 crontab 表达式；语法或范围非法时返回 null。 */
export function parseCronExpression(expression: string): CronSpec | null {
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5) return null
  const minutes = parseCronField(fields[0], 0, 59)
  const hours = parseCronField(fields[1], 0, 23)
  const days = parseCronField(fields[2], 1, 31)
  const months = parseCronField(fields[3], 1, 12, MONTH_NAMES)
  const weekdays = parseCronField(fields[4], 0, 7, WEEKDAY_NAMES)
  if (!minutes || !hours || !days || !months || !weekdays) return null
  return {
    minutes,
    hours,
    days,
    months,
    weekdays,
    dayOfMonthRestricted: days.length !== 31,
    dayOfWeekRestricted: weekdays.length !== 7,
  }
}

export function getZonedParts(timestamp: number, timeZone: string): ZonedDateParts {
  const parts = getPartsFormatter(timeZone).formatToParts(new Date(timestamp))
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0)
  const hour = read("hour")
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    // 个别 ICU 版本在午夜返回 24，归一到同一日期的 0 点。
    hour: hour === 24 ? 0 : hour,
    minute: read("minute"),
    second: read("second"),
  }
}

function offsetAt(timestamp: number, timeZone: string): number {
  const parts = getZonedParts(timestamp, timeZone)
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
  return asUtc - Math.floor(timestamp / 1000) * 1000
}

function sameLocalTime(timestamp: number, expected: ZonedDateParts, timeZone: string): boolean {
  const actual = getZonedParts(timestamp, timeZone)
  return actual.year === expected.year
    && actual.month === expected.month
    && actual.day === expected.day
    && actual.hour === expected.hour
    && actual.minute === expected.minute
    && actual.second === expected.second
}

/**
 * 把“某时区下的本地日期时间”换算成 UTC 毫秒。
 * 返回数组以覆盖夏令时回拨时同一本地时间出现两次的情况；不存在的本地时间返回空数组。
 */
function localTimeCandidates(parts: ZonedDateParts, timeZone: string): number[] {
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
  const offsets = new Set<number>()
  for (const delta of [-2 * 86_400_000, -86_400_000, -7_200_000, 0, 7_200_000, 86_400_000, 2 * 86_400_000]) {
    offsets.add(offsetAt(asUtc + delta, timeZone))
  }
  const candidates: number[] = []
  for (const offset of offsets) {
    const candidate = asUtc - offset
    if (sameLocalTime(candidate, parts, timeZone)) candidates.push(candidate)
  }
  return [...new Set(candidates)].sort((a, b) => a - b)
}

function firstAfter(candidates: number[], after: number): number | null {
  for (const candidate of candidates) {
    if (candidate > after) return candidate
  }
  return null
}

function nextDailyInitial(after: number, hour: number, minute: number, timeZone: string): number | null {
  const start = getZonedParts(after, timeZone)
  const startDay = Date.UTC(start.year, start.month - 1, start.day)
  // 最多向后寻找 8 天，足以越过夏令时空洞与普通时间边界。
  for (let offset = 0; offset <= 8; offset++) {
    const day = new Date(startDay + offset * 86_400_000)
    const candidates = localTimeCandidates({
      year: day.getUTCFullYear(),
      month: day.getUTCMonth() + 1,
      day: day.getUTCDate(),
      hour,
      minute,
      second: 0,
    }, timeZone)
    const next = firstAfter(candidates, after)
    if (next !== null) return next
  }
  return null
}

function nextDailyAfterPrevious(
  previous: number,
  after: number,
  hour: number,
  minute: number,
  stepDays: number,
  timeZone: string,
): number | null {
  const previousParts = getZonedParts(previous, timeZone)
  const previousDay = Date.UTC(previousParts.year, previousParts.month - 1, previousParts.day)
  for (let index = 1; index <= 5000; index++) {
    const day = new Date(previousDay + index * stepDays * 86_400_000)
    const candidate = firstAfter(localTimeCandidates({
      year: day.getUTCFullYear(),
      month: day.getUTCMonth() + 1,
      day: day.getUTCDate(),
      hour,
      minute,
      second: 0,
    }, timeZone), after)
    if (candidate !== null) return candidate
  }
  return null
}

function cronDayMatches(spec: CronSpec, year: number, month: number, day: number): boolean {
  if (!spec.months.includes(month)) return false
  const dayOfMonthMatches = spec.days.includes(day)
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay()
  const dayOfWeekMatches = spec.weekdays.includes(weekday)
  // 标准 crontab：日与星期都受限时取“或”，否则取“与”（未受限字段恒为真）。
  if (spec.dayOfMonthRestricted && spec.dayOfWeekRestricted) {
    return dayOfMonthMatches || dayOfWeekMatches
  }
  return dayOfMonthMatches && dayOfWeekMatches
}

/** 计算严格晚于 after 的下一次 cron 触发时间；非法表达式或 8 年内无匹配时返回 null。 */
export function nextCronAt(expression: string, after: number, timeZone: string): number | null {
  const spec = parseCronExpression(expression)
  if (!spec) return null
  const start = getZonedParts(after, timeZone)
  const startDay = Date.UTC(start.year, start.month - 1, start.day)
  for (let offset = 0; offset <= MAX_CRON_SEARCH_DAYS; offset++) {
    const day = new Date(startDay + offset * 86_400_000)
    const year = day.getUTCFullYear()
    const month = day.getUTCMonth() + 1
    const dayOfMonth = day.getUTCDate()
    if (!cronDayMatches(spec, year, month, dayOfMonth)) continue
    for (const hour of spec.hours) {
      for (const minute of spec.minutes) {
        const candidates = localTimeCandidates({ year, month, day: dayOfMonth, hour, minute, second: 0 }, timeZone)
        const next = firstAfter(candidates, after)
        if (next !== null) return next
      }
    }
  }
  return null
}

/** 校验任务排期字段；返回给面板的中文错误，合法时返回 null。 */
export function validateTaskSchedule(input: ScheduleDefinition): string | null {
  if (!normalizeTimeZone(input.timezone)) return "时区无效，请使用 IANA 时区名（例如 Asia/Shanghai）"
  if (input.triggerId === "daily" || input.triggerId === "weekly") {
    if (!parseTaskTime(input.time)) return "执行时间必须是 HH:mm 格式"
    if (!Number.isInteger(input.interval) || input.interval < 1 || input.interval > 365) {
      return "重复间隔必须是 1 到 365 之间的整数"
    }
  }
  if (input.triggerId === "cron" && !parseCronExpression(input.cron)) {
    return "Cron 表达式无效，必须为标准 5 字段格式：分 时 日 月 周"
  }
  return null
}

/**
 * 计算任务在 after 之后的下一次执行时间。
 * previousScheduledFor 用于保持“每天/每周 N 次”的既有节奏；不传时按下一次时钟时间计算。
 * 事件类触发器由客户端事件驱动，不返回服务端排期。
 */
export function nextTaskRunAt(
  task: ScheduleDefinition,
  after: number,
  previousScheduledFor?: number | null,
): number | null {
  const timeZone = normalizeTimeZone(task.timezone)
  if (!timeZone) return null
  if (task.triggerId === "daily" || task.triggerId === "weekly") {
    const time = parseTaskTime(task.time)
    if (!time) return null
    if (!Number.isInteger(task.interval) || task.interval < 1) return null
    const stepDays = (task.triggerId === "weekly" ? 7 : 1) * task.interval
    if (previousScheduledFor !== undefined && previousScheduledFor !== null) {
      return nextDailyAfterPrevious(previousScheduledFor, after, time.hour, time.minute, stepDays, timeZone)
    }
    return nextDailyInitial(after, time.hour, time.minute, timeZone)
  }
  if (task.triggerId === "cron") {
    const base = Math.max(after, previousScheduledFor ?? 0)
    return nextCronAt(task.cron, base, timeZone)
  }
  return null
}
