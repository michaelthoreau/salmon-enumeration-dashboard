// Fixed reference point — offset computation must be deterministic on server and client
const REF = new Date('2026-01-15T12:00:00.000Z')

function tzOffsetLabel(tz: string): string {
  // en-CA gives a stable "YYYY-MM-DD, HH:MM" format across all environments
  const s = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(REF)
  const [datePart, timePart] = s.split(', ')
  const [y, mo, d] = datePart.split('-').map(Number)
  const [h, mi] = timePart.split(':').map(Number)
  const diff = Math.round((Date.UTC(y, mo - 1, d, h, mi) - REF.getTime()) / 60000)
  const sign = diff >= 0 ? '+' : '-'
  const abs = Math.abs(diff)
  const hh = String(Math.floor(abs / 60)).padStart(2, '0')
  const mm = String(abs % 60).padStart(2, '0')
  return `UTC${sign}${hh}:${mm}`
}

export const TIMEZONE_OPTIONS = Intl.supportedValuesOf('timeZone').map((tz) => ({
  value: tz,
  label: `${tz} (${tzOffsetLabel(tz)})`,
}))
