import { describe, expect, it } from "vitest";

import {
  canCompare,
  describeCoverage,
  resolveCoverage,
} from "@/features/transactions/read-model-coverage";

const PISO = new Date("2026-08-01T00:00:00-03:00");

describe("cobertura de dados do read model", () => {
  it("periodo inteiro dentro da janela e full e nao mexe nas datas", () => {
    const inicio = new Date("2026-08-05T00:00:00-03:00");
    const fim = new Date("2026-08-10T23:59:59-03:00");

    const coverage = resolveCoverage(inicio, fim, PISO);

    expect(coverage.status).toBe("full");
    expect(coverage.start).toBe(inicio);
    expect(coverage.end).toBe(fim);
    expect(canCompare(coverage)).toBe(true);
    expect(describeCoverage(coverage)).toBeNull();
  });

  it("periodo que comeca antes do piso e recortado no piso", () => {
    // O caso do preset default d30: hoje comeca em 23/07 e o piso e 01/08.
    const coverage = resolveCoverage(
      new Date("2026-07-23T00:00:00-03:00"),
      new Date("2026-08-21T23:59:59-03:00"),
      PISO
    );

    expect(coverage.status).toBe("partial");
    expect(coverage.start).toBe(PISO);
    expect(describeCoverage(coverage)).toContain("a partir de");
  });

  it("periodo inteiro antes do piso e none e nao consulta nada", () => {
    // start/end nulos sao o contrato: em `none` o chamador nao deve abrir
    // conexao. Zero linhas com R$ 0,00 na tela le-se como "nao vendeu nada".
    const coverage = resolveCoverage(
      new Date("2026-06-01T00:00:00-03:00"),
      new Date("2026-06-30T23:59:59-03:00"),
      PISO
    );

    expect(coverage.status).toBe("none");
    expect(coverage.start).toBeNull();
    expect(coverage.end).toBeNull();
    expect(canCompare(coverage)).toBe(false);
    expect(describeCoverage(coverage)).toContain("Nao ha dados anteriores");
  });

  it("partial NAO sustenta comparacao", () => {
    // Comparar 20 dias de dado contra um periodo de 30 produz uma queda
    // inventada -- pior que a ausencia do numero, porque parece informacao.
    const coverage = resolveCoverage(
      new Date("2026-07-23T00:00:00-03:00"),
      new Date("2026-08-21T23:59:59-03:00"),
      PISO
    );

    expect(canCompare(coverage)).toBe(false);
  });

  it("periodo que termina exatamente no piso ainda tem dado", () => {
    // Fronteira inclusiva, igual ao piso do sync e ao recorte do CSV.
    const coverage = resolveCoverage(new Date("2026-07-20T00:00:00-03:00"), PISO, PISO);

    expect(coverage.status).toBe("partial");
    expect(coverage.start).toBe(PISO);
  });

  it("sem inicio pedido, o piso vira o inicio", () => {
    const coverage = resolveCoverage(null, new Date("2026-08-21T00:00:00-03:00"), PISO);

    expect(coverage.status).toBe("full");
    expect(coverage.start).toBe(PISO);
  });

  it("sem piso configurado nao afirma cobertura nenhuma", () => {
    const inicio = new Date("2020-01-01T00:00:00-03:00");
    const coverage = resolveCoverage(inicio, new Date("2020-12-31T00:00:00-03:00"), null);

    expect(coverage.status).toBe("full");
    expect(coverage.start).toBe(inicio);
    expect(describeCoverage(coverage)).toBeNull();
  });
});
