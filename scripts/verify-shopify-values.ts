/**
 * CLI: Verificacao de valores — Sistema Financeiro vs Shopify (v1).
 *
 * Wrapper fino sobre src/features/integration/shopify-value-verification.ts
 * (logica de comparacao compartilhada com a rota /api/internal/cron/shopify-verify).
 * Este arquivo so cuida de parse de args e formatacao de saida (tabela/JSON/CSV).
 *
 * Uso:
 *   npx tsx scripts/verify-shopify-values.ts [--date=YYYY-MM-DD] [--json]
 *     [--csv=caminho.csv] [--tolerance-cents=1] [--concurrency=5]
 *
 * Sem --date, verifica o dia anterior em America/Bahia.
 */

import { writeFileSync } from "node:fs";

import dotenv from "dotenv";

import { buildVerificationReport, type VerificationReport } from "../src/features/integration/shopify-value-verification";

dotenv.config();

type Args = {
  date?: string;
  json: boolean;
  csv?: string;
  toleranceCents: number;
  concurrency: number;
};

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const report = await buildVerificationReport({
    date: args.date,
    toleranceCents: args.toleranceCents,
    concurrency: args.concurrency,
  });

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report);
  }

  if (args.csv) {
    writeCsv(args.csv, report);
    console.log(`\nCSV salvo em: ${args.csv}`);
  }

  const hasDivergence = report.metrics.some((metric) => metric.diverges);
  process.exitCode = hasDivergence ? 1 : 0;
}

function printReport(report: VerificationReport) {
  console.log(`Verificação de valores — Sistema Financeiro vs Shopify`);
  console.log(`Data: ${report.date} (${report.timezone})`);
  console.log(`Janela UTC: ${report.windowUtc.start} -> ${report.windowUtc.endExclusive}`);
  console.log("");

  console.table(
    report.metrics.map((metric) => ({
      Métrica: metric.label,
      "Sistema Financeiro": metric.financeiro,
      Shopify: metric.shopify,
      Diferença: metric.diff,
      "Diferença %": metric.diffPct,
      Status: metric.diverges ? "⚠ DIVERGÊNCIA" : "OK",
    }))
  );

  console.log("");
  console.log("Contexto de frescor de sincronização (mirror.raw_payloads / job de resolução de gateway):");
  console.log(`  Pedidos Shopify no mirror no dia: ${report.syncFreshness.mirrorOrders}`);
  console.log(`  Ainda sem resolução de gateway: ${report.syncFreshness.unresolvedOrders}`);
  if (report.syncFreshness.unresolvedOrders > 0) {
    console.log(
      "  Nota: pedidos sem resolução usam data heurística (processed_at/created_at do pedido) em vez da" +
        " data real do pagamento — pode causar pequena divergência de janela explicável."
    );
  }
  console.log(`  Pedidos candidatos consultados na Shopify (tenderTransactions): ${report.shopifyCandidateOrders}`);
  console.log("");
  console.log(
    `Maturidade do dia: ${report.maturity.hoursSinceWindowEnd.toFixed(1)}h desde o fim da janela, ` +
      `${(report.maturity.resolvedRatio * 100).toFixed(1)}% dos pedidos resolvidos ` +
      `(${report.maturity.isMature ? "dia maduro" : "ainda sincronizando"}).`
  );
}

function writeCsv(path: string, report: VerificationReport) {
  const header = "Metrica;Sistema Financeiro;Shopify;Diferenca;Diferenca %;Status";
  const rows = report.metrics.map((metric) =>
    [
      metric.label,
      metric.financeiro,
      metric.shopify,
      metric.diff,
      metric.diffPct,
      metric.diverges ? "DIVERGENCIA" : "OK",
    ].join(";")
  );
  writeFileSync(path, `﻿${[header, ...rows].join("\n")}\n`, "utf8");
}

function parseArgs(argv: string[]): Args {
  const parsed: Record<string, string | boolean> = {};
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [key, value] = arg.slice(2).split("=");
    parsed[key] = value ?? true;
  }

  return {
    date: typeof parsed.date === "string" ? parsed.date : undefined,
    json: Boolean(parsed.json),
    csv: typeof parsed.csv === "string" ? parsed.csv : undefined,
    toleranceCents: typeof parsed["tolerance-cents"] === "string" ? Number(parsed["tolerance-cents"]) : 1,
    concurrency: typeof parsed.concurrency === "string" ? Number(parsed.concurrency) : 5,
  };
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
