/**
 * Materializa uma janela de dias em integration.financial_orders.
 *
 * Existe porque uma carga de dezenas de dias e operacao pontual e nao cabe no
 * maxDuration da rota de cron, que processa um dia por invocacao. Mesmo
 * precedente de scripts/backfill-mirror-window.ts.
 *
 * Uso:
 *   npx tsx scripts/materialize-orders-window.ts <inicio> <fim>
 *   npx tsx scripts/materialize-orders-window.ts 2026-08-01 2026-08-21
 *   npx tsx scripts/materialize-orders-window.ts 2026-08-05
 *
 * Sequencial de proposito, um dia por vez: cada dia le o mirror com
 * payload_json, e paralelizar competiria pelas 2 conexoes do pool contra o mesmo
 * pooler que ja derrubou conexao nesta investigacao.
 *
 * Idempotente: reexecutar e seguro. O guard de content_hash faz a segunda
 * passada nao reescrever nada, entao `alteradas: 0` na repeticao e o resultado
 * CORRETO, nao falha.
 *
 * Variaveis de ambiente: CORE_DB_URL (ou DATABASE_URL como fallback).
 */

import "dotenv/config";

import { closePool } from "../src/features/transactions/financial-orders-repository";
import {
  materializeOrdersForDay,
  materializeOrdersForRange,
} from "../src/features/transactions/materialize-orders-job";

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function parseDay(value: string, rotulo: string): string {
  if (!DAY_PATTERN.test(value)) {
    throw new Error(`${rotulo} invalido: ${value} (esperado YYYY-MM-DD)`);
  }
  if (Number.isNaN(new Date(`${value}T00:00:00-03:00`).getTime())) {
    throw new Error(`${rotulo} inexistente no calendario: ${value}`);
  }
  return value;
}

/**
 * Expande o intervalo em dias de calendario.
 *
 * Caminha pelo meio-dia UTC e nao pela meia-noite: somar 24 h a partir da
 * meia-noite acumula erro em qualquer transicao de offset e produziria um dia
 * repetido ou faltando na lista. Com o meio-dia a margem e de 12 h.
 */
function expandDays(start: string, end: string): string[] {
  const days: string[] = [];
  const last = new Date(`${end}T12:00:00Z`).getTime();

  for (let cursor = new Date(`${start}T12:00:00Z`).getTime(); cursor <= last; cursor += 86_400_000) {
    days.push(new Date(cursor).toISOString().slice(0, 10));
  }

  if (days.length === 0) {
    throw new Error(`intervalo vazio: ${start} a ${end} (inicio depois do fim?)`);
  }

  return days;
}

async function main() {
  const args = process.argv.slice(2);
  const posicionais = args.filter((arg) => !arg.startsWith("--"));
  const start = parseDay(posicionais[0] ?? "", "inicio");
  const end = parseDay(posicionais[1] ?? posicionais[0] ?? "", "fim");

  // Uma passada sobre o intervalo inteiro. E o modo certo para carga inicial: a
  // folga de descoberta de +-2 dias faz cada invocacao por dia processar 5 dias,
  // entao 22 dias um a um leriam ~110 dias-equivalentes de evento. Medido: um
  // unico dia passou de 10 minutos.
  //
  // --por-dia forca o modo antigo, util quando um dia especifico precisa ser
  // reprocessado sozinho.
  if (!args.includes("--por-dia")) {
    // Retomada por indice de chave, para nao refazer horas de transferencia
    // depois de uma queda. O indice sai do campo `fromKey` do ultimo
    // materialize_orders_chunk que apareceu no log.
    const retomar = Number(args.find((a) => a.startsWith("--retomar="))?.split("=")[1] ?? 0);
    if (!Number.isInteger(retomar) || retomar < 0) {
      throw new Error(`--retomar invalido: precisa ser inteiro >= 0`);
    }

    console.log(
      `=== Materializacao em UMA passada: ${start} a ${end}` +
        (retomar > 0 ? ` (retomando da chave ${retomar})` : "")
    );
    const t0 = Date.now();
    try {
      const r = await materializeOrdersForRange(start, end, retomar);
      console.log(
        `chaves=${r.candidateKeys} pedidos_lidos=${r.dedupedOrders} pedidos=${r.mapped} ` +
          `alteradas=${r.written} apagadas=${r.deleted} ` +
          `em ${((Date.now() - t0) / 1000 / 60).toFixed(1)} min`
      );
      console.log(
        `nao viraram pedido: ` +
          Object.entries(r.rejections)
            .filter(([, quantas]) => quantas > 0)
            .map(([motivo, quantas]) => `${motivo}=${quantas}`)
            .join(" ") || "nenhum"
      );
    } finally {
      await closePool();
    }
    return;
  }

  const days = expandDays(start, end);

  console.log(`=== Materializacao dia a dia: ${days.length} dia(s), ${start} a ${end}`);

  const totals = { candidateKeys: 0, dedupedOrders: 0, mapped: 0, written: 0, deleted: 0 };
  const t0 = Date.now();

  try {
    for (const day of days) {
      const result = await materializeOrdersForDay(day);
      totals.candidateKeys += result.candidateKeys;
      totals.dedupedOrders += result.dedupedOrders;
      totals.mapped += result.mapped;
      totals.written += result.written;
      totals.deleted += result.deleted;

      console.log(
        `${day}  chaves=${result.candidateKeys}  lidos=${result.dedupedOrders}  ` +
          `pedidos=${result.mapped}  alteradas=${result.written}  apagadas=${result.deleted}  ` +
          `${(result.durationMs / 1000).toFixed(1)}s`
      );
    }

    console.log(
      `=== Total: chaves=${totals.candidateKeys} lidos=${totals.dedupedOrders} ` +
        `pedidos=${totals.mapped} alteradas=${totals.written} apagadas=${totals.deleted} ` +
        `em ${((Date.now() - t0) / 1000 / 60).toFixed(1)} min`
    );
  } finally {
    await closePool();
  }
}

main().catch((error) => {
  console.error("FALHOU:", error instanceof Error ? error.message : error);
  process.exit(1);
});
