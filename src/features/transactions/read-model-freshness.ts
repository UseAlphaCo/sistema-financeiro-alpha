import type { MaterializedLag } from "@/features/transactions/financial-orders-repository";
import { BRAZIL_TIME_ZONE } from "@/lib/date-utils";

/**
 * TETO DE COBERTURA
 * =================
 *
 * read-model-coverage.ts trata o PISO: antes de certa data nao existe dado, e um
 * periodo abaixo dela devolveria R$ 0,00 que se le como "nao vendeu nada".
 *
 * Este modulo trata a outra ponta. Com FINANCIAL_READ_MODEL_MATERIALIZED ligado
 * as telas passam a ler integration.financial_orders, que e preenchida por um
 * cron 1x/dia as 23 h BRT. Depois do teto -- o ultimo pedido materializado -- nao
 * ha linha nenhuma, e o zero volta a mentir: o preset "Hoje" mostraria R$ 0,00 o
 * dia inteiro.
 *
 * A diferenca em relacao ao piso e que aqui o dado EXISTE (esta no mirror), so
 * ainda nao foi materializado. Por isso a mensagem diz "ainda nao", e nao "nao
 * ha".
 *
 * Modulo puro de proposito, como read-model-coverage.ts: quem consulta o banco e
 * getMaterializedLag, quem decide o que a tela diz e testado sem banco.
 */

export type FreshnessStatus =
  /** O periodo pedido termina dentro do que ja foi materializado. */
  | "fresh"
  /** O periodo comecou dentro, mas termina depois do teto (o caso de d7/d30 durante o dia). */
  | "trailing"
  /**
   * O periodo JA TERMINOU e mesmo assim nao foi alcancado pela materializacao.
   *
   * Diferente de `trailing`, onde faltar as ultimas horas e o esperado porque
   * elas ainda estao acontecendo. Aqui o dia fechou e o numero continua parcial
   * -- o que aconteceu em 25/08/2026, quando "Ontem" exibia 1.365 dos 1.738
   * pedidos Shopify (R$ 207.402,93 de R$ 264.683,09) o dia inteiro. Um numero
   * fechado que nao esta fechado precisa de aviso mais forte, porque quem le
   * nao tem como desconfiar dele sozinho.
   */
  | "incomplete"
  /** O periodo inteiro esta depois do teto (o caso de "Hoje" antes das 23 h). */
  | "not_yet"
  /** Nao da para saber ate onde o dado vai -- tabela ausente ou materializacao parada. */
  | "unknown";

export type Freshness = {
  status: FreshnessStatus;
  /** Ate quando ha pedido materializado. */
  materializedThrough: Date | null;
  /** Quando a materializacao rodou pela ultima vez. */
  lastRunAt: Date | null;
  /** Frase para a tela. Null quando nao ha nada a avisar. */
  message: string | null;
  /**
   * Se os totais do periodo podem ser exibidos como resultado.
   *
   * Falso em `not_yet`: ali os agregados sao todos zero por ausencia de linha, e
   * exibi-los como numero e a propria falha que este modulo existe para
   * impedir. A tela deve mostrar um traco e a mensagem, nunca R$ 0,00.
   */
  canShowTotals: boolean;
};

function formatMoment(value: Date): string {
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: BRAZIL_TIME_ZONE,
  }).format(value);
}

function parseInstant(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Classifica um periodo pedido contra o teto da materializacao.
 *
 * `lag` null cobre dois casos com o mesmo tratamento: sem conexao com o CORE e
 * tabela inexistente (getMaterializedLag devolve null em 42P01). Nos dois, o
 * honesto e dizer que nao se sabe -- e nao afirmar frescor.
 */
export function resolveFreshness(
  period: { startDate: string; endDate: string },
  lag: MaterializedLag | null,
  /** Injetavel para o teste distinguir periodo em andamento de periodo fechado. */
  now: Date = new Date()
): Freshness {
  const materializedThrough = parseInstant(lag?.maxOccurredAt);
  const lastRunAt = parseInstant(lag?.maxMaterializedAt);

  if (!materializedThrough) {
    return {
      status: "unknown",
      materializedThrough: null,
      lastRunAt,
      // Sem teto conhecido dentro da janela de frescor, a materializacao esta
      // parada ha mais de uma semana ou a tabela nao existe neste ambiente. Os
      // dois casos precisam aparecer: e o unico estado em que as telas podem
      // estar completamente vazias sem nada explicando.
      message:
        "Nao foi possivel determinar ate quando os dados vao. A materializacao pode estar parada.",
      canShowTotals: true,
    };
  }

  const start = parseInstant(period.startDate);
  const end = parseInstant(period.endDate);

  // Periodo ilegivel nao e motivo para acusar a materializacao.
  if (!start || !end) {
    return {
      status: "unknown",
      materializedThrough,
      lastRunAt,
      message: null,
      canShowTotals: true,
    };
  }

  if (end <= materializedThrough) {
    return { status: "fresh", materializedThrough, lastRunAt, message: null, canShowTotals: true };
  }

  if (start > materializedThrough) {
    return {
      status: "not_yet",
      materializedThrough,
      lastRunAt,
      message: `O periodo escolhido ainda nao foi processado. Os dados vao ate ${formatMoment(
        materializedThrough
      )}.`,
      canShowTotals: false,
    };
  }

  // Periodo ja encerrado que a materializacao nao alcancou. Os totais continuam
  // sendo exibidos -- sao parciais, nao inventados --, mas com aviso de peso, ja
  // que um dia fechado passa a impressao de numero definitivo.
  if (end <= now) {
    return {
      status: "incomplete",
      materializedThrough,
      lastRunAt,
      message: `Este periodo ja terminou, mas os dados so vao ate ${formatMoment(
        materializedThrough
      )}. Os valores abaixo estao incompletos.`,
      canShowTotals: true,
    };
  }

  return {
    status: "trailing",
    materializedThrough,
    lastRunAt,
    message: `Dados ate ${formatMoment(
      materializedThrough
    )}. As horas seguintes do periodo ainda nao foram processadas.`,
    canShowTotals: true,
  };
}
