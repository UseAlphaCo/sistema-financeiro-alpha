/**
 * PISO DE DATA DO MIRROR
 * ======================
 *
 * O mirror deixou de ser copia integral de public.raw_payloads: em 2026-08-21 as
 * 604.418 linhas de 26/04 a 31/07 foram truncadas de proposito e o mirror passou
 * a cobrir so a janela a partir de 01/08/2026. Sem um piso, a auditoria por ctid
 * volta a enxergar essas 604 mil linhas como "ausentes" e as rebaixa do OMS de
 * novo -- desfazendo o truncate e reproduzindo exatamente o consumo que derrubou
 * o Supabase em 11/08.
 *
 * Por que o corte mora em Node e nao num WHERE no OMS: findKeysInPageRange ja
 * projeta received_at e processed_at (nao estao TOASTeados, entao trazer as duas
 * colunas e de graca). Um WHERE por data no OMS exigiria um indice em
 * received_at que o OMS nao tem e nao pode ganhar -- e a ausencia desse indice e
 * a causa raiz de todo este desenho. Filtrar depois da descoberta custa zero
 * round-trip e deixa as faixas antigas MAIS baratas que hoje, porque o anti-join
 * e o enfileiramento passam a receber conjunto vazio.
 *
 * Por que nao um CHECK na tabela: upsertRawPayloadsBatch escreve 2.000 linhas
 * por comando. Uma unica linha abaixo do piso derrubaria o lote inteiro,
 * markFetchFailed incrementaria `retries` nas 2.000 e depois de MAX_RETRIES elas
 * parariam de ser selecionadas -- ate 2.000 linhas legitimas encalhadas em
 * silencio, sem nem chegar a DLQ.
 */

/** Chave minima para decidir elegibilidade: as duas colunas de data. */
type DatedRow = {
  receivedAt: Date | null;
  processedAt: Date | null;
};

export type MirrorFloorPartition<T> = {
  /** Linhas dentro da janela do mirror. */
  eligible: T[];
  /** Quantas cairam por serem anteriores ao piso. */
  belowFloor: number;
  /** Quantas cairam por nao terem data nenhuma. */
  undated: number;
};

/**
 * Ordena pela mesma expressao que o resto do sync: COALESCE(received_at,
 * processed_at). Manter identico a findRawPayloadsAfter e a
 * findMirrorMaxSortAt, senao o piso e a marca d'agua discordariam sobre qual e
 * a data de uma linha.
 */
export function mirrorSortAt(row: DatedRow): Date | null {
  return row.receivedAt ?? row.processedAt ?? null;
}

/**
 * Elegibilidade de uma linha para o mirror.
 *
 * Comparacao inclusiva no piso: o recorte do CSV de agosto foi
 * `>= '2026-08-01 00:00:00-03'`, e o piso tem de aceitar exatamente as mesmas
 * linhas que o arquivo trouxe -- do contrario a verificacao por faixa de data
 * (a unica que temos) nunca fecharia.
 *
 * Sem data nenhuma => INELEGIVEL, de proposito. Sao linhas que nem o CSV trouxe
 * (o recorte era por data) e que findRawPayloadsAfter tambem exclui hoje, pelo
 * mesmo motivo: nao ha por onde ordena-las de forma estavel. Incluir aqui
 * quebraria a contagem por faixa de data, que e a unica verificacao disponivel.
 */
export function isAboveMirrorFloor(row: DatedRow, floorAt: Date): boolean {
  const sortAt = mirrorSortAt(row);
  if (sortAt === null) {
    return false;
  }

  return sortAt.getTime() >= floorAt.getTime();
}

/**
 * Separa um lote de chaves em elegiveis e contadores do que ficou fora.
 *
 * Devolve contadores, e nao apenas o filtro, porque a decisao de truncar
 * abril-julho precisa ser MEDIDA e nao presumida: `rowsBelowFloor` alto com
 * `rowsMissing` proximo de zero e a assinatura de uma volta de auditoria sadia
 * depois do truncate. Sem o contador no log, "o piso esta funcionando" seria
 * afirmacao inauditavel.
 */
export function partitionByMirrorFloor<T extends DatedRow>(
  rows: T[],
  floorAt: Date
): MirrorFloorPartition<T> {
  const eligible: T[] = [];
  let belowFloor = 0;
  let undated = 0;

  for (const row of rows) {
    const sortAt = mirrorSortAt(row);
    if (sortAt === null) {
      undated += 1;
      continue;
    }

    if (sortAt.getTime() < floorAt.getTime()) {
      belowFloor += 1;
      continue;
    }

    eligible.push(row);
  }

  return { eligible, belowFloor, undated };
}
