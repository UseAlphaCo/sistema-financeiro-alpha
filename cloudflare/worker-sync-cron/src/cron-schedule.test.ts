import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import worker, { type Env } from "./index";

/**
 * Guarda contra o unico modo de falha que este worker tem e que NAO aparece no
 * deploy: as expressoes de cron vivem em dois arquivos e precisam ser iguais
 * caractere a caractere.
 *
 * wrangler.jsonc registra os gatilhos no Cloudflare; src/index.ts usa a mesma
 * string como CHAVE de despacho. Divergir nao quebra o `wrangler deploy` nem
 * emite aviso: o cron dispara no horario, cai no `default` e so lanca erro nos
 * logs do Cloudflare -- que ninguem le por iniciativa propria. O trabalho
 * simplesmente para de acontecer, em silencio, ate alguem notar pelo numero
 * errado na tela.
 *
 * Le os dois arquivos do disco de proposito, em vez de importar o modulo: o
 * objetivo e comparar o que esta ESCRITO nos dois lugares.
 */

const WORKER_DIR = join(__dirname, "..");

function lerCronsDoWrangler(): string[] {
  const conteudo = readFileSync(join(WORKER_DIR, "wrangler.jsonc"), "utf8");

  const inicio = conteudo.indexOf('"crons"');
  expect(inicio, 'wrangler.jsonc perdeu a chave "crons"').toBeGreaterThan(-1);
  const abre = conteudo.indexOf("[", inicio);
  const fecha = conteudo.indexOf("]", abre);
  const bloco = conteudo.slice(abre + 1, fecha);

  // Descarta linha de comentario antes de procurar string: os comentarios deste
  // arquivo citam expressoes de cron no texto, e elas nao sao gatilhos.
  return bloco
    .split("\n")
    .filter((linha) => !linha.trim().startsWith("//"))
    .flatMap((linha) => [...linha.matchAll(/"([^"]+)"/g)].map((m) => m[1]));
}

function lerCronsDoIndex(): string[] {
  const conteudo = readFileSync(join(WORKER_DIR, "src", "index.ts"), "utf8");

  const constantes = [...conteudo.matchAll(/^const \w*CRON\w* = "([^"]+)";$/gm)].map((m) => m[1]);

  const inicioMapa = conteudo.indexOf("const MATERIALIZE_CRONS");
  expect(inicioMapa, "index.ts perdeu MATERIALIZE_CRONS").toBeGreaterThan(-1);
  const abre = conteudo.indexOf("{", inicioMapa);
  const fecha = conteudo.indexOf("};", abre);
  const chavesDoMapa = [...conteudo.slice(abre, fecha).matchAll(/"([^"]+)":/g)].map((m) => m[1]);

  return [...constantes, ...chavesDoMapa];
}

describe("cron: wrangler.jsonc x src/index.ts", () => {
  const noWrangler = lerCronsDoWrangler();
  const noIndex = lerCronsDoIndex();

  it("registra pelo menos os gatilhos que o codigo espera", () => {
    // Sanidade da propria extracao: se um dos parsers devolver vazio, os
    // asserts de igualdade abaixo passariam sem comparar nada.
    expect(noWrangler.length).toBeGreaterThan(0);
    expect(noIndex.length).toBeGreaterThan(0);
  });

  it("todo cron despachado pelo codigo esta registrado no wrangler", () => {
    // Sentido "esqueci de registrar": o codigo sabe tratar, mas o gatilho nunca
    // dispara. O trabalho some sem nenhum erro em lugar nenhum.
    const naoRegistrados = noIndex.filter((cron) => !noWrangler.includes(cron));
    expect(naoRegistrados).toEqual([]);
  });

  it("todo cron registrado no wrangler cai em algum caso do codigo", () => {
    // Sentido "esqueci de tratar": o gatilho dispara e cai no `default`, que so
    // lanca erro nos logs do Cloudflare.
    const naoTratados = noWrangler.filter((cron) => !noIndex.includes(cron));
    expect(naoTratados).toEqual([]);
  });

  it("nao registra o mesmo cron duas vezes", () => {
    expect(noWrangler).toEqual([...new Set(noWrangler)]);
  });

  it("mantem a ordem da janela da manha: sync, resolucao, materializacao, verificacao", () => {
    // A meta das 11:00 BRT depende da ORDEM, nao de cada cron isolado. Um
    // minuto trocado sem olhar os vizinhos quebra a corrente com todos os
    // horarios ainda parecendo razoaveis.
    const minutoUtc = (cron: string) => {
      const [minuto, hora] = cron.split(" ");
      return Number(hora) * 60 + Number(minuto);
    };

    const sync = minutoUtc("0 13 * * *"); // 10:00 BRT, dentro da lista do sync
    const resolucao = minutoUtc("15 13 * * *");
    const materializacao = minutoUtc("40 13 * * *");
    const verificacao = minutoUtc("50 13 * * *");

    expect(noWrangler).toContain("15 13 * * *");
    expect(noWrangler).toContain("40 13 * * *");
    expect(noWrangler).toContain("50 13 * * *");
    // O sync das 10:00 BRT vem de uma lista de horas, nao de uma linha propria.
    expect(noWrangler.some((cron) => /^0 .*\b13\b.* \* \* \*$/.test(cron))).toBe(true);

    expect(sync).toBeLessThan(resolucao);
    expect(resolucao).toBeLessThan(materializacao);
    expect(materializacao).toBeLessThan(verificacao);
  });
});

/**
 * Paridade de string prova que a chave existe; nao prova que ela leva ao lugar
 * certo. Estes testes disparam de fato cada cron registrado e olham a URL que
 * o worker chamou -- e' o que pega offset de dia trocado entre os passes de
 * materializacao, que a comparacao textual nao enxerga.
 */
describe("cron: despacho", () => {
  const env: Env = {
    APP_BASE_URL: "https://exemplo.invalido",
    CRON_SECRET: "segredo-de-teste",
  };

  let chamadas: string[];

  beforeEach(() => {
    chamadas = [];
    vi.stubGlobal("fetch", async (url: string) => {
      chamadas.push(url);
      return { ok: true, status: 200, text: async () => "" } as unknown as Response;
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("nenhum cron registrado cai no default", async () => {
    for (const cron of lerCronsDoWrangler()) {
      // Um cron desconhecido lanca; o teste falha com a expressao no erro.
      await expect(worker.scheduled({ cron }, env)).resolves.toBeUndefined();
    }

    expect(chamadas).toHaveLength(lerCronsDoWrangler().length);
  });

  it("cada cron chama a rota que lhe corresponde", async () => {
    const esperado: Array<[string, string]> = [
      ["0 1,4,7,10,13,16,19,22 * * *", "/api/internal/cron/worker-sync"],
      ["0 */2 * * *", "/api/internal/cron/shopify-payment-resolution"],
      ["15 13 * * *", "/api/internal/cron/shopify-payment-resolution"],
      ["0 2 * * *", "/api/internal/cron/materialize-orders"],
      ["30 10 * * *", "/api/internal/cron/materialize-orders"],
      ["40 13 * * *", "/api/internal/cron/materialize-orders"],
      ["30 2 * * *", "/api/internal/cron/materialize-orders"],
      ["50 13 * * *", "/api/internal/cron/shopify-verify"],
    ];

    for (const [cron, rota] of esperado) {
      chamadas = [];
      await worker.scheduled({ cron }, env);
      expect(chamadas[0], `cron ${cron}`).toContain(rota);
    }
  });

  it("o passe das 10:15 usa lote maior que o passe regular", async () => {
    // O passe de fechamento precisa DRENAR a fila, nao so avancar nela: sem
    // lote maior, o retardatario de D-1 fica atras dos pedidos de D-0 (a fila
    // ordena por external_order_id DESC) e escapa da materializacao das 10:40.
    await worker.scheduled({ cron: "0 */2 * * *" }, env);
    await worker.scheduled({ cron: "15 13 * * *" }, env);

    const [regular, fechamento] = chamadas.map((url) => new URL(url).searchParams);

    expect(Number(fechamento.get("batchSize"))).toBeGreaterThan(Number(regular.get("batchSize")));
    expect(Number(fechamento.get("sinceDays"))).toBeLessThanOrEqual(Number(regular.get("sinceDays")));
  });

  it("os quatro passes de materializacao cobrem D-0, D-1 (duas vezes) e D-2", async () => {
    // Congela o relogio: o offset vira data de calendario em America/Sao_Paulo,
    // e sem isso o teste falharia na virada do dia.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-09T13:40:00.000Z")); // 10:40 BRT

    for (const cron of ["0 2 * * *", "30 10 * * *", "40 13 * * *", "30 2 * * *"]) {
      await worker.scheduled({ cron }, env);
    }

    const dias = chamadas.map((url) => new URL(url).searchParams.get("days"));

    expect(dias).toEqual(["2026-09-09", "2026-09-08", "2026-09-08", "2026-09-07"]);
  });
});
