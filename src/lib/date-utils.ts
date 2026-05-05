export function normalizeToStartOfDay(date: Date) {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

export function normalizeToEndOfDay(date: Date) {
  const copy = new Date(date);
  copy.setHours(23, 59, 59, 999);
  return copy;
}

export function getDateRangeForPeriod(days: number, now = new Date()) {
  const end = normalizeToEndOfDay(now);
  const start = new Date(end);
  start.setDate(start.getDate() - Math.max(days - 1, 0));
  return { start: normalizeToStartOfDay(start), end };
}

export function getPreviousPeriodRange(start: Date, days: number) {
  const prevEnd = new Date(start);
  prevEnd.setDate(prevEnd.getDate() - 1);
  const end = normalizeToEndOfDay(prevEnd);
  const prevStart = new Date(end);
  prevStart.setDate(prevStart.getDate() - Math.max(days - 1, 0));
  return { start: normalizeToStartOfDay(prevStart), end };
}
