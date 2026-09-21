/**
 * CLI: reconciliacao Sistema Financeiro x Shopify, por pedido.
 *
 * Wrapper fino sobre src/features/integration/shopify-reconciliation.ts — a
 * mesma logica que a rota /api/internal/cron/shopify-verify executa todo dia as
 * 10:50 BRT. Este arquivo so cuida de parse de args e formatacao de saida.
 *
 * Dois modos:
 *
 *   --listar   (padrao) so LE a tabela de divergencias. Nao fala com a Shopify,
 *              nao escreve nada. E o "relatorio" para tratamento.
 *   --rodar    executa a reconciliacao: detecta, grava e CORRIGE, re-resolvendo
 *              o pedido contra a Admin API.
 *
 * Uso:
 *   npx tsx scripts/reconcile-shopify.ts [--status=pendente] [--limit=100] [--json]
 *   npx tsx scripts/reconcile-shopify.ts --rodar [--date=YYYY-MM-DD] [--days=3]
 *     [--max-fixes=60] [--json]
 *
 * Sem --date, `--rodar` usa D-1 em America/Bahia, como o cron.
 *
 * ATENCAO: `--rodar` sem `--date` reconcilia D-1 sem checar maturidade — o cron
 * passa esse sinal porque acabou de calcula-lo, e aqui nao ha de onde tira-lo
 * barato. Rodar a mao antes de a fila do dia drenar produz correcoes contra
 * pedidos que iam fechar sozinhos. Na duvida, rode depois das 11:00 BRT.
 */

import dotenv from "dotenv";

import {
  MAX_RETRY_ATTEMPTS,
  runShopifyReconciliation,
  type ReconciliationSummary,
} from "../src/features/integration/shopify-reconciliation";
import {
  closeShopifyReconciliationPool,
  countDivergencesByStatus,
  ensureShopifyReconciliationTable,
  listDivergences,
  type ReconciliationDivergenceRow,
  type ReconciliationStatus,
} from "../src/features/integration/shopify-reconciliation-repository";

dotenv.config();

const STATUS_VALIDOS: ReconciliationStatus[] = [
  "pendente",
  "corrigido",
  "persistente",
  "sem_correcao",
];

type Args = {
  rodar: boolean;
  dryRun: boolean;
  json: boolean;
  status?: ReconciliationStatus;
  limit: number;
  date?: string;
  days?: number;
  maxFixes?: number;
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await ensureShopifyReconciliationTable();

  if (args.rodar || args.dryRun) {
    const summary = await runShopifyReconciliation({
      endDate: args.date,
      days: args.days,
      maxFixes: args.maxFixes,
      dryRun: args.dryRun,
    });

    if (args.json) console.log(JSON.stringify(summary, null, 2));
    else imprimirResumo(summary);

    // Exit 1 quando sobrou coisa para tratar: permite encadear em script.
    process.exitCode = summary.stillDiverging > 0 || summary.failed > 0 ? 1 : 0;
    return;
  }

  const [linhas, contagem] = await Promise.all([
    listDivergences({ status: args.status, limit: args.limit }),
    countDivergencesByStatus(),
  ]);

  if (args.json) {
    console.log(JSON.stringify({ contagem, divergencias: linhas }, null, 2));
  } else {
    imprimirLista(linhas, contagem);
  }
}

function imprimirResumo(summary: ReconciliationSummary) {
  console.log("\nReconciliacao Sistema Financeiro x Shopify");
  if (summary.dryRun) console.log("MODO INSPECAO — nada foi gravado nem corrigido.");
  console.log(`Dias varridos:        ${summary.days.join(", ") || "(nenhum)"}`);
  if (summary.skippedImmatureDay) {
    console.log(`Adiado (imaturo):     ${summary.skippedImmatureDay}`);
  }
  console.log(`Pedidos comparados:   ${summary.comparedOrders}`);
  console.log(`Divergencias na janela: ${summary.detected} (${summary.driftFormatted})`);
  // A fila inclui o que sobrou de rodadas anteriores, entao pode ser maior que
  // a deteccao da janela — e a diferenca e' justamente a divida acumulada.
  console.log(`Fila elegivel:        ${summary.queued}`);
  console.log(`  corrigidas:         ${summary.corrected}`);
  console.log(`  ainda divergindo:   ${summary.stillDiverging}`);
  console.log(`  falharam:           ${summary.failed}`);
  console.log(`  esgotaram (gente):  ${summary.exhausted}`);
  console.log(`  adiadas pelo teto:  ${summary.deferred}`);
  console.log("\nAcumulado por status:");
  for (const status of STATUS_VALIDOS) {
    console.log(`  ${status.padEnd(14)} ${summary.byStatus[status]}`);
  }

  if (summary.sample && summary.sample.length > 0) {
    console.log("\nPedidos que divergem (maior desvio primeiro):\n");
    console.log(
      ["pedido".padEnd(16), "shopify".padStart(13), "ledger".padStart(13), "delta".padStart(13)].join(
        " "
      )
    );
    console.log("-".repeat(58));
    for (const item of summary.sample) {
      console.log(
        [
          item.orderId.padEnd(16),
          dinheiro(item.tenderCents).padStart(13),
          dinheiro(item.ledgerCents).padStart(13),
          dinheiro(item.deltaCents).padStart(13),
        ].join(" ")
      );
    }
  }
  console.log("");
}

function imprimirLista(
  linhas: ReconciliationDivergenceRow[],
  contagem: Record<ReconciliationStatus, number>
) {
  console.log("\nAcumulado por status:");
  for (const status of STATUS_VALIDOS) {
    console.log(`  ${status.padEnd(14)} ${contagem[status]}`);
  }

  if (linhas.length === 0) {
    console.log("\nNenhuma divergencia registrada para o filtro pedido.\n");
    return;
  }

  console.log(`\n${linhas.length} divergencia(s):\n`);
  console.log(
    [
      "dia".padEnd(11),
      "pedido".padEnd(16),
      "status".padEnd(13),
      "delta".padStart(13),
      "ocor.",
      "tent.",
      "proxima tentativa",
    ].join(" ")
  );
  console.log("-".repeat(95));

  for (const linha of linhas) {
    console.log(
      [
        linha.day.padEnd(11),
        linha.externalOrderId.padEnd(16),
        linha.status.padEnd(13),
        dinheiro(linha.deltaCents).padStart(13),
        String(linha.occurrences).padEnd(5),
        String(linha.attempts).padEnd(5),
        proximaTentativa(linha),
      ].join(" ")
    );
  }
  console.log("");
}

/**
 * O que a coluna "proxima tentativa" deve dizer.
 *
 * Tres estados diferentes que um `next_attempt_at` nulo nao distingue sozinho, e
 * confundi-los na tela e' o que faz alguem esperar por um conserto que nao vem:
 * a linha ja fechou, a linha esgotou o orcamento e agora depende de gente, ou a
 * linha nunca foi agendada e entra na proxima rodada.
 */
function proximaTentativa(linha: ReconciliationDivergenceRow): string {
  if (linha.status === "corrigido") return "-";
  if (linha.attempts >= MAX_RETRY_ATTEMPTS) return "esgotada (precisa de gente)";
  return linha.nextAttemptAt ?? "na proxima rodada";
}

function dinheiro(cents: number): string {
  return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function parseArgs(argv: string[]): Args {
  const args: Args = { rodar: false, dryRun: false, json: false, limit: 100 };

  for (const arg of argv) {
    if (arg === "--rodar") args.rodar = true;
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--listar") args.rodar = false;
    else if (arg === "--json") args.json = true;
    else if (arg.startsWith("--status=")) {
      const valor = arg.slice("--status=".length);
      if (!STATUS_VALIDOS.includes(valor as ReconciliationStatus)) {
        throw new Error(`--status invalido: ${valor}. Use um de: ${STATUS_VALIDOS.join(", ")}`);
      }
      args.status = valor as ReconciliationStatus;
    } else if (arg.startsWith("--limit=")) args.limit = inteiro(arg, "--limit");
    else if (arg.startsWith("--days=")) args.days = inteiro(arg, "--days");
    else if (arg.startsWith("--max-fixes=")) args.maxFixes = inteiro(arg, "--max-fixes");
    else if (arg.startsWith("--date=")) {
      const valor = arg.slice("--date=".length);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(valor)) {
        throw new Error(`--date invalido: ${valor}. Use YYYY-MM-DD.`);
      }
      args.date = valor;
    } else {
      throw new Error(`Argumento desconhecido: ${arg}`);
    }
  }

  return args;
}

function inteiro(arg: string, nome: string): number {
  const valor = Number(arg.slice(arg.indexOf("=") + 1));
  if (!Number.isInteger(valor) || valor <= 0) {
    throw new Error(`${nome} deve ser um inteiro positivo.`);
  }
  return valor;
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeShopifyReconciliationPool();
  });
