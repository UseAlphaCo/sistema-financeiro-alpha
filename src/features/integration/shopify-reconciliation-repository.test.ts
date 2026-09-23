// O vitest nao carrega .env por conta propria: sem isto, `conn` fica undefined
// e o teste toma o caminho de skip em silencio.
import "dotenv/config";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closeDivergencesByReconference,
  closeShopifyReconciliationPool,
  countDivergencesByStatus,
  ensureShopifyReconciliationTable,
  listDivergences,
  listOpenDivergences,
  listRetryableDivergences,
  markDivergenceAttemptFailed,
  markDivergenceOutcome,
  recordDetectedDivergences,
} from "./shopify-reconciliation-repository";

const conn = process.env.CORE_DB_URL ?? process.env.DATABASE_URL;

/**
 * Prefixo FIXO e impossivel em producao (ids reais da Shopify sao numericos),
 * pelo mesmo motivo do nome fixo em job-run-repository.test.ts: uma execucao
 * morta antes do afterAll deixa residuo, e com prefixo fixo a limpeza do inicio
 * remove o residuo de qualquer execucao anterior. Com id aleatorio o lixo ficaria
 * na tabela para sempre e apareceria no relatorio como divergencia de verdade.
 */
const PREFIXO = "vitest-recon-";

describe("shopify-reconciliation-repository (integration)", () => {
  if (!conn) {
    it("pula quando nao ha CORE_DB_URL nem DATABASE_URL", () => {
      expect(true).toBe(true);
    });
    return;
  }

  const pool = new Pool({ connectionString: conn, max: 1 });

  async function limpar() {
    await pool.query(
      `DELETE FROM integration.shopify_reconciliation_divergences
        WHERE external_order_id LIKE $1`,
      [`${PREFIXO}%`]
    );
  }

  async function ler(id: string) {
    const result = await pool.query(
      `SELECT * FROM integration.shopify_reconciliation_divergences WHERE external_order_id = $1`,
      [id]
    );
    return result.rows[0];
  }

  beforeAll(async () => {
    await ensureShopifyReconciliationTable();
    await limpar();
  });

  afterAll(async () => {
    await limpar();
    await pool.end();
    await closeShopifyReconciliationPool();
  });

  it("registra deteccao nova como pendente", async () => {
    const id = `${PREFIXO}novo`;
    await recordDetectedDivergences([
      { externalOrderId: id, day: "2026-09-07", tenderCents: 19992, ledgerCents: 0, deltaCents: 19992 },
    ]);

    const row = await ler(id);
    expect(row.status).toBe("pendente");
    expect(row.occurrences).toBe(1);
    expect(Number(row.delta_cents)).toBe(19992);
    expect(row.corrected_at).toBeNull();
  });

  it("redeteccao soma occurrences e preserva detected_at", async () => {
    const id = `${PREFIXO}repetido`;
    await recordDetectedDivergences([
      { externalOrderId: id, day: "2026-09-07", tenderCents: 1000, ledgerCents: 0, deltaCents: 1000 },
    ]);
    const primeiro = await ler(id);

    await recordDetectedDivergences([
      { externalOrderId: id, day: "2026-09-08", tenderCents: 2000, ledgerCents: 0, deltaCents: 2000 },
    ]);
    const segundo = await ler(id);

    expect(segundo.occurrences).toBe(2);
    expect(segundo.detected_at).toEqual(primeiro.detected_at);
    expect(Number(segundo.delta_cents)).toBe(2000);
    expect(segundo.status).toBe("pendente");
  });

  it("marca corrigido com o valor depois e a data da correcao", async () => {
    const id = `${PREFIXO}corrige`;
    await recordDetectedDivergences([
      { externalOrderId: id, day: "2026-09-07", tenderCents: 5000, ledgerCents: 3000, deltaCents: 2000 },
    ]);
    await markDivergenceOutcome(id, "corrigido", 5000);

    const row = await ler(id);
    expect(row.status).toBe("corrigido");
    expect(Number(row.ledger_cents_after)).toBe(5000);
    expect(row.corrected_at).not.toBeNull();
  });

  it("nao data como correcao o pedido que foi tocado e continua divergindo", async () => {
    const id = `${PREFIXO}sem-correcao`;
    await recordDetectedDivergences([
      { externalOrderId: id, day: "2026-09-07", tenderCents: 5000, ledgerCents: 3000, deltaCents: 2000 },
    ]);
    await markDivergenceOutcome(id, "sem_correcao", 3000);

    const row = await ler(id);
    expect(row.status).toBe("sem_correcao");
    expect(row.corrected_at).toBeNull();
  });

  it("pedido corrigido que volta a divergir vira persistente, e limpa o conserto vencido", async () => {
    // E o comportamento que justifica a tabela: distingue "atrasou e fechou" de
    // defeito estrutural.
    const id = `${PREFIXO}persistente`;
    await recordDetectedDivergences([
      { externalOrderId: id, day: "2026-09-07", tenderCents: 5000, ledgerCents: 3000, deltaCents: 2000 },
    ]);
    await markDivergenceOutcome(id, "corrigido", 5000);

    await recordDetectedDivergences([
      { externalOrderId: id, day: "2026-09-09", tenderCents: 7000, ledgerCents: 5000, deltaCents: 2000 },
    ]);

    const row = await ler(id);
    expect(row.status).toBe("persistente");
    expect(row.occurrences).toBe(2);
    // O "depois" do conserto anterior foi desmentido pela realidade.
    expect(row.ledger_cents_after).toBeNull();
    expect(row.corrected_at).toBeNull();
    // O orcamento de tentativas recomeca SO aqui, na reabertura: houve
    // evidencia nova de verdade. Redeteccao de quem nunca fechou nao zera nada,
    // senao o pedido sem conserto seria retentado todo dia para sempre.
    expect(row.attempts).toBe(0);
    expect(row.next_attempt_at).toBeNull();
  });

  it("redeteccao de quem nunca fechou preserva as tentativas ja gastas", async () => {
    const id = `${PREFIXO}sem-reset`;
    await recordDetectedDivergences([
      { externalOrderId: id, day: "2026-09-07", tenderCents: 5000, ledgerCents: 0, deltaCents: 5000 },
    ]);
    await markDivergenceOutcome(id, "pendente", 0, new Date("2026-12-01T00:00:00Z"));

    await recordDetectedDivergences([
      { externalOrderId: id, day: "2026-09-08", tenderCents: 5000, ledgerCents: 0, deltaCents: 5000 },
    ]);

    const row = await ler(id);
    expect(row.attempts).toBe(1);
    expect(row.next_attempt_at).not.toBeNull();
  });

  it("nao escreve nada quando a lista vem vazia", async () => {
    await expect(recordDetectedDivergences([])).resolves.toBe(0);
  });

  it("lista devolve a data gravada, sem escorregar de dia", async () => {
    const id = `${PREFIXO}data`;
    await recordDetectedDivergences([
      { externalOrderId: id, day: "2026-09-07", tenderCents: 100, ledgerCents: 0, deltaCents: 100 },
    ]);

    const linhas = await listDivergences({ limit: 500 });
    const alvo = linhas.find((linha) => linha.externalOrderId === id);
    expect(alvo?.day).toBe("2026-09-07");
  });

  it("conta por status sem quebrar quando um status nao existe", async () => {
    const contagem = await countDivergencesByStatus();
    expect(contagem).toHaveProperty("pendente");
    expect(contagem).toHaveProperty("persistente");
    expect(typeof contagem.corrigido).toBe("number");
  });

  /**
   * A fila — o consumidor que a tabela nunca teve.
   *
   * Estes testes rodam contra a MESMA tabela que a producao, entao nao da para
   * afirmar contagens absolutas: qualquer divergencia real do dia entraria na
   * conta. Duas defesas: os deltas de teste sao absurdamente altos (bilhoes de
   * centavos), o que garante que a ordenacao por |delta| os coloca na frente de
   * qualquer pedido de verdade; e as asserções sao sobre presenca, ausencia e
   * diferenca, nunca sobre o total.
   */
  describe("fila de retentativa", () => {
    const MAX_ATTEMPTS = 3;
    const DELTA_ALTO = 900_000_000;

    function idsDaFila(fila: { rows: { externalOrderId: string }[] }): string[] {
      return fila.rows.map((linha) => linha.externalOrderId);
    }

    it("nao devolve quem ainda esta de recuo", async () => {
      const pronto = `${PREFIXO}fila-pronto`;
      const recuado = `${PREFIXO}fila-recuado`;

      await recordDetectedDivergences([
        {
          externalOrderId: pronto,
          day: "2026-09-07",
          tenderCents: DELTA_ALTO,
          ledgerCents: 0,
          deltaCents: DELTA_ALTO,
        },
        {
          externalOrderId: recuado,
          day: "2026-09-07",
          tenderCents: DELTA_ALTO,
          ledgerCents: 0,
          deltaCents: DELTA_ALTO,
        },
      ]);
      await markDivergenceOutcome(recuado, "pendente", 0, new Date(Date.now() + 86_400_000));

      const fila = await listRetryableDivergences({ limit: 50, maxAttempts: MAX_ATTEMPTS });

      expect(idsDaFila(fila)).toContain(pronto);
      expect(idsDaFila(fila)).not.toContain(recuado);
    });

    it("nao devolve quem ja fechou", async () => {
      const fechado = `${PREFIXO}fila-fechado`;
      await recordDetectedDivergences([
        {
          externalOrderId: fechado,
          day: "2026-09-07",
          tenderCents: DELTA_ALTO,
          ledgerCents: 0,
          deltaCents: DELTA_ALTO,
        },
      ]);
      await markDivergenceOutcome(fechado, "corrigido", DELTA_ALTO);

      const fila = await listRetryableDivergences({ limit: 50, maxAttempts: MAX_ATTEMPTS });
      expect(idsDaFila(fila)).not.toContain(fechado);
    });

    it("para de devolver quando as tentativas se esgotam, mesmo sem recuo pendente", async () => {
      // O portao do teto e' independente do portao do tempo: aqui
      // next_attempt_at fica nulo (elegivel agora) e mesmo assim a linha sai.
      const esgotado = `${PREFIXO}fila-esgotado`;
      await recordDetectedDivergences([
        {
          externalOrderId: esgotado,
          day: "2026-09-07",
          tenderCents: DELTA_ALTO,
          ledgerCents: 0,
          deltaCents: DELTA_ALTO,
        },
      ]);

      for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
        await markDivergenceOutcome(esgotado, "pendente", 0, null);
      }

      expect((await ler(esgotado)).attempts).toBe(MAX_ATTEMPTS);
      const fila = await listRetryableDivergences({ limit: 50, maxAttempts: MAX_ATTEMPTS });
      expect(idsDaFila(fila)).not.toContain(esgotado);
    });

    it("o teto corta pelo menor dinheiro e diz quanto ficou para a proxima", async () => {
      const grande = `${PREFIXO}fila-grande`;
      const medio = `${PREFIXO}fila-medio`;
      const pequeno = `${PREFIXO}fila-pequeno`;

      await recordDetectedDivergences([
        {
          externalOrderId: grande,
          day: "2026-09-07",
          tenderCents: DELTA_ALTO + 2,
          ledgerCents: 0,
          deltaCents: DELTA_ALTO + 2,
        },
        {
          externalOrderId: medio,
          day: "2026-09-07",
          tenderCents: DELTA_ALTO + 1,
          ledgerCents: 0,
          deltaCents: DELTA_ALTO + 1,
        },
        {
          externalOrderId: pequeno,
          day: "2026-09-07",
          tenderCents: DELTA_ALTO,
          ledgerCents: 0,
          deltaCents: DELTA_ALTO,
        },
      ]);

      const fila = await listRetryableDivergences({ limit: 2, maxAttempts: MAX_ATTEMPTS });

      expect(idsDaFila(fila)).toEqual([grande, medio]);
      expect(idsDaFila(fila)).not.toContain(pequeno);
      // `eligible` conta a fila inteira, antes do LIMIT: e' o que permite ao
      // painel dizer "sobraram N" em vez de so "cortei no teto".
      expect(fila.eligible).toBeGreaterThanOrEqual(3);
      expect(fila.eligible - fila.rows.length).toBeGreaterThanOrEqual(1);
    });

    it("tentativa que explodiu conta e recua, sem inventar veredito sobre o ledger", async () => {
      const falhou = `${PREFIXO}fila-falhou`;
      await recordDetectedDivergences([
        { externalOrderId: falhou, day: "2026-09-07", tenderCents: 5000, ledgerCents: 0, deltaCents: 5000 },
      ]);

      await markDivergenceAttemptFailed(falhou, { nextAttemptAt: new Date(Date.now() + 86_400_000) });

      const row = await ler(falhou);
      expect(row.attempts).toBe(1);
      expect(row.status).toBe("pendente");
      // Nao houve medicao: afirmar um ledger "depois" a partir de uma falha de
      // transporte seria inventar numero.
      expect(row.ledger_cents_after).toBeNull();
      expect(row.next_attempt_at).not.toBeNull();
    });

    it("quem esgota falhando sai de pendente para nao parecer fila", async () => {
      const desistiu = `${PREFIXO}fila-desistiu`;
      await recordDetectedDivergences([
        { externalOrderId: desistiu, day: "2026-09-07", tenderCents: 5000, ledgerCents: 0, deltaCents: 5000 },
      ]);

      await markDivergenceAttemptFailed(desistiu, { nextAttemptAt: null, status: "sem_correcao" });

      const row = await ler(desistiu);
      expect(row.status).toBe("sem_correcao");
      expect(row.ledger_cents_after).toBeNull();
    });
  });

  /**
   * Reconferencia — a transicao de saida que a tabela nao tinha.
   *
   * Mesma disciplina da fila: a tabela e' a de producao, entao as asserções sao
   * sobre presenca e sobre a linha de teste, nunca sobre contagem absoluta.
   */
  describe("reconferencia", () => {
    const DELTA_ALTO = 800_000_000;

    function detectar(id: string) {
      return recordDetectedDivergences([
        {
          externalOrderId: id,
          day: "2026-09-07",
          tenderCents: DELTA_ALTO,
          ledgerCents: 0,
          deltaCents: DELTA_ALTO,
        },
      ]);
    }

    it("lista todo aberto, inclusive o que esta de recuo e o que esgotou tentativas", async () => {
      // A fila de retentativa nao traz nenhum destes dois. A reconferencia
      // precisa trazer: e' so leitura de ledger, e o `sem_correcao` esgotado e'
      // exatamente a linha que ficaria vermelha para sempre sem ela.
      const recuado = `${PREFIXO}reconf-recuado`;
      const esgotado = `${PREFIXO}reconf-esgotado`;
      const fechado = `${PREFIXO}reconf-ja-fechado`;
      await detectar(recuado);
      await detectar(esgotado);
      await detectar(fechado);
      await markDivergenceOutcome(recuado, "pendente", 0, new Date(Date.now() + 86_400_000));
      for (let i = 0; i < 6; i += 1) await markDivergenceOutcome(esgotado, "sem_correcao", 0);
      await markDivergenceOutcome(fechado, "corrigido", DELTA_ALTO);

      const ids = (await listOpenDivergences()).map((linha) => linha.externalOrderId);

      expect(ids).toContain(recuado);
      expect(ids).toContain(esgotado);
      expect(ids).not.toContain(fechado);
    });

    it("fecha sem gastar tentativa e sem datar como correcao", async () => {
      const id = `${PREFIXO}reconf-fecha`;
      await detectar(id);
      await markDivergenceOutcome(id, "pendente", 0, new Date(Date.now() + 86_400_000));

      const fechadas = await closeDivergencesByReconference([
        { externalOrderId: id, ledgerCents: DELTA_ALTO },
      ]);

      const row = await ler(id);
      expect(fechadas).toBe(1);
      expect(row.status).toBe("fechado_por_reconferencia");
      expect(Number(row.ledger_cents_after)).toBe(DELTA_ALTO);
      // Nenhuma chamada a Admin API: o orcamento nao se mexe.
      expect(row.attempts).toBe(1);
      // Quem consertou foi outro mecanismo; a rotina nao se credita.
      expect(row.corrected_at).toBeNull();
      expect(row.next_attempt_at).toBeNull();
    });

    it("sai da fila de retentativa e do conjunto aberto", async () => {
      const id = `${PREFIXO}reconf-sai-da-fila`;
      await detectar(id);
      await closeDivergencesByReconference([{ externalOrderId: id, ledgerCents: DELTA_ALTO }]);

      const fila = await listRetryableDivergences({ limit: 200, maxAttempts: 5 });
      const abertas = await listOpenDivergences();

      expect(fila.rows.map((linha) => linha.externalOrderId)).not.toContain(id);
      expect(abertas.map((linha) => linha.externalOrderId)).not.toContain(id);
    });

    it("nao reclassifica linha que ja tinha fechado por conserto", async () => {
      // Corrida entre a leitura e o UPDATE: quem ja esta `corrigido` guarda o
      // credito do conserto, e a reconferencia nao pode reescrever isso.
      const id = `${PREFIXO}reconf-corrigido`;
      await detectar(id);
      await markDivergenceOutcome(id, "corrigido", DELTA_ALTO);

      const fechadas = await closeDivergencesByReconference([
        { externalOrderId: id, ledgerCents: DELTA_ALTO },
      ]);

      expect(fechadas).toBe(0);
      expect((await ler(id)).status).toBe("corrigido");
    });

    it("fechado pela reconferencia que volta a divergir reabre como persistente", async () => {
      const id = `${PREFIXO}reconf-reabre`;
      await detectar(id);
      await markDivergenceOutcome(id, "pendente", 0, new Date(Date.now() + 86_400_000));
      await closeDivergencesByReconference([{ externalOrderId: id, ledgerCents: DELTA_ALTO }]);

      await detectar(id);

      const row = await ler(id);
      expect(row.status).toBe("persistente");
      // Reabertura e' evidencia nova: o orcamento recomeca, igual a um corrigido.
      expect(row.attempts).toBe(0);
      expect(row.next_attempt_at).toBeNull();
      expect(row.ledger_cents_after).toBeNull();
    });

    it("a contagem expoe o status novo", async () => {
      const contagem = await countDivergencesByStatus();
      expect(contagem.fechado_por_reconferencia).toBeGreaterThanOrEqual(1);
    });

    it("lista vazia nao escreve nada", async () => {
      await expect(closeDivergencesByReconference([])).resolves.toBe(0);
    });
  });
});
