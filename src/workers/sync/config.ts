import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  OMS_DB_URL: z.string().min(1, "OMS_DB_URL nao configurada"),
  CORE_DB_URL: z.string().min(1, "CORE_DB_URL nao configurada"),
  BATCH_SIZE: z.coerce.number().int().min(1).max(1000).default(100),
  MAX_RETRIES: z.coerce.number().int().min(1).max(20).default(5),
});

export type WorkerEnv = z.infer<typeof envSchema>;

export function getWorkerEnv(): WorkerEnv {
  return envSchema.parse(process.env);
}
