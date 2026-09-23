import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async redirects() {
    return [
      { source: "/financeiro", destination: "/dashboard", permanent: false },
      { source: "/financeiro/:path*", destination: "/:path*", permanent: false },
      // TEMPORARIO: a tela de marketplaces saiu de /fluxo-de-caixa. Enquanto a
      // tela nova de Fluxo de Caixa nao existir, toda URL antiga vai para
      // Marketplaces (a querystring segue junto). Quando a tela nova entrar,
      // esta regra vira as duas regras `has` da decisao D2 em
      // docs/PLAN-SEPARACAO-MARKETPLACES-FLUXO-CAIXA.md -- incondicional, ela
      // tornaria a rota reaproveitada inalcancavel.
      { source: "/fluxo-de-caixa", destination: "/marketplaces", permanent: false },
      { source: "/fluxo-de-caixa/:path*", destination: "/marketplaces/:path*", permanent: false },
    ];
  },
};

export default nextConfig;
