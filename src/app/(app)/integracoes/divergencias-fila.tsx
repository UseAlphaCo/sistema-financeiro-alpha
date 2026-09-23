"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Fila de tratamento das divergencias entre o ledger e a Shopify, por pedido.
 *
 * Ate aqui a lista so existia no CLI. A tela le a mesma rota que aplica as acoes
 * e usa as mesmas leituras do CLI, entao os dois contam a mesma coisa.
 *
 * "Reprocessar" nao chama a Shopify na hora: devolve o pedido para a rodada
 * diaria das 10:50 BRT, que tem teto e portao de ritmo proprios. O texto do botao
 * e a ajuda dizem isso, porque um "reprocessar" que parece imediato e nao muda
 * nada na tela e' o tipo de interface que ensina a apertar duas vezes.
 */

type Status =
  | "pendente"
  | "corrigido"
  | "persistente"
  | "sem_correcao"
  | "fechado_por_reconferencia"
  | "aceito";

type Divergencia = {
  externalOrderId: string;
  day: string;
  tenderCents: number;
  ledgerCentsBefore: number;
  deltaCents: number;
  status: Status;
  occurrences: number;
  attempts: number;
  lastCheckedAt: string;
  nextAttemptAt: string | null;
};

type Fila = {
  rows: Divergencia[];
  counts: Record<Status, number>;
  maxAttempts: number;
};

type ApiEnvelope<T> = { success: boolean; data: T | null; error: string | null };

const ENDPOINT = "/api/financial/integrations/shopify/divergences";

const STATUS_ROTULO: Record<Status, { texto: string; classe: string }> = {
  pendente: { texto: "Pendente", classe: "bg-amber-50 text-amber-800 ring-amber-600/20" },
  persistente: { texto: "Persistente", classe: "bg-red-50 text-red-700 ring-red-600/20" },
  sem_correcao: { texto: "Sem correção", classe: "bg-red-50 text-red-700 ring-red-600/20" },
  corrigido: { texto: "Corrigido", classe: "bg-emerald-50 text-emerald-700 ring-emerald-600/20" },
  fechado_por_reconferencia: {
    texto: "Fechado na reconferência",
    classe: "bg-gray-100 text-gray-600 ring-gray-500/20",
  },
  aceito: { texto: "Aceito", classe: "bg-gray-100 text-gray-600 ring-gray-500/20" },
};

function dinheiro(cents: number): string {
  return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function momento(iso: string): string {
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "America/Sao_Paulo",
  }).format(new Date(iso));
}

function diaCurto(day: string): string {
  const [ano, mes, dia] = day.split("-");
  return `${dia}/${mes}/${ano}`;
}

/** O que dizer na coluna "próxima tentativa". Mesmos tres casos do CLI. */
function proxima(linha: Divergencia, maxAttempts: number): string {
  if (linha.attempts >= maxAttempts) return "esgotada — precisa de gente";
  if (linha.nextAttemptAt === null) return "na próxima rodada";
  return momento(linha.nextAttemptAt);
}

/** Ja entra na proxima rodada: reprocessar nao mudaria nada. */
function jaNaFila(linha: Divergencia, maxAttempts: number): boolean {
  return linha.nextAttemptAt === null && linha.attempts < maxAttempts;
}

export default function DivergenciasFila() {
  const [fila, setFila] = useState<Fila | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [aceitando, setAceitando] = useState<string | null>(null);
  const [nota, setNota] = useState("");
  const [aviso, setAviso] = useState<{ tipo: "ok" | "erro"; texto: string } | null>(null);

  const carregar = useCallback(async () => {
    setCarregando(true);
    try {
      const response = await fetch(ENDPOINT, { cache: "no-store" });
      const body = (await response.json()) as ApiEnvelope<Fila>;
      if (!response.ok || !body.success || !body.data) {
        throw new Error(body.error ?? "Falha ao carregar a fila.");
      }
      setFila(body.data);
      setErro(null);
    } catch (error) {
      setErro(error instanceof Error ? error.message : "Falha ao carregar a fila.");
    } finally {
      setCarregando(false);
    }
  }, []);

  // Mesmo arranjo de integracoes-client: o setTimeout tira o setState do corpo
  // sincrono do efeito.
  useEffect(() => {
    const timer = setTimeout(() => {
      void carregar();
    }, 0);
    return () => clearTimeout(timer);
  }, [carregar]);

  async function agir(orderId: string, payload: { action: "reprocessar" } | { action: "aceitar"; note?: string }) {
    setOcupado(orderId);
    setAviso(null);
    try {
      const response = await fetch(`${ENDPOINT}/${encodeURIComponent(orderId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = (await response.json()) as ApiEnvelope<Divergencia>;
      if (!response.ok || !body.success) {
        throw new Error(body.error ?? "Falha ao aplicar a ação.");
      }
      setAviso({
        tipo: "ok",
        texto:
          payload.action === "reprocessar"
            ? `Pedido ${orderId} volta a ser tentado na rodada das 10:50.`
            : `Divergência do pedido ${orderId} aceita.`,
      });
      setAceitando(null);
      setNota("");
    } catch (error) {
      setAviso({
        tipo: "erro",
        texto: error instanceof Error ? error.message : "Falha ao aplicar a ação.",
      });
    } finally {
      setOcupado(null);
      // Recarrega mesmo no erro: o motivo mais comum de falha e' "ja fechou",
      // e a fila atualizada e' a resposta.
      await carregar();
    }
  }

  return (
    <section className="rounded-lg border border-gray-200 bg-white p-4">
      <header className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-gray-900">Divergências com a Shopify</h2>
          <p className="mt-0.5 text-xs text-gray-500">
            Pedidos em que o ledger discorda do que a Shopify recebeu. Estado de agora — a rodada diária
            corrige o que consegue às 10:50.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void carregar()}
          disabled={carregando}
          className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-50"
        >
          {carregando ? "Atualizando…" : "Atualizar"}
        </button>
      </header>

      {fila && (
        <dl className="mb-3 grid grid-cols-2 gap-3 text-[11px] sm:grid-cols-4">
          <Contador rotulo="Pendentes" valor={fila.counts.pendente} tom="warn" />
          <Contador rotulo="Persistentes" valor={fila.counts.persistente} tom="crit" />
          <Contador rotulo="Sem correção" valor={fila.counts.sem_correcao} tom="crit" />
          <Contador rotulo="Aceitas (histórico)" valor={fila.counts.aceito} tom="neutro" />
        </dl>
      )}

      <p aria-live="polite" className="min-h-0">
        {aviso && (
          <span
            className={`mb-3 block rounded px-3 py-2 text-xs ${
              aviso.tipo === "ok" ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-700"
            }`}
          >
            {aviso.texto}
          </span>
        )}
      </p>

      {erro && !fila ? (
        <p className="rounded border border-dashed border-red-300 px-3 py-4 text-center text-xs text-red-700">
          — Não foi possível carregar a fila: {erro}
        </p>
      ) : !fila ? (
        <p className="px-3 py-4 text-center text-xs text-gray-500">Carregando…</p>
      ) : fila.rows.length === 0 ? (
        <p className="rounded border border-dashed border-gray-300 px-3 py-4 text-center text-xs text-gray-500">
          Nenhuma divergência aberta. Todo pedido comparado bate com a Shopify ou já foi tratado.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-xs">
            <thead className="bg-gray-50 text-[11px] uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-3 py-2 font-medium">Pedido</th>
                <th className="px-3 py-2 font-medium">Dia</th>
                <th className="px-3 py-2 text-right font-medium">Shopify − ledger</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 text-right font-medium">Tentativas</th>
                <th className="px-3 py-2 font-medium">Última verificação</th>
                <th className="px-3 py-2 font-medium">Próxima tentativa</th>
                <th className="px-3 py-2 font-medium">
                  <span className="sr-only">Ações</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {fila.rows.map((linha) => {
                const rotulo = STATUS_ROTULO[linha.status];
                const emFila = jaNaFila(linha, fila.maxAttempts);
                const trabalhando = ocupado === linha.externalOrderId;
                return (
                  <tr key={linha.externalOrderId} className="align-top">
                    <td className="px-3 py-2 font-mono text-gray-800">{linha.externalOrderId}</td>
                    <td className="px-3 py-2 text-gray-700">{diaCurto(linha.day)}</td>
                    <td
                      className="px-3 py-2 text-right font-medium tabular-nums text-gray-900"
                      title={`Shopify ${dinheiro(linha.tenderCents)} · ledger ${dinheiro(linha.ledgerCentsBefore)}`}
                    >
                      {dinheiro(linha.deltaCents)}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${rotulo.classe}`}
                      >
                        {rotulo.texto}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-gray-700">
                      {linha.attempts} / {fila.maxAttempts}
                    </td>
                    <td className="px-3 py-2 text-gray-600">{momento(linha.lastCheckedAt)}</td>
                    <td className="px-3 py-2 text-gray-600">{proxima(linha, fila.maxAttempts)}</td>
                    <td className="px-3 py-2">
                      {aceitando === linha.externalOrderId ? (
                        <form
                          className="flex min-w-[16rem] flex-col gap-1"
                          onSubmit={(event) => {
                            event.preventDefault();
                            void agir(linha.externalOrderId, {
                              action: "aceitar",
                              note: nota.trim() || undefined,
                            });
                          }}
                        >
                          <label htmlFor={`nota-${linha.externalOrderId}`} className="text-[11px] text-gray-600">
                            Por que aceitar? (opcional, fica no histórico)
                          </label>
                          <textarea
                            id={`nota-${linha.externalOrderId}`}
                            value={nota}
                            onChange={(event) => setNota(event.target.value)}
                            maxLength={500}
                            rows={2}
                            className="rounded border border-gray-300 px-2 py-1 text-xs"
                          />
                          <div className="flex gap-2">
                            <button
                              type="submit"
                              disabled={trabalhando}
                              className="rounded bg-gray-900 px-2 py-1 text-xs font-medium text-white disabled:opacity-50"
                            >
                              {trabalhando ? "Aceitando…" : "Confirmar aceite"}
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setAceitando(null);
                                setNota("");
                              }}
                              className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-700"
                            >
                              Cancelar
                            </button>
                          </div>
                        </form>
                      ) : (
                        <div className="flex gap-2 whitespace-nowrap">
                          <button
                            type="button"
                            disabled={trabalhando || emFila}
                            title={
                              emFila
                                ? "Já entra na próxima rodada."
                                : "Volta a ser tentado na rodada das 10:50. Não chama a Shopify agora."
                            }
                            onClick={() => void agir(linha.externalOrderId, { action: "reprocessar" })}
                            className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {trabalhando ? "Enviando…" : "Reprocessar"}
                          </button>
                          <button
                            type="button"
                            disabled={trabalhando}
                            onClick={() => {
                              setAceitando(linha.externalOrderId);
                              setNota("");
                            }}
                            className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                          >
                            Aceitar
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {erro && fila && (
        <p className="mt-2 text-[11px] text-red-700">
          A última atualização falhou ({erro}); os dados acima podem estar desatualizados.
        </p>
      )}

      <p className="mt-2 text-[11px] text-gray-500">
        Aceitar fecha a divergência por decisão humana e registra quem aceitou. Se o valor do pedido
        mudar depois, ela reabre como persistente.
      </p>
    </section>
  );
}

function Contador({
  rotulo,
  valor,
  tom,
}: {
  rotulo: string;
  valor: number;
  tom: "warn" | "crit" | "neutro";
}) {
  const cor =
    valor === 0 || tom === "neutro"
      ? "text-gray-800"
      : tom === "crit"
        ? "text-red-700"
        : "text-amber-700";
  return (
    <div>
      <dt className="text-gray-500">{rotulo}</dt>
      <dd className={`text-sm font-semibold tabular-nums ${cor}`}>{valor.toLocaleString("pt-BR")}</dd>
    </div>
  );
}
