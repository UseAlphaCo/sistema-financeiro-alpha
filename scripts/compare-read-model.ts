/**
 * Compara os dois caminhos do read model financeiro: mirror (varredura em
 * memoria) contra integration.financial_orders (materializada).
 *
 * E a evidencia que autoriza ligar FINANCIAL_READ_MODEL_MATERIALIZED em
 * producao -- sem ela, "os numeros batem" seria impressao.
 *
 * ## Dois modos, e por que o padrao e o de chave
 *
 * `--janela` roda a comparacao pelas funcoes publicas nos dois estados da flag.
 * E a forma direta, e **nao e executavel desta maquina**: medido em 2026-08-22,
 * uma consulta de um unico dia pelo caminho legado falhou por statement timeout
 * apos 490 s. Estreitar a janela nao resolve, e esse e o achado -- o pre-filtro
 * do legado usa `received_at >= inicio AND received_at <= fim + 21 dias`
 * (RECEIVED_AT_GRACE_MS), entao uma janela de 90 minutos e alargada em 21 dias
 * de received_at e falha igual. So roda de onde a banda esta (mesma regiao do
 * banco).
 *
 * `--chave` (padrao) compara por AMOSTRA DE CHAVES e roda em qualquer lugar: os
 * eventos de um pedido sao buscados por `external_order_id = ANY(...)`, que e
 * Index Scan (500 chaves -> ~2.500 eventos em ~131 ms, medido), em vez de por
 * janela de data, que arrasta a tabela inteira.
 *
 * ## O que o modo chave compara, e o que ele deliberadamente NAO compara
 *
 * Compara, para cada chave amostrada:
 * 1. **Mapeamento e dedup** -- os eventos crus do mirror passam por
 *    `dedupeMirrorRows` + `mapMirrorRow` (as MESMAS funcoes do caminho legado) e
 *    o resultado e conferido campo a campo contra a linha materializada.
 * 2. **Omissao** -- chaves amostradas do lado do mirror que produzem pedido com
 *    occurredAt dentro do periodo e nao aparecem na materializada.
 * 3. **Paridade de filtro** -- para cada combinacao da matriz, o conjunto que a
 *    SQL da materializada devolve e conferido contra o que `filterTransactions`
 *    (o predicado em memoria do legado) aprova sobre as mesmas transacoes.
 * 4. **Paginacao** -- paginas 1 e 2 sem sobreposicao e na ordem do banco.
 *
 * NAO compara o pre-filtro por `received_at` do legado, de proposito. Ele e
 * defeito do legado, nao da materializacao: o vencedor do dedup passa a depender
 * da janela consultada, ou seja um pedido muda de valor porque alguem escolheu
 * um periodo mais curto. A materializacao dedupa sobre todos os eventos da
 * chave, sempre. Excluir o pre-filtro e comparar contra a semantica CORRETA do
 * legado, e nao contra o bug dele.
 *
 * Tambem nao compara `createdAt`/`updatedAt`: sao metadados fora do
 * `content_hash` (ver contentHashParts), entao podem legitimamente ficar para
 * tras sem que nada de financeiro tenha mudado.
 *
 * CRITERIO DE CORTE: zero divergencias inexplicadas.
 *
 * Uso:
 *   npx tsx scripts/compare-read-model.ts <inicio> <fim> [--amostra=N]
 *   npx tsx scripts/compare-read-model.ts 2026-08-01 2026-08-22
 *   npx tsx scripts/compare-read-model.ts --janela 2026-08-18T00:00:00-03:00 2026-08-18T02:00:00-03:00
 *
 * Nao escreve nada.
 */

import "dotenv/config";

import { closePool } from "../src/features/transactions/financial-orders-repository";
import {
  findCandidateOrderKeys,
  findMirrorRowsByOrderKeys,
  type CandidateOrderKey,
} from "../src/features/transactions/mirror-events-repository";
import { mapMirrorRow } from "../src/features/transactions/mirror-order-mapper";
import {
  filterTransactions,
  type ReadModelFilters,
} from "../src/features/transactions/read-model-filters";
import {
  listFinancialReadModelTransactions,
  listMarketplaceReadModelPaginated,
} from "../src/features/transactions/read-model";
import type { FinancialTransaction } from "../src/features/transactions/types";

/** Mesma folga do pre-filtro de received_at do caminho legado. */
const RECEIVED_AT_GRACE_MS = 21 * 24 * 60 * 60 * 1000;

/**
 * Folga de received_at ao descobrir chaves candidatas no mirror. Mesmos 2 dias
 * de cada lado que a materializacao usa: um evento que chega hoje pode pertencer
 * a um pedido de anteontem.
 */
const FOLGA_CANDIDATOS_MS = 2 * 24 * 60 * 60 * 1000;

/**
 * Chaves por consulta ao mirror. 500 rende ~2.500 eventos em ~131 ms (medido);
 * lote maior nao acelera e transforma a consulta em transferencia de centenas de
 * MB, porque cada evento carrega payload_json de 10 a 30 KB.
 */
const TAMANHO_LOTE_CHAVES = 500;

/** Chaves amostradas por lado (materializada e mirror). */
const AMOSTRA_PADRAO = 250;

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
  // materializado nao escapar, este caso diverge.
  { nome: "busca=50%", search: "50%" },
];

/**
 * Campos conferidos linha a linha.
 *
 * `createdAt`/`updatedAt` ficam de fora -- ver o cabecalho: sao metadados fora
 * do content_hash. Todo o resto entra, inclusive os campos que nenhuma tela
 * soma: divergencia em `description` ou `orderNumber` e sintoma de mapeamento
 * errado tanto quanto divergencia em centavos.
 */
const CAMPOS_COMPARADOS = [
  "id",
  "externalSource",
  "externalId",
  "marketplace",
  "orderNumber",
  "paymentMethodRaw",
  "paymentMethodNormalized",
  "amountCents",
  "shippingCents",
  "discountCents",
  "taxCents",
  "feeCents",
  "liquidCents",
  "currency",
  "occurredAt",
  "description",
  "source",
  "status",
  "type",
] as const satisfies ReadonlyArray<keyof FinancialTransaction>;

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

/**
 * Identidade de pedido, igual nos dois lados.
 *
 * E `source:order_key`, e nao `source:externalId`: quando `external_order_id` e
 * nulo o order_key vira o proprio id da linha do mirror -- e a materializada
 * grava `mirror_row_id = id`, entao `item.id` reproduz a mesma chave. Usar
 * externalId direto perderia esses pedidos dos dois lados, em silencio.
 */
function chave(item: FinancialTransaction): string {
  return `${item.externalSource}:${item.externalId ?? item.id}`;
}

function indexarPorChave(items: FinancialTransaction[]): Map<string, FinancialTransaction> {
  return new Map(items.map((item) => [chave(item), item] as const));
}

function chaveDeCandidato(candidato: CandidateOrderKey): string {
  return `${candidato.source}:${candidato.orderKey}`;
}

/** Transacao -> chave de busca no mirror, com o indice certo para cada forma. */
function candidatoDeTransacao(item: FinancialTransaction): CandidateOrderKey | null {
  if (!item.externalSource) return null;

  return item.externalId
    ? { source: item.externalSource, orderKey: item.externalId, isExternal: true }
    : { source: item.externalSource, orderKey: item.id, isExternal: false };
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

// ---------------------------------------------------------------------------
// Modo chave
// ---------------------------------------------------------------------------

/**
 * Amostra deterministica e estratificada por fonte.
 *
 * Deterministica de proposito: uma amostra aleatoria transformaria "rodei de
 * novo e nao deu divergencia" em informacao sem valor. Ordena por chave e pega
 * indices igualmente espacados, dentro de cada fonte -- shopify domina em
 * volume, e uma amostra global sortearia poucos pedidos anymarket, que e
 * justamente a fonte com mapeamento diferente.
 */
function amostrar(candidatos: CandidateOrderKey[], porFonte: number): CandidateOrderKey[] {
  const porSource = new Map<string, CandidateOrderKey[]>();
  for (const candidato of candidatos) {
    const lista = porSource.get(candidato.source) ?? [];
    lista.push(candidato);
    porSource.set(candidato.source, lista);
  }

  const amostra: CandidateOrderKey[] = [];
  for (const lista of porSource.values()) {
    lista.sort((a, b) => a.orderKey.localeCompare(b.orderKey));

    if (lista.length <= porFonte) {
      amostra.push(...lista);
      continue;
    }

    const passo = lista.length / porFonte;
    for (let i = 0; i < porFonte; i++) {
      amostra.push(lista[Math.floor(i * passo)]);
    }
  }

  return amostra;
}

/**
 * Eventos das chaves -> pedido por chave, pelo caminho do LEGADO.
 *
 * `findMirrorRowsByOrderKeys` ja aplica `dedupeMirrorRows`, e o dedup fica
 * completo porque cada chave cai inteira num unico lote: todos os eventos dela
 * casam com o mesmo `ANY(...)`. Chave que existe no mirror mas nao vira pedido
 * (nao paga, sem data, valor <= 0) entra no mapa como `null` -- e informacao,
 * nao ausencia: se ela estiver na materializada, e divergencia.
 */
async function carregarPeloMirror(
  chaves: CandidateOrderKey[]
): Promise<Map<string, FinancialTransaction | null>> {
  const porChave = new Map<string, FinancialTransaction | null>();
  for (const candidato of chaves) {
    porChave.set(chaveDeCandidato(candidato), null);
  }

  for (let inicio = 0; inicio < chaves.length; inicio += TAMANHO_LOTE_CHAVES) {
    const lote = chaves.slice(inicio, inicio + TAMANHO_LOTE_CHAVES);
    const linhas = await findMirrorRowsByOrderKeys(lote);

    for (const linha of linhas) {
      const transacao = mapMirrorRow(linha);
      if (!transacao) continue;
      porChave.set(`${linha.source}:${linha.external_order_id ?? linha.id}`, transacao);
    }

    process.stdout.write(
      `\r  mirror: ${Math.min(inicio + TAMANHO_LOTE_CHAVES, chaves.length)}/${chaves.length} chaves`
    );
  }
  if (chaves.length > 0) process.stdout.write("\n");

  return porChave;
}

function diferencaDeCampos(
  legado: FinancialTransaction,
  materializado: FinancialTransaction
): string[] {
  const diferencas: string[] = [];

  for (const campo of CAMPOS_COMPARADOS) {
    const esquerda = legado[campo];
    const direita = materializado[campo];
    if (esquerda !== direita) {
      diferencas.push(`${campo}: legado=${String(esquerda)} materializado=${String(direita)}`);
    }
  }

  return diferencas;
}

/** Passo 1 e 2: mapeamento campo a campo, e omissao. */
function compararChaves(
  pelaChaveNoMirror: Map<string, FinancialTransaction | null>,
  pelaChaveMaterializado: Map<string, FinancialTransaction>,
  inicio: Date,
  fim: Date
): Divergencia[] {
  const divergencias: Divergencia[] = [];

  for (const [k, legado] of pelaChaveNoMirror) {
    const materializado = pelaChaveMaterializado.get(k);

    if (!legado) {
      // O mirror nao produz pedido para esta chave. So e divergencia se a
      // materializada produz -- ai ela tem uma linha que a regra de negocio
      // atual nao sustenta mais (estorno nao propagado, por exemplo).
      if (materializado) {
        divergencias.push({
          chave: k,
          lado: "so_no_materializado",
          detalhe: `mirror nao produz pedido (nao pago/sem data/valor<=0); materializado ${materializado.occurredAt} ${(materializado.amountCents / 100).toFixed(2)}`,
          classe: null,
        });
      }
      continue;
    }

    const dentroDoPeriodo =
      new Date(legado.occurredAt) >= inicio && new Date(legado.occurredAt) <= fim;

    if (!materializado) {
      // Fora do periodo a materializada nao devolveria a linha de qualquer
      // forma: a consulta que montou o outro lado recorta por occurred_at.
      if (dentroDoPeriodo) {
        divergencias.push({
          chave: k,
          lado: "so_no_legado",
          detalhe: `${legado.occurredAt} ${(legado.amountCents / 100).toFixed(2)} ausente da materializada`,
          classe: null,
        });
      }
      continue;
    }

    const diferencas = diferencaDeCampos(legado, materializado);
    if (diferencas.length > 0) {
      divergencias.push({
        chave: k,
        lado: "valor_diferente",
        detalhe: diferencas.join(" | "),
        classe: null,
      });
    }
  }

  return divergencias;
}

/**
 * Passo 3: paridade de filtro, restrita a amostra.
 *
 * De um lado a SQL da materializada; do outro o predicado em memoria do legado
 * (`filterTransactions`, o mesmo que a tela usa hoje) aplicado as transacoes
 * mapeadas do mirror. Restringir a amostra e o que torna a comparacao possivel
 * sem trazer a janela inteira de eventos.
 */
async function compararFiltros(
  caso: Caso,
  transacoesDaAmostra: FinancialTransaction[],
  chavesDaAmostra: Set<string>,
  inicio: Date,
  fim: Date
): Promise<Divergencia[]> {
  const filtros: ReadModelFilters = {
    type: "income",
    sources: ["integration", "webhook"],
    marketplace: caso.marketplace,
    paymentMethod: caso.paymentMethod,
    search: caso.search,
    startDate: inicio.toISOString(),
    endDate: fim.toISOString(),
  };

  const materializado = await comFlag(true, () => listFinancialReadModelTransactions(filtros));
  const materializadoNaAmostra = indexarPorChave(
    materializado.filter((item) => chavesDaAmostra.has(chave(item)))
  );

  const esperado = indexarPorChave(filterTransactions(transacoesDaAmostra, filtros));

  const divergencias: Divergencia[] = [];

  for (const [k, item] of esperado) {
    if (!materializadoNaAmostra.has(k)) {
      divergencias.push({
        chave: k,
        lado: "so_no_legado",
        detalhe: `[${caso.nome}] o predicado do legado aprova, a SQL da materializada nao devolve (${item.occurredAt} ${(item.amountCents / 100).toFixed(2)})`,
        classe: null,
      });
    }
  }

  for (const [k, item] of materializadoNaAmostra) {
    if (!esperado.has(k)) {
      divergencias.push({
        chave: k,
        lado: "so_no_materializado",
        detalhe: `[${caso.nome}] a SQL da materializada devolve, o predicado do legado reprova (${item.occurredAt} ${(item.amountCents / 100).toFixed(2)})`,
        classe: null,
      });
    }
  }

  console.log(
    `${caso.nome.padEnd(28)} materializado=${String(materializado.length).padStart(6)} ` +
      `na_amostra=${String(materializadoNaAmostra.size).padStart(4)} ` +
      `esperado_pelo_legado=${String(esperado.size).padStart(4)} ` +
      `divergencias=${divergencias.length}`
  );

  return divergencias;
}

/** Passo 4: paginas 1 e 2 do caminho materializado, sem sobreposicao. */
async function conferirPaginacao(inicio: Date, fim: Date): Promise<number> {
  const base = { limit: 20, startDate: inicio.toISOString(), endDate: fim.toISOString() };

  const pagina1 = await comFlag(true, () => listMarketplaceReadModelPaginated({ ...base, page: 1 }));
  const pagina2 = await comFlag(true, () => listMarketplaceReadModelPaginated({ ...base, page: 2 }));

  const chavesPagina1 = new Set(pagina1.items.map(chave));
  const repetidas = pagina2.items.filter((item) => chavesPagina1.has(chave(item)));

  const ordenada = pagina1.items.every(
    (item, index) => index === 0 || pagina1.items[index - 1].occurredAt >= item.occurredAt
  );

  console.log(
    `\npaginacao  total=${pagina1.pagination.total} ` +
      `pagina1=${pagina1.items.length} pagina2=${pagina2.items.length} ` +
      `sobrepostas=${repetidas.length} ordem_decrescente=${ordenada ? "ok" : "QUEBRADA"}`
  );

  return repetidas.length + (ordenada ? 0 : 1);
}

async function modoChave(inicio: Date, fim: Date, porFonte: number): Promise<Divergencia[]> {
  console.log(`=== Modo chave: ${inicio.toISOString()} a ${fim.toISOString()}`);
  console.log(`    amostra de ate ${porFonte} chaves por fonte, de cada lado\n`);

  // Lado materializado: barato, e a consulta que a producao faria.
  const materializados = await comFlag(true, () =>
    listFinancialReadModelTransactions({
      type: "income",
      sources: ["integration", "webhook"],
      startDate: inicio.toISOString(),
      endDate: fim.toISOString(),
    })
  );
  const pelaChaveMaterializado = indexarPorChave(materializados);
  console.log(`materializada: ${materializados.length} pedidos no periodo`);

  // Amostra dos dois lados. So do lado materializado nao detectaria OMISSAO --
  // pedido que existe no mirror e nunca foi materializado nao apareceria na
  // amostra, que e exatamente o defeito mais grave possivel aqui.
  const candidatosMaterializados = materializados
    .map(candidatoDeTransacao)
    .filter((candidato): candidato is CandidateOrderKey => candidato !== null);

  const candidatosMirror = await findCandidateOrderKeys(
    new Date(inicio.getTime() - FOLGA_CANDIDATOS_MS),
    new Date(fim.getTime() + FOLGA_CANDIDATOS_MS)
  );
  console.log(`mirror:        ${candidatosMirror.length} chaves candidatas na janela com folga`);

  const amostra = new Map<string, CandidateOrderKey>();
  for (const candidato of [
    ...amostrar(candidatosMaterializados, porFonte),
    ...amostrar(candidatosMirror, porFonte),
  ]) {
    amostra.set(chaveDeCandidato(candidato), candidato);
  }
  console.log(`amostra:       ${amostra.size} chaves distintas\n`);

  const pelaChaveNoMirror = await carregarPeloMirror([...amostra.values()]);

  const divergencias = compararChaves(pelaChaveNoMirror, pelaChaveMaterializado, inicio, fim);

  const transacoesDaAmostra = [...pelaChaveNoMirror.values()].filter(
    (item): item is FinancialTransaction => item !== null
  );
  const chavesDaAmostra = new Set(amostra.keys());

  console.log(
    `\nchaves conferidas=${pelaChaveNoMirror.size} ` +
      `viraram pedido=${transacoesDaAmostra.length} ` +
      `soma=${(somaCentavos(transacoesDaAmostra) / 100).toFixed(2)} ` +
      `divergencias de mapeamento=${divergencias.length}\n`
  );

  for (const caso of CASOS) {
    divergencias.push(
      ...(await compararFiltros(caso, transacoesDaAmostra, chavesDaAmostra, inicio, fim))
    );
  }

  const paginacao = await conferirPaginacao(inicio, fim);
  if (paginacao > 0) {
    divergencias.push({
      chave: "(paginacao)",
      lado: "valor_diferente",
      detalhe: `${paginacao} itens sobrepostos ou fora de ordem entre as paginas 1 e 2`,
      classe: null,
    });
  }

  return divergencias;
}

// ---------------------------------------------------------------------------
// Modo janela (so roda de onde a banda esta -- ver cabecalho)
// ---------------------------------------------------------------------------

/**
 * Classifica uma divergencia do modo janela numa causa conhecida, ou devolve
 * null.
 *
 * Null e o que importa: e o que conta para o criterio de corte. Classificar
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

async function compararCasoPorJanela(caso: Caso, inicio: Date, fim: Date): Promise<Divergencia[]> {
  const filtros: ReadModelFilters = {
    type: "income",
    sources: ["integration", "webhook"],
    marketplace: caso.marketplace,
    paymentMethod: caso.paymentMethod,
    search: caso.search,
    startDate: inicio.toISOString(),
    endDate: fim.toISOString(),
  };

  const legado = await comFlag(false, () => listFinancialReadModelTransactions(filtros));
  const materializado = await comFlag(true, () => listFinancialReadModelTransactions(filtros));

  const porChaveLegado = indexarPorChave(legado);
  const porChaveMaterializado = indexarPorChave(materializado);

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

    const diferencas = diferencaDeCampos(item, par);
    if (diferencas.length > 0) {
      const base = {
        chave: k,
        lado: "valor_diferente" as const,
        detalhe: diferencas.join(" | "),
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

async function modoJanela(inicio: Date, fim: Date): Promise<Divergencia[]> {
  console.log(`=== Modo janela: ${inicio.toISOString()} a ${fim.toISOString()}\n`);

  const todas: Divergencia[] = [];
  for (const caso of CASOS) {
    todas.push(...(await compararCasoPorJanela(caso, inicio, fim)));
  }

  const paginacao = await conferirPaginacao(inicio, fim);
  if (paginacao > 0) {
    todas.push({
      chave: "(paginacao)",
      lado: "valor_diferente",
      detalhe: `${paginacao} itens sobrepostos ou fora de ordem entre as paginas 1 e 2`,
      classe: null,
    });
  }

  return todas;
}

// ---------------------------------------------------------------------------

/** Aceita `YYYY-MM-DD` ou timestamp ISO completo. */
function parseLimite(valor: string | undefined, padrao: string, fimDeDia: boolean): Date {
  const bruto = valor ?? padrao;
  const texto = /^\d{4}-\d{2}-\d{2}$/.test(bruto)
    ? `${bruto}T${fimDeDia ? "23:59:59" : "00:00:00"}-03:00`
    : bruto;

  const data = new Date(texto);
  if (Number.isNaN(data.getTime())) {
    throw new Error(`data invalida: ${bruto} (esperado YYYY-MM-DD ou ISO completo)`);
  }
  return data;
}

function contarPorClasse(divergencias: Divergencia[]): Array<[string, number]> {
  const contagem = new Map<string, number>();
  for (const d of divergencias) {
    if (!d.classe) continue;
    contagem.set(d.classe, (contagem.get(d.classe) ?? 0) + 1);
  }
  return [...contagem.entries()].sort((a, b) => b[1] - a[1]);
}

async function main() {
  const flags = process.argv.slice(2).filter((arg) => arg.startsWith("--"));
  const args = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));

  const porJanela = flags.includes("--janela");
  const amostra = Number(
    flags.find((flag) => flag.startsWith("--amostra="))?.split("=")[1] ?? AMOSTRA_PADRAO
  );
  if (!Number.isInteger(amostra) || amostra <= 0) {
    throw new Error("--amostra deve ser um inteiro positivo");
  }

  const inicio = parseLimite(args[0], "2026-08-01", false);
  const fim = parseLimite(args[1], "2026-08-22", true);

  let todas: Divergencia[];
  try {
    todas = porJanela ? await modoJanela(inicio, fim) : await modoChave(inicio, fim, amostra);
  } finally {
    await closePool();
  }

  const inexplicadas = todas.filter((d) => d.classe === null);
  const classificadas = todas.filter((d) => d.classe !== null);

  console.log(
    `\n=== ${todas.length} divergencias: ${classificadas.length} classificadas, ${inexplicadas.length} inexplicadas`
  );

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

main().catch((error) => {
  console.error("FALHOU:", error instanceof Error ? error.message : error);
  process.exit(1);
});
