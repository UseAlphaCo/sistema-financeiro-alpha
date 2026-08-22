/**
 * Compara os dois caminhos do read model financeiro: mirror (varredura em
 * memoria) contra integration.financial_orders (materializada).
 *
 * Roda a mesma matriz de filtros nos dois e classifica cada divergencia. E a
 * evidencia que autoriza ligar FINANCIAL_READ_MODEL_MATERIALIZED em producao --
 * sem ela, "os numeros batem" seria impressao.
 *
 * CRITERIO DE CORTE: zero divergencias INEXPLICADAS, e nao zero divergencias.
 *
 * "Zero divergencias" e inalcancavel como o plano escreveu, e a diferenca nao e
 * defeito da materializacao. O caminho legado pre-filtra o mirror por
 * received_at com uma folga (RECEIVED_AT_GRACE_MS, 21 dias) e SO ENTAO dedupa:
 * ou seja, o vencedor do dedup depende da janela consultada. A materializacao
 * dedupa sobre todos os eventos da chave, sempre. Onde os dois discordam por
 * esse motivo, o materializado esta CERTO -- e um pedido cujo evento mais
 * recente ficou fora da janela nao deveria mudar de valor so porque alguem
 * consultou um periodo mais curto.
 *
 * Uso:
 *   npx tsx scripts/compare-read-model.ts <inicio> <fim>
 *   npx tsx scripts/compare-read-model.ts 2026-08-01 2026-08-20
 *
 * Nao escreve nada. Duas leituras por combinacao de filtro.
 */

import "dotenv/config";

import { closePool } from "../src/features/transactions/financial-orders-repository";
import {
  listFinancialReadModelTransactions,
  listMarketplaceReadModelPaginated,
} from "../src/features/transactions/read-model";
import type { FinancialTransaction } from "../src/features/transactions/types";

/** Mesma folga do pre-filtro de received_at do caminho legado. */
const RECEIVED_AT_GRACE_MS = 21 * 24 * 60 * 60 * 1000;

const FLAG = "FINANCIAL_READ_MODEL_MATERIALIZED";

type Caso = {
  nome: string;
  marketplace?: string;
  paymentMethod?: "pix" | "credit_card" | "boleto";
  search?: string;
};

const CASOS: Caso[] = [
  { nome: "sem filtro" },
  { nome: "marketplace=shopify", marketplace: "shopify" },
  { nome: "marketplace=anymarket", marketplace: "anymarket" },
  { nome: "marketplace=mercado_livre", marketplace: "mercado_livre" },
  { nome: "pagamento=pix", paymentMethod: "pix" },
  { nome: "pagamento=credit_card", paymentMethod: "credit_card" },
  { nome: "pagamento=boleto", paymentMethod: "boleto" },
  { nome: "busca=pedido", search: "pedido" },
  // Curinga literal: no legado `%` e caractere comum (String.includes). Se o
  // materializado nao escapar, este caso divergir.
  { nome: "busca=50%", search: "50%" },
];

/** Roda uma funcao com a flag num estado definido, e restaura depois. */
async function comFlag<T>(ligada: boolean, run: () => Promise<T>): Promise<T> {
  const anterior = process.env[FLAG];
  process.env[FLAG] = ligada ? "true" : "false";
  try {
    return await run();
  } finally {
    if (anterior === undefined) delete process.env[FLAG];
    else process.env[FLAG] = anterior;
  }
}

function chave(item: FinancialTransaction): string {
  return `${item.externalSource}:${item.externalId ?? item.id}`;
}

function somaCentavos(items: FinancialTransaction[]): number {
  return items.reduce((total, item) => total + item.amountCents, 0);
}

type Divergencia = {
  chave: string;
  lado: "so_no_legado" | "so_no_materializado" | "valor_diferente";
  detalhe: string;
  classe: string | null;
};

/**
 * Classifica uma divergencia numa causa conhecida, ou devolve null.
 *
 * Null e o que importa: e o que conta para o critério de corte. Classificar
 * demais transformaria o comparador em maquina de justificar qualquer numero.
 */
function classificar(
  divergencia: Omit<Divergencia, "classe">,
  materializado: FinancialTransaction | undefined,
  inicio: Date,
  fim: Date
): string | null {
  if (divergencia.lado === "so_no_materializado" && materializado) {
    const recebido = new Date(materializado.createdAt).getTime();
    const tetoLegado = Math.min(fim.getTime() + RECEIVED_AT_GRACE_MS, Date.now());

    if (recebido < inicio.getTime() || recebido > tetoLegado) {
      // O legado nunca leu a linha: o pre-filtro por received_at a exclui, mesmo
      // com occurred_at dentro do periodo. O materializado esta certo.
      return "pre-filtro received_at do legado";
    }
  }

  return null;
}

async function compararCaso(caso: Caso, inicio: Date, fim: Date): Promise<Divergencia[]> {
  const filtros = {
    type: "income" as const,
    sources: ["integration", "webhook"] as ("integration" | "webhook")[],
    marketplace: caso.marketplace,
    paymentMethod: caso.paymentMethod,
    search: caso.search,
    startDate: inicio.toISOString(),
    endDate: fim.toISOString(),
  };

  const legado = await comFlag(false, () => listFinancialReadModelTransactions(filtros));
  const materializado = await comFlag(true, () => listFinancialReadModelTransactions(filtros));

  const porChaveLegado = new Map(legado.map((item) => [chave(item), item]));
  const porChaveMaterializado = new Map(materializado.map((item) => [chave(item), item]));

  const divergencias: Divergencia[] = [];

  for (const [k, item] of porChaveLegado) {
    const par = porChaveMaterializado.get(k);
    if (!par) {
      const base = {
        chave: k,
        lado: "so_no_legado" as const,
        detalhe: `${item.occurredAt} ${(item.amountCents / 100).toFixed(2)}`,
      };
      divergencias.push({ ...base, classe: classificar(base, undefined, inicio, fim) });
      continue;
    }

    if (par.amountCents !== item.amountCents || par.occurredAt !== item.occurredAt) {
      const base = {
        chave: k,
        lado: "valor_diferente" as const,
        detalhe:
          `legado ${item.occurredAt} ${(item.amountCents / 100).toFixed(2)} | ` +
          `materializado ${par.occurredAt} ${(par.amountCents / 100).toFixed(2)}`,
      };
      divergencias.push({ ...base, classe: classificar(base, par, inicio, fim) });
    }
  }

  for (const [k, item] of porChaveMaterializado) {
    if (porChaveLegado.has(k)) continue;
    const base = {
      chave: k,
      lado: "so_no_materializado" as const,
      detalhe: `${item.occurredAt} ${(item.amountCents / 100).toFixed(2)}`,
    };
    divergencias.push({ ...base, classe: classificar(base, item, inicio, fim) });
  }

  const inexplicadas = divergencias.filter((d) => d.classe === null);

  console.log(
    `${caso.nome.padEnd(28)} legado=${String(legado.length).padStart(6)} ` +
      `materializado=${String(materializado.length).padStart(6)} ` +
      `soma_legado=${(somaCentavos(legado) / 100).toFixed(2).padStart(14)} ` +
      `soma_materializado=${(somaCentavos(materializado) / 100).toFixed(2).padStart(14)} ` +
      `divergencias=${divergencias.length} inexplicadas=${inexplicadas.length}`
  );

  return divergencias;
}

/** Confere que a paginacao real concorda com a paginacao em memoria. */
async function compararPaginacao(inicio: Date, fim: Date): Promise<number> {
  const filtros = {
    page: 1,
    limit: 20,
    startDate: inicio.toISOString(),
    endDate: fim.toISOString(),
  };

  const legado = await comFlag(false, () => listMarketplaceReadModelPaginated(filtros));
  const materializado = await comFlag(true, () => listMarketplaceReadModelPaginated(filtros));

  const iguais = legado.items.filter(
    (item, index) => chave(item) === chave(materializado.items[index] ?? item)
  ).length;

  console.log(
    `paginacao pagina 1        total_legado=${legado.pagination.total} ` +
      `total_materializado=${materializado.pagination.total} ` +
      `itens_na_mesma_posicao=${iguais}/${legado.items.length}`
  );

  return legado.items.length - iguais;
}

async function main() {
  const args = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
  const inicio = new Date(`${args[0] ?? "2026-08-01"}T00:00:00-03:00`);
  const fim = new Date(`${args[1] ?? "2026-08-20"}T23:59:59-03:00`);

  if (Number.isNaN(inicio.getTime()) || Number.isNaN(fim.getTime())) {
    throw new Error("datas invalidas (esperado YYYY-MM-DD YYYY-MM-DD)");
  }

  console.log(`=== Comparacao dos dois caminhos: ${args[0] ?? "2026-08-01"} a ${args[1] ?? "2026-08-20"}\n`);

  const todas: Divergencia[] = [];
  try {
    for (const caso of CASOS) {
      todas.push(...(await compararCaso(caso, inicio, fim)));
    }
    console.log("");
    await compararPaginacao(inicio, fim);
  } finally {
    await closePool();
  }

  const inexplicadas = todas.filter((d) => d.classe === null);
  const classificadas = todas.filter((d) => d.classe !== null);

  console.log(`\n=== ${todas.length} divergencias: ${classificadas.length} classificadas, ${inexplicadas.length} inexplicadas`);

  for (const [classe, quantas] of contarPorClasse(classificadas)) {
    console.log(`    ${classe}: ${quantas}`);
  }

  if (inexplicadas.length > 0) {
    console.log("\n=== INEXPLICADAS (o criterio de corte e zero):");
    for (const d of inexplicadas.slice(0, 40)) {
      console.log(`    ${d.lado.padEnd(22)} ${d.chave}  ${d.detalhe}`);
    }
    if (inexplicadas.length > 40) {
      console.log(`    ... e mais ${inexplicadas.length - 40}`);
    }
    process.exitCode = 1;
  }
}

function contarPorClasse(divergencias: Divergencia[]): Array<[string, number]> {
  const contagem = new Map<string, number>();
  for (const d of divergencias) {
    if (!d.classe) continue;
    contagem.set(d.classe, (contagem.get(d.classe) ?? 0) + 1);
  }
  return [...contagem.entries()].sort((a, b) => b[1] - a[1]);
}

main().catch((error) => {
  console.error("FALHOU:", error instanceof Error ? error.message : error);
  process.exit(1);
});
