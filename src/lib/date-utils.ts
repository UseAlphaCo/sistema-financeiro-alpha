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

export const PERIOD_PRESETS = [
  "yesterday",
  "today",
  "d7",
  "d30",
  "d60",
  "d90",
] as const;

export type PeriodPreset = (typeof PERIOD_PRESETS)[number];

export function getDateRangeForPreset(preset: PeriodPreset, now = new Date()) {
  if (preset === "today") {
    return {
      start: normalizeToStartOfDay(now),
      end: normalizeToEndOfDay(now),
      days: 1,
    };
  }

  if (preset === "yesterday") {
    const base = new Date(now);
    base.setDate(base.getDate() - 1);
    return {
      start: normalizeToStartOfDay(base),
      end: normalizeToEndOfDay(base),
      days: 1,
    };
  }

  const days = preset === "d7" ? 7 : preset === "d30" ? 30 : preset === "d60" ? 60 : 90;
  const range = getDateRangeForPeriod(days, now);
  return { ...range, days };
}

export function getPreviousPeriodRange(start: Date, days: number) {
  const prevEnd = new Date(start);
  prevEnd.setDate(prevEnd.getDate() - 1);
  const end = normalizeToEndOfDay(prevEnd);
  const prevStart = new Date(end);
  prevStart.setDate(prevStart.getDate() - Math.max(days - 1, 0));
  return { start: normalizeToStartOfDay(prevStart), end };
}
