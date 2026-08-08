import { CronExpressionParser } from 'cron-parser'
import { validateRotationCron } from './rotation-cron.js'

export type CronDescriptionLocale = 'en' | 'es'

const WEEKDAYS: Record<CronDescriptionLocale, string[]> = {
  en: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
  es: ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'],
}
type CronFields = [string, string, string, string, string]

function numericField(value: string): number | null {
  return /^\d+$/.test(value) ? Number(value) : null
}

function ordinal(value: number): string {
  const suffix =
    value % 100 >= 11 && value % 100 <= 13
      ? 'th'
      : value % 10 === 1
        ? 'st'
        : value % 10 === 2
          ? 'nd'
          : value % 10 === 3
            ? 'rd'
            : 'th'
  return `${value}${suffix}`
}

function formatTime(minute: number, hour: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} UTC`
}

function describeMonthly(fields: CronFields, locale: CronDescriptionLocale): string | null {
  const [minute, hour, dayOfMonth, month, weekday] = fields
  const dayNumber = numericField(dayOfMonth)
  if (dayNumber === null || month !== '*' || weekday !== '*') return null
  if (hour === '0' && minute === '0') {
    return locale === 'es'
      ? `Cada ${ordinal(dayNumber)} día del mes`
      : `Every ${ordinal(dayNumber)} day of the month`
  }
  const minuteNumber = numericField(minute)
  const hourNumber = numericField(hour)
  if (minuteNumber === null || hourNumber === null) return null
  return locale === 'es'
    ? `Cada ${ordinal(dayNumber)} día del mes a las ${formatTime(minuteNumber, hourNumber)}`
    : `Every ${ordinal(dayNumber)} day of the month at ${formatTime(minuteNumber, hourNumber)}`
}

function describeHourly(fields: CronFields, locale: CronDescriptionLocale): string | null {
  const [minute, hour, dayOfMonth, month, weekday] = fields
  if (minute === '0' && hour === '*' && dayOfMonth === '*' && month === '*' && weekday === '*') {
    return locale === 'es' ? 'Cada hora en el minuto 0' : 'Every hour at minute 0'
  }
  return null
}

function describeDaily(fields: CronFields, locale: CronDescriptionLocale): string | null {
  const [minute, hour, dayOfMonth, month, weekday] = fields
  const minuteNumber = numericField(minute)
  const hourNumber = numericField(hour)
  if (
    minuteNumber === null ||
    hourNumber === null ||
    dayOfMonth !== '*' ||
    month !== '*' ||
    weekday !== '*'
  ) {
    return null
  }
  return locale === 'es'
    ? `Cada día a las ${formatTime(minuteNumber, hourNumber)}`
    : `Every day at ${formatTime(minuteNumber, hourNumber)}`
}

function describeWeekly(fields: CronFields, locale: CronDescriptionLocale): string | null {
  const [minute, hour, dayOfMonth, month, weekday] = fields
  const minuteNumber = numericField(minute)
  const hourNumber = numericField(hour)
  const weekdayNumber = numericField(weekday)
  if (
    minuteNumber === null ||
    hourNumber === null ||
    dayOfMonth !== '*' ||
    month !== '*' ||
    weekdayNumber === null
  ) {
    return null
  }
  return locale === 'es'
    ? `Cada ${WEEKDAYS.es[weekdayNumber % 7]} a las ${formatTime(minuteNumber, hourNumber)}`
    : `Every ${WEEKDAYS.en[weekdayNumber % 7]} at ${formatTime(minuteNumber, hourNumber)}`
}

function parseCronFields(expr: string): CronFields | null {
  const cronFields = expr.trim().split(/\s+/)
  if (cronFields.length !== 5) return null
  try {
    CronExpressionParser.parse(expr, { tz: 'UTC' })
    return cronFields as CronFields
  } catch {
    return null
  }
}

function describeParsedCron(fields: CronFields, locale: CronDescriptionLocale): string {
  for (const describe of [describeMonthly, describeHourly, describeDaily, describeWeekly]) {
    const result = describe(fields, locale)
    if (result) return result
  }
  return locale === 'es' ? 'Programación personalizada' : 'Custom schedule'
}

function describeCron(expr: string, locale: CronDescriptionLocale): string | null {
  const fields = parseCronFields(expr)
  if (!fields) return null
  return describeParsedCron(fields, locale)
}

/** Returns a concise, human-readable interpretation for a validated five-field rotation cron. */
export function describeRotationCron(
  expr: string,
  locale: CronDescriptionLocale = 'en'
): string | null {
  if (!validateRotationCron(expr).ok) return null
  return describeCron(expr, locale)
}

/** Returns an interpretation for a syntactically valid backup cron, including sub-hour schedules. */
export function describeBackupCron(
  expr: string,
  locale: CronDescriptionLocale = 'en'
): string | null {
  return describeCron(expr, locale)
}
