import path from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  test: {
    environment: "node",
    globals: true,
    // Roda no mesmo fuso da Vercel (UTC), e nao no da maquina de quem executa.
    // As fronteiras de dia do sistema sao America/Sao_Paulo por literal; se um
    // teste passar aqui so porque a maquina esta em horario de Brasilia, ele
    // esta escondendo exatamente o defeito que derrubava os numeros em
    // producao. Ver o cabecalho de src/lib/date-utils.ts.
    env: { TZ: "UTC" },
  },
});
