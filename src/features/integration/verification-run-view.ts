/**
 * Leitura de tela da ultima verificacao Sistema x Shopify.
 *
 * O painel de /integracoes le a linha mais recente de `shopify-verify` em
 * integration.job_runs e precisa transformar o `result` — que e' jsonb, ou seja
 * `unknown` em runtime — em algo exibivel. Este modulo faz so isso, e e' puro de
 * proposito: quem fala com o banco e' job-run-repository, quem decide o que a
 * tela diz e' testado sem banco. Mesmo arranjo de read-model-freshness.ts.
 *
 * ─── Por que existe um QUALIFICADOR e nao so o numero ───────────────────────
 *
 * O desvio Ledger x Shopify de um dia que ainda nao drenou a fila nao e' um
 * desvio: e' trabalho pendente. Medido em 09/09/2026, no MESMO dia (08/09):
 *
 *   08:46 BRT   R$ 10.293,27   60 pedidos    (56 ainda sem perna no ledger)
 *   09:31 BRT   R$    679,69    3 pedidos    (depois do passe de resolucao)
 *
 * Quinze vezes menor, sem ninguem corrigir nada — os 57 pedidos nunca
 * divergiram, so ainda nao tinham sido reconciliados. Publicar o primeiro numero
 * sem dizer que o dia estava imaturo faz o painel mentir com precisao de
 * centavos, que e' pior do que nao mostrar nada.
 *
 * E' a mesma regra que este painel ja aplica a ausencia de dado ("null nunca
 * vira zero"), num eixo diferente: **numero provisorio nunca se apresenta como
 * numero fechado**.
 */

/**
 * Rotulo da ponta 2 dentro de `metrics`, no relatorio de verificacao.
 *
 * A ponta 2 aparece DUAS vezes no relatorio: como uma metrica na lista (para o
 * CLI e o log terem tudo num lugar so) e como bloco proprio em
 * `ledgerVsShopify`. Quem exibe os dois precisa saber qual metrica ja esta
 * representada pelo bloco.
 *
 * Mora aqui, e nao em shopify-value-verification.ts que a produz, para que este
 * modulo continue sem dependencia nenhuma: o painel importa a constante, e
 * arrastar junto computeCashFlow e o pool do CORE so para reconhecer um rotulo
 * seria caro. A dependencia corre do modulo pesado para o puro, como em
 * job-names.ts.
 */
export const LEDGER_VS_SHOPIFY_METRIC_LABEL = "Ledger × Shopify (tenderTransactions, por pedido)";

/** Como a ultima verificacao deve ser lida. */
export type VerificationReadStatus =
  /** Nenhuma linha de `shopify-verify` em job_runs — o job nunca rodou. */
  | "sem_registro"
  /** A execucao lancou. O relatorio nao existe; o erro e' o que importa. */
  | "falhou"
  /** Rodou, mas o `result` nao tem o formato esperado (linha de versao antiga). */
  | "formato_desconhecido"
  /**
   * Rodou e mediu, mas o dia ainda nao estava maduro.
   *
   * Os numeros existem e sao exibidos — escondidos seriam pior —, porem como
   * parciais. Um desvio aqui e' indistinguivel de fila por drenar.
   */
  | "provisoria"
  /** Dia maduro, nenhuma metrica divergindo. E' o unico "fechou". */
  | "conferido"
  /** Dia maduro e ainda assim divergindo. Aqui o numero vale alarme. */
  | "divergente";

export type VerificationView = {
  status: VerificationReadStatus;
  /** Quando a verificacao rodou. Null so em `sem_registro`. */
  ranAt: string | null;
  /** Dia verificado (D-1 no fuso da verificacao). Null se nao deu para ler. */
  date: string | null;
  errorMessage: string | null;
  /**
   * Qual sinal impede o dia de ser considerado maduro. Vazio quando maduro.
   *
   * Frase pronta e nao booleano: "por que ainda nao fechou" e' a pergunta que o
   * admin faz olhando o painel, e a resposta muda conforme o elo da corrente da
   * manha que ficou para tras.
   */
  pendencias: string[];
  /** Ponta 2: ledger x tenderTransactions. Null quando nao deu para ler. */
  ledgerVsShopify: {
    comparedOrders: number;
    divergentOrders: number;
    driftFormatted: string;
    blindSpotFormatted: string;
    ordersOnlyInLedger: number;
  } | null;
  /** Ponta 1: rotulos das metricas Sistema x Ledger que estao divergindo. */
  metricasDivergentes: { label: string; diff: string; diffPct: string }[];
  /**
   * Reconciliacao por pedido (D-1..D-3). Null quando nao deu para ler.
   *
   * `erro` preenchido significa que a verificacao correu bem e so o conserto
   * falhou — distincao que importa, porque o painel nao pode exibir um numero
   * medido com sucesso como se estivesse comprometido.
   */
  reconciliacao: {
    corrigidos: number;
    pendentes: number;
    persistentes: number;
    /** Divergencias detectadas nesta rodada, corrigidas ou nao. */
    detectadas: number;
    driftFormatted: string;
    /** D-1 ficou de fora por estar imaturo. */
    diaAdiado: string | null;
    erro: string | null;
  } | null;
};

const VAZIO: VerificationView = {
  status: "sem_registro",
  ranAt: null,
  date: null,
  errorMessage: null,
  pendencias: [],
  ledgerVsShopify: null,
  metricasDivergentes: [],
  reconciliacao: null,
};

/** Recorte do que o painel consome da linha de job_runs. */
export type VerificationRunInput = {
  started_at: string | Date | null;
  status: string;
  result: unknown;
  error_message: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function toIso(value: string | Date | null): string | null {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * Traduz os sinais de maturidade em pendencias legiveis.
 *
 * Cada sinal corresponde a um elo da corrente da manha (sync -> resolucao ->
 * materializacao -> verificacao), entao a frase nomeia o elo, nao a coluna.
 */
function lerPendencias(maturity: Record<string, unknown>): string[] {
  const pendencias: string[] = [];

  const semResolucao = asNumber(maturity.unresolvedOrders);
  if (semResolucao === null) {
    pendencias.push("não foi possível ler a fila de resolução");
  } else if (semResolucao > 0) {
    pendencias.push(
      `${semResolucao.toLocaleString("pt-BR")} pedido(s) ainda sem gateway resolvido`
    );
  }

  const semLedger = asNumber(maturity.ordersWithoutLedger);
  if (semLedger === null) {
    pendencias.push("não foi possível ler a cobertura do ledger");
  } else if (semLedger > 0) {
    pendencias.push(`${semLedger.toLocaleString("pt-BR")} pedido(s) materializados sem rateio`);
  }

  if (maturity.materializedAfterWindow !== true) {
    pendencias.push("a materialização não passou depois de o dia fechar");
  }

  return pendencias;
}

function lerLedgerVsShopify(value: unknown): VerificationView["ledgerVsShopify"] {
  if (!isRecord(value)) return null;

  const comparedOrders = asNumber(value.comparedOrders);
  const divergentOrders = asNumber(value.divergentOrders);
  if (comparedOrders === null || divergentOrders === null) return null;

  return {
    comparedOrders,
    divergentOrders,
    // Os formatados vem prontos do relatorio de proposito: reformatar centavos
    // aqui abriria uma segunda formatacao de moeda que pode divergir da do CLI
    // e da do log, para o mesmo numero.
    driftFormatted: asString(value.driftFormatted) ?? "—",
    blindSpotFormatted: asString(value.storeCreditBlindSpotFormatted) ?? "—",
    ordersOnlyInLedger: asNumber(value.ordersOnlyInLedger) ?? 0,
  };
}

/**
 * Le o bloco da reconciliacao, que vive em `result.reconciliation` — irmao de
 * `result.report`, e nao dentro dele: o relatorio e' a MEDICAO, a reconciliacao e'
 * uma ACAO tomada depois. Uma execucao pode medir bem e consertar mal.
 *
 * Quando a reconciliacao falhou, o objeto so tem `error`. Devolver os contadores
 * zerados nesse caso faria o painel afirmar "0 pendentes", que e' uma mentira
 * precisa: ninguem sabe quantos ha.
 */
function lerReconciliacao(value: unknown): VerificationView["reconciliacao"] {
  if (!isRecord(value)) return null;

  const erro = asString(value.error);
  if (erro !== null) {
    return {
      corrigidos: 0,
      pendentes: 0,
      persistentes: 0,
      detectadas: 0,
      driftFormatted: "—",
      diaAdiado: null,
      erro,
    };
  }

  const porStatus = isRecord(value.byStatus) ? value.byStatus : null;
  const detectadas = asNumber(value.detected);
  if (detectadas === null) return null;

  return {
    corrigidos: asNumber(value.corrected) ?? 0,
    pendentes: porStatus ? (asNumber(porStatus.pendente) ?? 0) : 0,
    persistentes: porStatus ? (asNumber(porStatus.persistente) ?? 0) : 0,
    detectadas,
    driftFormatted: asString(value.driftFormatted) ?? "—",
    diaAdiado: asString(value.skippedImmatureDay),
    erro: null,
  };
}

/** Toda metrica marcada como divergente, sem descarte. Base do VEREDITO. */
function lerMetricasDivergentes(value: unknown): VerificationView["metricasDivergentes"] {
  if (!Array.isArray(value)) return [];

  return value.filter(isRecord).flatMap((metric) => {
    if (metric.diverges !== true) return [];
    const label = asString(metric.label);
    if (!label) return [];
    return [{ label, diff: asString(metric.diff) ?? "—", diffPct: asString(metric.diffPct) ?? "—" }];
  });
}

/**
 * Interpreta a ultima execucao de `shopify-verify`.
 *
 * Nunca lanca: esta e' a tela que o admin abre justamente quando algo quebrou.
 * Qualquer formato inesperado vira `formato_desconhecido`, que e' informacao —
 * ao contrario de um painel em branco.
 */
export function buildVerificationView(run: VerificationRunInput | null | undefined): VerificationView {
  if (!run) return VAZIO;

  const ranAt = toIso(run.started_at);

  if (run.status === "failed") {
    return { ...VAZIO, status: "falhou", ranAt, errorMessage: run.error_message };
  }

  const outcome = isRecord(run.result) ? run.result : null;
  const report = outcome && isRecord(outcome.report) ? outcome.report : null;
  if (!report) {
    return { ...VAZIO, status: "formato_desconhecido", ranAt, errorMessage: run.error_message };
  }

  const maturity = isRecord(report.maturity) ? report.maturity : null;
  const ledgerVsShopify = lerLedgerVsShopify(report.ledgerVsShopify);
  const date = asString(report.date);
  // `outcome`, e nao `report`: a reconciliacao e' irma do relatorio, nao parte
  // dele. Ver lerReconciliacao.
  const reconciliacao = lerReconciliacao(outcome?.reconciliation);

  // Duas listas de proposito, e a distincao ja custou um bug: o VEREDITO olha
  // toda metrica divergente; a EXIBICAO descarta a da ponta 2, que ja tem bloco
  // proprio. Derivar o veredito da lista filtrada faria um dia em que so a
  // ponta 2 diverge aparecer como "confere" — um "tudo certo" silencioso, que e'
  // exatamente a falha que este painel existe para nao repetir.
  const todasDivergentes = lerMetricasDivergentes(report.metrics);
  const metricasDivergentes = todasDivergentes.filter(
    (metrica) => metrica.label !== LEDGER_VS_SHOPIFY_METRIC_LABEL
  );

  // Sem bloco de maturidade nao da para dizer se o numero e' final. Trata como
  // provisorio: o erro de chamar de fechado o que nao esta e' o caro.
  if (!maturity) {
    return {
      status: "provisoria",
      ranAt,
      date,
      errorMessage: run.error_message,
      pendencias: ["a execução não registrou sinais de maturidade"],
      ledgerVsShopify,
      metricasDivergentes,
      reconciliacao,
    };
  }

  const pendencias = lerPendencias(maturity);
  // `isMature` e' quem manda, e nao a ausencia de pendencias: ele e' calculado
  // pela mesma execucao que produziu os numeros. Derivar de novo aqui criaria
  // uma segunda definicao de maturidade que pode discordar da que gerou (ou nao)
  // o alerta.
  const maduro = maturity.isMature === true;

  const status: VerificationReadStatus = !maduro
    ? "provisoria"
    : todasDivergentes.length > 0
      ? "divergente"
      : "conferido";

  return {
    status,
    ranAt,
    date,
    errorMessage: run.error_message,
    pendencias: maduro ? [] : pendencias,
    ledgerVsShopify,
    metricasDivergentes,
    reconciliacao,
  };
}
