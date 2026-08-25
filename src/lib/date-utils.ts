/**
 * Fronteiras de dia do sistema financeiro.
 *
 * REGRA: o fuso vai no literal, nunca na sessao nem no ambiente.
 *
 * Estas funcoes construiam `00:00`/`23:59:59.999` com `setHours`, que resolve no
 * fuso DO PROCESSO. Numa maquina em horario de Brasilia o resultado era certo;
 * no runtime da Vercel, que roda em UTC, o mesmo filtro de "24/08" consultava
 * 23/08 21:00 -> 24/08 20:59 em horario de Brasilia -- entravam 3 h do dia
 * anterior e saiam as 3 ultimas horas do dia. Medido em 2026-08-25 para a
 * origem Shopify: 1.622 pedidos / R$ 240.346,64 em UTC contra os 1.731 /
 * R$ 256.647,40 corretos.
 *
 * Pior que o erro em si: o sistema discordava de si mesmo. A materializacao ja
 * recorta o dia com `-03:00` literal (materialize-orders-job.ts), entao gravar
 * e ler usavam convencoes diferentes, com 3 h de diferenca.
 *
 * Corrigir por `TZ=America/Sao_Paulo` no ambiente esconderia o defeito em vez
 * de remove-lo: testes, scripts e dev local continuariam cada um no seu fuso.
 */

/** Fuso de referencia do negocio. Todo dia de calendario do sistema e este. */
export const BRAZIL_TIME_ZONE = "America/Sao_Paulo";

/**
 * Dia de calendario (YYYY-MM-DD) de um instante, no fuso pedido.
 *
 * `sv-SE` devolve exatamente YYYY-MM-DD. Mesma tecnica de `saoPauloDay` em
 * materialize-orders-job.ts -- de proposito, para as duas pontas concordarem.
 */
export function zonedDayKey(instant: Date, timeZone: string = BRAZIL_TIME_ZONE): string {
  return instant.toLocaleDateString("sv-SE", { timeZone });
}

/**
 * Soma dias a uma chave de dia, sem passar por fuso nenhum.
 *
 * Caminha em UTC sobre a string, e nao somando 24 h a um instante local: em
 * transicao de offset, somar 24 h produz um dia repetido ou faltando.
 */
export function addDaysToDayKey(dayKey: string, days: number): string {
  const base = new Date(`${dayKey}T00:00:00.000Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

/**
 * Instante UTC correspondente a uma data/hora local de um fuso.
 *
 * Mede o offset real do fuso naquela data via `Intl` em vez de assumir um valor
 * fixo -- por isso continua correto se o Brasil voltar a ter horario de verao.
 *
 * Vinda de shopify-value-verification.ts, que era o unico lugar do repo com
 * conversao de fuso generica e correta. Movida para ca para nao existir uma
 * quinta convencao de dia.
 */
export function zonedDateToUtc(date: string, time: string, timeZone: string): Date {
  const guess = new Date(`${date}T${time}.000Z`);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(guess);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const asIfUtc = Date.UTC(
    Number(value.year),
    Number(value.month) - 1,
    Number(value.day),
    Number(value.hour),
    Number(value.minute),
    Number(value.second)
  );
  const offset = asIfUtc - guess.getTime();
  return new Date(guess.getTime() - offset);
}

/** Primeiro instante do dia de calendario, no fuso pedido. */
export function startOfZonedDay(dayKey: string, timeZone: string = BRAZIL_TIME_ZONE): Date {
  return zonedDateToUtc(dayKey, "00:00:00", timeZone);
}

/**
 * Ultimo instante do dia (23:59:59.999 local).
 *
 * Calculado como "inicio do dia seguinte menos 1 ms" e nao fixando 23:59:59:
 * assim continua valendo em dia de transicao de offset, que nao tem 24 h.
 */
export function endOfZonedDay(dayKey: string, timeZone: string = BRAZIL_TIME_ZONE): Date {
  const nextStart = startOfZonedDay(addDaysToDayKey(dayKey, 1), timeZone);
  return new Date(nextStart.getTime() - 1);
}

/** Janela `[inicio, fim)` de um dia de calendario no fuso pedido. */
export function dayWindowUtc(date: string, timeZone: string): { start: Date; end: Date } {
  return {
    start: startOfZonedDay(date, timeZone),
    end: startOfZonedDay(addDaysToDayKey(date, 1), timeZone),
  };
}

export function normalizeToStartOfDay(date: Date) {
  return startOfZonedDay(zonedDayKey(date));
}

export function normalizeToEndOfDay(date: Date) {
  return endOfZonedDay(zonedDayKey(date));
}

export function getDateRangeForPeriod(days: number, now = new Date()) {
  const endKey = zonedDayKey(now);
  const startKey = addDaysToDayKey(endKey, -Math.max(days - 1, 0));
  return { start: startOfZonedDay(startKey), end: endOfZonedDay(endKey) };
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
    const key = zonedDayKey(now);
    return { start: startOfZonedDay(key), end: endOfZonedDay(key), days: 1 };
  }

  if (preset === "yesterday") {
    const key = addDaysToDayKey(zonedDayKey(now), -1);
    return { start: startOfZonedDay(key), end: endOfZonedDay(key), days: 1 };
  }

  const days = preset === "d7" ? 7 : preset === "d30" ? 30 : preset === "d60" ? 60 : 90;
  const range = getDateRangeForPeriod(days, now);
  return { ...range, days };
}

export function getPreviousPeriodRange(start: Date, days: number) {
  const endKey = addDaysToDayKey(zonedDayKey(start), -1);
  const startKey = addDaysToDayKey(endKey, -Math.max(days - 1, 0));
  return { start: startOfZonedDay(startKey), end: endOfZonedDay(endKey) };
}
