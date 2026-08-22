import { getMaterializedFloorDate } from "@/shared/read-model-config";

/**
 * COBERTURA DE DADOS
 * ==================
 *
 * O sistema tem uma data a partir da qual existe dado, e nao existe nada antes
 * dela. Sem tratar isso explicitamente, um periodo anterior ao piso devolve
 * zero linhas das duas fontes e a tela mostra R$ 0,00 -- que se le como "nao
 * vendeu nada", nao como "nao temos esse dado".
 *
 * E o caso comum, nao a excecao: o preset default do dashboard e `d30`, hoje
 * comeca em 23/07 e o piso e 01/08. Pior, `getPreviousPeriodRange` cai INTEIRO
 * abaixo do piso para qualquer periodo acima de ~10 dias -- ou seja a base de
 * comparacao fica vazia e o deltaPercent viraria "—", que a UI le como "sem
 * variacao" e nao como "sem base".
 *
 * Isto substitui a clausula "cai no caminho legado" da secao 2.4 do plano, que
 * deixou de funcionar: com o mirror truncado, o legado e FinancialTransaction,
 * com zero linhas. Cair no legado E o zero silencioso.
 */

export type CoverageStatus =
  /** O periodo pedido esta inteiro dentro da janela com dado. */
  | "full"
  /** Parte do periodo esta antes do piso; a parte de dentro foi consultada. */
  | "partial"
  /** O periodo esta inteiro antes do piso: nao ha o que consultar. */
  | "none";

export type Coverage = {
  status: CoverageStatus;
  /** Piso aplicado, ou null quando nao ha piso configurado. */
  floor: Date | null;
  /**
   * Inicio efetivo da consulta, ja recortado no piso. Em `none` e null: o
   * chamador nao deve consultar banco nenhum.
   */
  start: Date | null;
  end: Date | null;
};

/**
 * Recorta um periodo pedido no piso e classifica o resultado.
 *
 * O recorte importa por desempenho tambem, e nao so por honestidade: sem ele,
 * um pedido de `d90` manda o banco procurar em 90 dias de indice para achar 20.
 */
export function resolveCoverage(
  requestedStart: Date | null | undefined,
  requestedEnd: Date | null | undefined,
  floor: Date | null = getMaterializedFloorDate()
): Coverage {
  const start = requestedStart ?? null;
  const end = requestedEnd ?? null;

  if (!floor) {
    // Sem piso conhecido nao ha o que anotar: melhor nao afirmar cobertura do
    // que afirmar errado.
    return { status: "full", floor: null, start, end };
  }

  // Periodo sem inicio ("tudo") nao pode ser `partial`: nao ha limite inferior
  // pedido para comparar, e o piso passa a ser o proprio inicio.
  if (!start) {
    return { status: "full", floor, start: floor, end };
  }

  if (end && end < floor) {
    return { status: "none", floor, start: null, end: null };
  }

  if (start < floor) {
    return { status: "partial", floor, start: floor, end };
  }

  return { status: "full", floor, start, end };
}

/**
 * Se uma base de comparacao (periodo anterior) pode sustentar um delta.
 *
 * `partial` tambem NAO sustenta: comparar 20 dias de dado contra 30 dias de
 * periodo produz uma queda inventada, que e pior que a ausencia do numero --
 * porque parece informacao.
 */
export function canCompare(coverage: Coverage): boolean {
  return coverage.status === "full";
}

/** Frase curta para a UI. Null quando nao ha nada a avisar. */
export function describeCoverage(coverage: Coverage): string | null {
  if (!coverage.floor || coverage.status === "full") return null;

  const desde = coverage.floor.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });

  if (coverage.status === "none") {
    return `Nao ha dados anteriores a ${desde}. Escolha um periodo a partir dessa data.`;
  }

  return `Dados disponiveis a partir de ${desde}. O periodo escolhido comeca antes disso.`;
}
