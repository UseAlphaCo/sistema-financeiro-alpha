import { describe, expect, it } from "vitest";

import { buildEntriesWhere } from "@/features/cash-flow/entries-repository";

const RANGE = {
  start: new Date("2026-09-10T03:00:00.000Z"),
  end: new Date("2026-09-11T02:59:59.999Z"),
};

describe("buildEntriesWhere", () => {
  // Remover qualquer uma destas clausulas precisa quebrar um teste: sao elas que
  // mantem venda de marketplace, pendente e excluido fora do Fluxo de Caixa.
  it("sempre restringe a lancamentos cadastrados, aprovados e nao excluidos", () => {
    expect(buildEntriesWhere(RANGE)).toEqual({
      deletedAt: null,
      source: { in: ["manual", "import"] },
      status: { in: ["approved", "applied"] },
      occurredAt: { gte: RANGE.start, lte: RANGE.end },
    });
  });

  it("nunca inclui origens de marketplace", () => {
    const where = buildEntriesWhere(RANGE);
    const sources = (where.source as { in: string[] }).in;
    expect(sources).not.toContain("integration");
    expect(sources).not.toContain("webhook");
  });

  it("acrescenta categoria e tipo sem perder o recorte base", () => {
    expect(buildEntriesWhere(RANGE, { categoryId: "cat-1", type: "transfer" })).toMatchObject({
      deletedAt: null,
      source: { in: ["manual", "import"] },
      status: { in: ["approved", "applied"] },
      categoryId: "cat-1",
      type: "transfer",
    });
  });
});
