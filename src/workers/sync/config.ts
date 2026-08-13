import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  OMS_DB_URL: z.string().min(1, "OMS_DB_URL nao configurada"),
  CORE_DB_URL: z.string().min(1, "CORE_DB_URL nao configurada"),
  BATCH_SIZE: z.coerce.number().int().min(1).max(1000).default(100),
  MAX_RETRIES: z.coerce.number().int().min(1).max(20).default(5),
  // Alvo do controle tecnico de sync. "core" (padrao) mantem o OMS read-only.
  // "oms" e apenas fallback de emergencia para rollback controlado.
  SYNC_CONTROL_TARGET: z.enum(["core", "oms"]).default("core"),
  // Retencao da DLQ (integration.failed_jobs) no CORE, em dias.
  DLQ_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(90),
  // Quanto a descoberta incremental recua antes da marca d'agua a cada ciclo.
  // Absorve linhas inseridas no OMS fora de ordem (received_at anterior ao
  // que ja foi lido), que de outro modo ficariam para tras para sempre.
  // O custo e reler essa janela curta por ciclo; a dedup por
  // findExistingRawPayloadIds impede reenfileiramento.
  SYNC_WATERMARK_GRACE_SECONDS: z.coerce.number().int().min(0).max(86_400).default(300),
});

export type WorkerEnv = z.infer<typeof envSchema>;

export function getWorkerEnv(): WorkerEnv {
  return envSchema.parse(process.env);
}
