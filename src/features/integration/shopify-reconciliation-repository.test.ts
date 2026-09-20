// O vitest nao carrega .env por conta propria: sem isto, `conn` fica undefined
// e o teste toma o caminho de skip em silencio.
import "dotenv/config";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closeShopifyReconciliationPool,
  countDivergencesByStatus,
  ensureShopifyReconciliationTable,
  listDivergences,
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
});
