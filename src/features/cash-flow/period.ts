import {
  endOfZonedDay,
  getDateRangeForPeriod,
  getDateRangeForPreset,
  startOfZonedDay,
  zonedDayKey,
} from "@/lib/date-utils";
import type { CashFlowFilters } from "@/features/cash-flow/types";

/**
 * Semantica de periodo das telas Marketplaces e Fluxo de Caixa.
 *
 * Mora fora de service.ts para que a tela de lancamentos (entries-service.ts)
 * use a mesma definicao de "periodo" e "periodo anterior" sem importar o grafo
 * service.ts -> read-model.ts -> mirror (pool pg de 2 conexoes). Dois donos
 * para essa regra e como nasce divergencia de numero entre telas.
 */

/**
 * Fronteira do filtro de data, sempre no dia de calendario de Brasilia.
 *
 * Construia a data com `new Date(ano, mes, dia)` + `setHours`, que resolve no
 * fuso do processo -- correto na maquina local, deslocado em 3 h na Vercel
 * (UTC). Ver o cabecalho de src/lib/date-utils.ts.
 *
 * Aceita as duas formas que o schema de actions.ts permite: `YYYY-MM-DD` e ISO
 * completo. O caminho ISO existia so no papel -- `"2026-08-24T00:00:00Z"` caia
 * em `Number("24T00:00:00Z")` = NaN e a funcao lancava.
 */
function parseLocalIsoDate(date: string, endOfDay = false): Date {
  const dayKey = /^\d{4}-\d{2}-\d{2}$/.test(date)
    ? date
    : (() => {
        const instant = new Date(date);
        if (Number.isNaN(instant.getTime())) {
          throw new Error(`invalid local date filter: ${date}`);
        }
        return zonedDayKey(instant);
      })();

  const boundary = endOfDay ? endOfZonedDay(dayKey) : startOfZonedDay(dayKey);

  if (Number.isNaN(boundary.getTime())) {
    throw new Error(`invalid local date filter: ${date}`);
  }

  return boundary;
}

// Extraida para testabilidade sem depender de banco: se so uma das pontas do
// range vier preenchida (ex.: usuario preencheu so "Data inicial"), a busca
// deve usar aquele dia, e nao cair silenciosamente no preset (que defaultava
// para "yesterday" e ignorava a data digitada).
export function resolveCashFlowDateRange(
  filters: Pick<CashFlowFilters, "startDate" | "endDate" | "preset" | "days">,
  now: Date
): { start: Date; end: Date } {
  if (filters.startDate || filters.endDate) {
    return {
      start: parseLocalIsoDate(filters.startDate ?? filters.endDate!),
      end: parseLocalIsoDate(filters.endDate ?? filters.startDate!, true),
    };
  }

  if (filters.preset) {
    return getDateRangeForPreset(filters.preset, now);
  }

  return getDateRangeForPeriod(filters.days ?? 30, now);
}
