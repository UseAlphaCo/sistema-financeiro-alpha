import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async redirects() {
    return [
      { source: "/financeiro", destination: "/dashboard", permanent: false },
      { source: "/financeiro/:path*", destination: "/:path*", permanent: false },
      // Links salvos da tela de marketplaces, que morava em /fluxo-de-caixa ate
      // 23/09/2026. Condicional de proposito (decisao D2 em
      // docs/PLAN-SEPARACAO-MARKETPLACES-FLUXO-CAIXA.md): `redirects()` roda antes
      // do roteamento, e uma regra incondicional deixaria a tela nova de Fluxo de
      // Caixa inalcancavel. A tela antiga sempre submetia `marketplace`, entao a
      // assinatura cobre todo link que ela gerava.
      // INVARIANTE: a tela de Fluxo de Caixa nao pode aceitar `marketplace` nem
      // `paymentMethod`. Remover estas regras a partir de 23/12/2026.
      {
        source: "/fluxo-de-caixa",
        has: [{ type: "query", key: "marketplace" }],
        destination: "/marketplaces",
        permanent: false,
      },
      {
        source: "/fluxo-de-caixa",
        has: [{ type: "query", key: "paymentMethod" }],
        destination: "/marketplaces",
        permanent: false,
      },
    ];
  },
};

export default nextConfig;
