import { auth } from "@/core/auth/auth";

import IntegrationsHealthPanel from "../_components/IntegrationsHealthPanel";
import DivergenciasFila from "./divergencias-fila";
import IntegracoesClient from "./integracoes-client";

/**
 * Wrapper de servidor da tela de Integracoes.
 *
 * A tela em si continua sendo client component (polling do job em curso). O que
 * este wrapper acrescenta e' o painel de saude do pipeline, que so admin ve.
 *
 * O gate de role fica AQUI e nao no cliente: o proxy (src/proxy.ts) libera
 * /integracoes para admin e financeiro, entao mandar os dados de saude para o
 * navegador e esconder com CSS entregaria o conteudo a quem nao deve ve-lo. Em
 * server component o dado nem chega a ser buscado para quem nao e' admin.
 */
export default async function IntegracoesPage() {
  const session = await auth();
  const role = session?.user?.role;
  const isAdmin = role === "admin";
  // A fila de divergencias e' trabalho do financeiro tambem, ao contrario do
  // painel de saude. A rota que a alimenta aplica a mesma regra de role.
  const podeTratarDivergencias = role === "admin" || role === "financeiro";

  return (
    <div className="space-y-6">
      {isAdmin && <IntegrationsHealthPanel />}
      {podeTratarDivergencias && <DivergenciasFila />}
      <IntegracoesClient />
    </div>
  );
}
