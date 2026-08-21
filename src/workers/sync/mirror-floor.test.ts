import { describe, expect, it } from "vitest";

import { isAboveMirrorFloor, mirrorSortAt, partitionByMirrorFloor } from "@/workers/sync/mirror-floor";

const FLOOR = new Date("2026-08-01T00:00:00-03:00");

describe("piso de data do mirror", () => {
  it("aceita exatamente o instante do piso", () => {
    // Inclusivo de proposito: o recorte do CSV de agosto foi `>=` no mesmo
    // literal. Se aqui fosse `>`, a primeira linha do arquivo seria considerada
    // inelegivel e a verificacao por faixa de data nunca fecharia.
    expect(isAboveMirrorFloor({ receivedAt: FLOOR, processedAt: null }, FLOOR)).toBe(true);
  });

  it("recusa um milissegundo antes do piso", () => {
    const antes = new Date(FLOOR.getTime() - 1);
    expect(isAboveMirrorFloor({ receivedAt: antes, processedAt: null }, FLOOR)).toBe(false);
  });

  it("aceita depois do piso", () => {
    const depois = new Date("2026-08-15T12:00:00-03:00");
    expect(isAboveMirrorFloor({ receivedAt: depois, processedAt: null }, FLOOR)).toBe(true);
  });

  it("cai em processed_at quando received_at e nulo", () => {
    const depois = new Date("2026-08-15T12:00:00-03:00");
    expect(mirrorSortAt({ receivedAt: null, processedAt: depois })).toBe(depois);
    expect(isAboveMirrorFloor({ receivedAt: null, processedAt: depois }, FLOOR)).toBe(true);
  });

  it("prefere received_at a processed_at", () => {
    // A mesma expressao do resto do sync: COALESCE(received_at, processed_at).
    // Se aqui fosse o maior dos dois, o piso e a marca d'agua discordariam
    // sobre a data de uma linha.
    const antes = new Date("2026-07-20T00:00:00-03:00");
    const depois = new Date("2026-08-15T00:00:00-03:00");
    expect(isAboveMirrorFloor({ receivedAt: antes, processedAt: depois }, FLOOR)).toBe(false);
  });

  it("recusa linha sem data nenhuma", () => {
    // Inelegivel de proposito: o CSV tambem nao as trouxe (o recorte era por
    // data) e findRawPayloadsAfter tambem as exclui. Inclui-las quebraria a
    // contagem por faixa de data, que e a unica verificacao disponivel.
    expect(isAboveMirrorFloor({ receivedAt: null, processedAt: null }, FLOOR)).toBe(false);
    expect(mirrorSortAt({ receivedAt: null, processedAt: null })).toBeNull();
  });

  it("particiona somando o total e preservando a ordem", () => {
    const rows = [
      { id: "a", receivedAt: new Date("2026-08-02T00:00:00-03:00"), processedAt: null },
      { id: "b", receivedAt: new Date("2026-07-31T23:59:59-03:00"), processedAt: null },
      { id: "c", receivedAt: null, processedAt: null },
      { id: "d", receivedAt: FLOOR, processedAt: null },
      { id: "e", receivedAt: new Date("2026-04-26T00:00:00-03:00"), processedAt: null },
    ];

    const result = partitionByMirrorFloor(rows, FLOOR);

    expect(result.eligible.map((r) => r.id)).toEqual(["a", "d"]);
    expect(result.belowFloor).toBe(2);
    expect(result.undated).toBe(1);
    // Invariante que os contadores do log dependem: nada desaparece da conta.
    expect(result.eligible.length + result.belowFloor + result.undated).toBe(rows.length);
  });

  it("devolve conjunto vazio sem contar nada para lote vazio", () => {
    expect(partitionByMirrorFloor([], FLOOR)).toEqual({ eligible: [], belowFloor: 0, undated: 0 });
  });
});
