import "dotenv/config";

import { runShopifyPaymentResolutionJob } from "../src/features/integration/shopify-payment-resolution-job";

/**
 * Roda o job de resolucao de gateway titular escopado aos pedidos mais
 * recentes (ultimos --days dias), em rodadas curtas e limitadas (--max-rounds),
 * em vez de esvaziar o backlog historico inteiro (~19 mil pedidos, ~40-50min).
 * Uso: npx tsx scripts/resolve-shopify-gateway-recent.ts --days=3 --batch=50
 */

type Args = { days: number; batch: number; maxRounds: number };

function parseArgs(argv: string[]): Args {
  const parsed: Record<string, string> = {};
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [key, value] = arg.slice(2).split("=");
    if (value) parsed[key] = value;
  }
  return {
    days: Number(parsed.days ?? 3),
    batch: Number(parsed.batch ?? 50),
    maxRounds: Number(parsed["max-rounds"] ?? 6),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sinceReceivedAt = new Date();
  sinceReceivedAt.setDate(sinceReceivedAt.getDate() - args.days);

  console.log(
    `Resolvendo gateway titular para pedidos recebidos a partir de ${sinceReceivedAt.toISOString()} ` +
      `(lote=${args.batch}, max ${args.maxRounds} rodadas)`
  );

  for (let round = 1; round <= args.maxRounds; round++) {
    const start = Date.now();
    const summary = await runShopifyPaymentResolutionJob(args.batch, sinceReceivedAt);
    const elapsedMs = Date.now() - start;

    console.log(
      `Rodada ${round}: candidatos=${summary.candidates} resolvidos=${summary.resolved} ` +
        `pulados=${summary.skipped} falhas=${summary.failed} (${elapsedMs}ms)`
    );

    if (summary.candidates === 0) {
      console.log("Nenhum pedido pendente na janela — concluido.");
      return;
    }
  }

  console.log(
    `Limite de ${args.maxRounds} rodadas atingido — ainda pode haver pedidos pendentes na janela de ${args.days} dias. ` +
      "Rode o script de novo para continuar de onde parou (idempotente)."
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Falha ao rodar resolucao de gateway:", error);
    process.exit(1);
  });
