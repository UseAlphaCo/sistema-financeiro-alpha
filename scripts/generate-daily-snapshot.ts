import { saveDailySnapshot } from "../src/core/cache/dailySnapshot";
import { listTransactionsForYesterday } from "../src/features/transactions/repository";
import { addDaysToDayKey, zonedDayKey } from "../src/lib/date-utils";

async function main() {
  // Ontem no dia de Brasilia, nao em UTC: quem le o snapshot (isYesterdayRange)
  // procura por esta chave, e entre 21:00 e 23:59 de Brasilia o dia UTC ja e
  // outro -- o snapshot ficaria gravado numa chave que ninguem consulta.
  const yesterdayKey = addDaysToDayKey(zonedDayKey(new Date()), -1);
  const yesterday = new Date(`${yesterdayKey}T00:00:00.000Z`);

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
