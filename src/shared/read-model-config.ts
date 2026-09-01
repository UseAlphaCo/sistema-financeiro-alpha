/**
 * Configuracao unica para decidir se o read model deve ler o mirror do CORE
 * (mirror.raw_payloads) em vez da tabela legada FinancialTransaction.
 *
 * Antes desta unificacao, existiam 2 condicoes divergentes no codebase:
 * - dependente de NODE_ENV === "production" (quebrava em dev local mesmo com
 *   CORE_DB_URL configurado).
 * - dependente apenas de Boolean(CORE_DB_URL) (nao tratava string vazia).
 *
 * Regra unica: mirror fica ligado sempre que houver uma connection string
 * valida (nao vazia) para o CORE, a menos que FINANCIAL_READ_MODEL_MIRROR
 * esteja explicitamente como "false".
 */

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function getCoreConnectionString(): string | undefined {
  return nonEmpty(process.env.CORE_DB_URL) ?? nonEmpty(process.env.DATABASE_URL);
}

export function isMirrorReadModelEnabled(): boolean {
  const hasCoreConnection = Boolean(getCoreConnectionString());
  const mirrorFlag = process.env.FINANCIAL_READ_MODEL_MIRROR;

  return hasCoreConnection && mirrorFlag !== "false";
}

/**
 * Le pela tabela materializada (integration.financial_orders) em vez de varrer
 * o mirror a cada request.
 *
 * Default LIGADO desde 26/08/2026. Nasceu desligado (`=== "true"`) porque com os
 * dois caminhos coexistindo, ligar por omissao trocaria a fonte de verdade das
 * telas sem ninguem decidir isso. A decisao foi tomada: a convergencia foi
 * medida (zero divergencia em campo financeiro sobre 3.145 chaves) e varrer
 * mirror.raw_payloads a cada visita e o que estourou a cota de Fluid Active CPU
 * da Vercel.
 *
 * O default importa mais que a variavel: e ele que vale num ambiente onde
 * ninguem lembrou de configurar nada. Deixar o caminho caro como padrao faria
 * de um esquecimento no painel um incidente de cota.
 *
 * `!== "false"` permite voltar ao mirror ao vivo sem redeploy, se a
 * materializacao parar e a defasagem passar do tolerável.
 */
export function isMaterializedReadModelEnabled(): boolean {
  return (
    Boolean(getCoreConnectionString()) &&
    process.env.FINANCIAL_READ_MODEL_MATERIALIZED !== "false"
  );
}

/**
 * Troca a base da Shopify de "pedidos pagos" para "pagamentos processados".
 *
 * Ligado, a linha Shopify do Fluxo de Caixa passa a vir do ledger de rateio
 * (integration.shopify_order_payment_gateway_split): cada perna do pagamento
 * com o seu proprio valor e a sua propria data, que e como a Shopify monta o
 * relatorio "Pagamentos brutos por gateway". Medido em 30/08/2026, e a
 * diferenca entre R$ 178.925,88 (pedidos) e R$ 181.332,81 (pagamentos).
 *
 * Nasce DESLIGADO de proposito, e o default e' o que importa. O ledger so
 * cobre as datas em que o job de resolucao ja rodou com o codigo novo; ligar
 * por omissao faria toda data anterior ao backfill exibir a Shopify a menos —
 * ou pior, exibir zero, que na tela se le como "nao vendemos nada". Ligue
 * depois de conferir a cobertura do periodo que interessa.
 *
 * Trocar de base muda o significado do numero: um pedido ainda nao fechado
 * passa a contar se o pagamento ja foi processado, e um pedido pago em duas
 * datas aparece partido entre os dois dias. A linha Shopify deixa de ser
 * comparavel com as dos outros marketplaces, que seguem na base de pedidos.
 */
export function isShopifyPaymentsBasisEnabled(): boolean {
  return (
    Boolean(getCoreConnectionString()) &&
    process.env.FINANCIAL_SHOPIFY_PAYMENTS_BASIS === "true"
  );
}

/**
 * Data a partir da qual existe dado. Antes disto as telas nao tem o que mostrar.
 *
 * Nao e preferencia de produto: em 2026-08-21 o mirror foi truncado de proposito
 * e as 604.418 linhas de 26/04 a 31/07 sairam. A tabela legada
 * FinancialTransaction tem zero linhas, entao para qualquer periodo anterior ao
 * piso as duas fontes devolvem vazio -- e vazio na tela le-se como "nao vendeu
 * nada", nao como "nao temos esse dado". E essa confusao que o piso existe para
 * impedir.
 *
 * Mesmo valor e mesmo nome de variavel do piso do sync
 * (SYNC_MIRROR_FLOOR_AT em src/workers/sync/config.ts): dois pisos diferentes
 * fariam a tela prometer uma janela que o sync nao mantem.
 *
 * Devolve null se a variavel estiver com valor invalido -- e "sem piso
 * conhecido", que a camada de cobertura trata como "nao anotar nada", em vez de
 * um NaN que faria toda comparacao de data ser falsa em silencio.
 */
export function getMaterializedFloorDate(): Date | null {
  const raw = nonEmpty(process.env.SYNC_MIRROR_FLOOR_AT) ?? "2026-08-01T00:00:00-03:00";
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
