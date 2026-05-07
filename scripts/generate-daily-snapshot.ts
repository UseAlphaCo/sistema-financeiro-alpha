import { saveDailySnapshot } from "../src/core/cache/dailySnapshot";
import { listTransactionsForYesterday } from "../src/features/transactions/repository";

async function main() {
  // Calcular data de ontem (UTC)
  const now = new Date();
  const yesterday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));

  // Buscar dados consolidados de ontem
  const data = await listTransactionsForYesterday();

  // Salvar snapshot
  await saveDailySnapshot(yesterday, data, { generatedBy: "job" });

   
  console.log("Daily snapshot salvo para:", yesterday.toISOString().slice(0, 10));
}

main().catch((err) => {
   
  console.error(err);
  process.exit(1);
});
