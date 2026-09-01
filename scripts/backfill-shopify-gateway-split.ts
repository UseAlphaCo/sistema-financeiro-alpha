/**
 * Backfill do ledger de rateio por gateway
 * (integration.shopify_order_payment_gateway_split) para um periodo.
 *
 * Por que um script separado, e nao o job de sempre: o job so olha pedido AINDA
 * NAO resolvido (findUnresolvedShopifyOrders — `spr IS NULL OR
 * mirror_updated_at > spr.resolved_at`). Todos os pedidos antigos ja tem
 * resolucao de gateway titular, entao o job passa direto por eles e o ledger
 * nasceria vazio para qualquer data anterior a este backfill. Ler o Fluxo de
 * Caixa por um ledger vazio exibiria a Shopify a menos — por isso a base de
 * pagamentos so liga com FINANCIAL_SHOPIFY_PAYMENTS_BASIS=true, depois de
 * rodar isto.
 *
 * Idempotente: reprocessar o mesmo periodo reescreve as mesmas linhas.
 *
 * Uso:
 *   npx tsx scripts/backfill-shopify-gateway-split.ts --from=2026-08-28 --to=2026-08-31
 *   npx tsx scripts/backfill-shopify-gateway-split.ts --date=2026-08-30 [--dry-run]
 *
 * Ritmo: ~2 pedidos/s (portao do bucket da Shopify em fetchShopifyOrderTransactions),
 * ou seja ~10 min por dia de movimento.
 */

import { readFileSync } from "node:fs";

import dotenv from "dotenv";

import {
  fetchShopifyOrderTransactions,
  resolveDominantPaymentMethod,
  resolvePaymentGatewaySplit,
} from "../src/features/integration/shopify-order-transactions";
import { normalizeShopifyStoreDomain, stripWrappingQuotes } from "../src/features/integration/shopify-orders-sync";
import {
  ensureShopifyPaymentGatewaySplitTable,
  ensureShopifyPaymentResolutionTable,
  replaceShopifyPaymentGatewaySplit,
  upsertShopifyPaymentResolution,
} from "../src/features/integration/shopify-payment-resolution-repository";
import { getCorePool, withConnectionRetry } from "../src/features/transactions/mirror-events-repository";
import { addDaysToDayKey, dayWindowUtc } from "../src/lib/date-utils";

dotenv.config();

const TIMEZONE = "America/Bahia";

type Args = { from: string; to: string; concurrency: number; dryRun: boolean; idsFile?: string };

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // Alarga um dia de cada lado: uma perna de pagamento pode cair dentro da
  // janela mesmo quando o pedido esta datado fora dela, e e a data da PERNA que
  // manda na leitura. Sem a folga, o primeiro e o ultimo dia sairiam incompletos.
  const inicio = dayWindowUtc(addDaysToDayKey(args.from, -1), TIMEZONE).start;
  const fim = dayWindowUtc(addDaysToDayKey(args.to, 1), TIMEZONE).end;

  console.log(`Backfill do rateio por gateway: ${args.from} a ${args.to}`);
  console.log(`Janela de busca (com folga de 1 dia): ${inicio.toISOString()} -> ${fim.toISOString()}`);

  // --ids-file reprocessa so uma lista (um id por linha): numa rodada de ~50 min
  // alguns pedidos falham por rede, e refazer os 3.900 por causa de 58 e
  // desperdicio. O log da rodada anterior ja tem os ids nas linhas "falha em".
  const pedidos = args.idsFile
    ? readFileSync(args.idsFile, "utf8")
        .split("\n")
        .map((linha) => linha.trim())
        .filter(Boolean)
    : await carregarPedidos(inicio, fim);

  console.log(
    args.idsFile
      ? `${pedidos.length} pedidos vindos de ${args.idsFile}.`
      : `${pedidos.length} pedidos Shopify na janela.`
  );

  if (args.dryRun) {
    console.log("--dry-run: nada foi escrito.");
    return;
  }

  const storeDomain = normalizeShopifyStoreDomain(process.env.SHOPIFY_STORE_URL ?? "");
  const accessToken = stripWrappingQuotes(process.env.SHOPIFY_ACCESS_TOKEN ?? "");
  if (!storeDomain) throw new Error("SHOPIFY_STORE_URL ausente ou invalido.");
  if (!accessToken) throw new Error("SHOPIFY_ACCESS_TOKEN ausente.");

  await ensureShopifyPaymentResolutionTable();
  await ensureShopifyPaymentGatewaySplitTable();

  let resolvidos = 0;
  let semTransacao = 0;
  let falhas = 0;
  let processados = 0;
  let index = 0;
  const inicioEm = Date.now();

  async function worker() {
    while (index < pedidos.length) {
      const externalOrderId = pedidos[index++];

      try {
        await comRetry(async () => {
          const transactions = await fetchShopifyOrderTransactions(storeDomain, accessToken, externalOrderId);
          const dominant = resolveDominantPaymentMethod(transactions);

          if (!dominant) {
            await upsertShopifyPaymentResolution({
              external_order_id: externalOrderId,
              dominant_gateway_raw: null,
              dominant_amount_cents: 0,
              total_amount_cents: 0,
              transaction_processed_at: null,
            });
            await replaceShopifyPaymentGatewaySplit(externalOrderId, []);
            semTransacao += 1;
          } else {
            await upsertShopifyPaymentResolution({
              external_order_id: externalOrderId,
              dominant_gateway_raw: dominant.gatewayRaw,
              dominant_amount_cents: dominant.dominantAmountCents,
              total_amount_cents: dominant.totalAmountCents,
              transaction_processed_at: dominant.processedAt,
            });
            await replaceShopifyPaymentGatewaySplit(externalOrderId, resolvePaymentGatewaySplit(transactions));
            resolvidos += 1;
          }
        });
      } catch (error) {
        falhas += 1;
        console.error(`  falha em ${externalOrderId}: ${error instanceof Error ? error.message : String(error)}`);
      }

      processados += 1;
      if (processados % 100 === 0) {
        const decorrido = (Date.now() - inicioEm) / 1000;
        const restante = ((pedidos.length - processados) * decorrido) / processados;
        console.log(
          `  ${processados}/${pedidos.length} (${decorrido.toFixed(0)}s decorridos, ~${restante.toFixed(0)}s restantes)`
        );
      }
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, args.concurrency) }, () => worker()));

  console.log(
    `\nConcluido: resolvidos=${resolvidos} sem_transacao=${semTransacao} falhas=${falhas} ` +
      `em ${((Date.now() - inicioEm) / 1000).toFixed(0)}s`
  );
  if (falhas > 0) {
    console.log("Rode de novo para reprocessar as falhas — o script e idempotente.");
    process.exitCode = 1;
  }
}

/**
 * Repete o trabalho de um pedido quando a falha e de rede, nao de dado.
 *
 * Numa rodada de ~40 min contra um Postgres remoto e a Admin API, alguns
 * ETIMEDOUT sao esperados. Sem isto cada um vira um pedido sem rateio, e a
 * unica saida seria rodar o script inteiro de novo por causa de meia duzia
 * deles.
 */
async function comRetry<T>(run: () => Promise<T>, tentativas = 3): Promise<T> {
  for (let tentativa = 1; ; tentativa++) {
    try {
      return await run();
    } catch (error) {
      const mensagem = error instanceof Error ? error.message : String(error);
      const transitoria = /ETIMEDOUT|ECONNRESET|Connection terminated|timeout exceeded|socket hang up/i.test(mensagem);
      if (!transitoria || tentativa >= tentativas) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1_000 * tentativa));
    }
  }
}

/**
 * Pedidos Shopify da janela: os que ja tem resolucao (datados pelo pagamento) e
 * os que ainda nao tem (datados pelo created_at do payload, que e o melhor
 * palpite disponivel antes de perguntar a Shopify).
 */
async function carregarPedidos(inicio: Date, fim: Date): Promise<string[]> {
  const pool = getCorePool();
  if (!pool) throw new Error("CORE_DB_URL ausente.");

  const result = await withConnectionRetry(() =>
    pool.query<{ external_order_id: string }>(
      `
      SELECT DISTINCT rp.external_order_id
      FROM mirror.raw_payloads rp
      LEFT JOIN integration.shopify_order_payment_resolution spr
        ON spr.external_order_id = rp.external_order_id
      WHERE rp.source = 'shopify'
        AND rp.external_order_id IS NOT NULL
        AND rp.payload_json IS NOT NULL
        AND COALESCE(spr.transaction_processed_at, (rp.payload_json->>'created_at')::timestamptz) >= $1
        AND COALESCE(spr.transaction_processed_at, (rp.payload_json->>'created_at')::timestamptz) < $2
      ORDER BY rp.external_order_id
      `,
      [inicio, fim]
    )
  );

  return result.rows.map((row) => row.external_order_id);
}

function parseArgs(argv: string[]): Args {
  const parsed: Record<string, string | boolean> = {};
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [key, value] = arg.slice(2).split("=");
    parsed[key] = value ?? true;
  }

  const date = typeof parsed.date === "string" ? parsed.date : undefined;
  const from = typeof parsed.from === "string" ? parsed.from : date;
  const to = typeof parsed.to === "string" ? parsed.to : date;

  if (!from || !to) throw new Error("Informe --date=YYYY-MM-DD ou --from=... --to=...");
  for (const value of [from, to]) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`data invalida: ${value}`);
  }
  if (from > to) throw new Error(`--from (${from}) e posterior a --to (${to}).`);

  return {
    from,
    to,
    concurrency: typeof parsed.concurrency === "string" ? Number(parsed.concurrency) : 5,
    dryRun: Boolean(parsed["dry-run"]),
    idsFile: typeof parsed["ids-file"] === "string" ? parsed["ids-file"] : undefined,
  };
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
