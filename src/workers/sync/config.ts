import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  OMS_DB_URL: z.string().min(1, "OMS_DB_URL nao configurada"),
  CORE_DB_URL: z.string().min(1, "CORE_DB_URL nao configurada"),
  BATCH_SIZE: z.coerce.number().int().min(1).max(1000).default(100),
  MAX_RETRIES: z.coerce.number().int().min(1).max(20).default(5),
  // Retencao da DLQ (integration.failed_jobs) no CORE, em dias.
  DLQ_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(90),
  // Quanto a descoberta incremental recua antes da marca d'agua a cada ciclo.
  // Absorve linhas inseridas no OMS fora de ordem (received_at anterior ao
  // que ja foi lido), que de outro modo ficariam para tras para sempre.
  // O custo e reler essa janela curta por ciclo; a dedup por
  // findExistingRawPayloadIds impede reenfileiramento.
  SYNC_WATERMARK_GRACE_SECONDS: z.coerce.number().int().min(0).max(86_400).default(300),
  // Como o ciclo automatico descobre o que falta no mirror.
  //
  // "ctid"      varredura por cursor fisico de pagina. Padrao. Nao depende de
  //             indice no OMS, e o unico modo que funciona hoje.
  // "watermark" keyset por tempo (o modo antigo). Mantido so como rollback:
  //             exige um indice em (COALESCE(received_at, processed_at), id)
  //             que o OMS nao tem, entao estoura o statement_timeout de 30 s.
  //             Trocar aqui reverte o desenho inteiro sem deploy.
  SYNC_DISCOVERY_MODE: z.enum(["ctid", "watermark"]).default("ctid"),
  // Paginas de heap por chunk de descoberta.
  //
  // 5.000 paginas ~ 65k linhas. O Tid Range Scan em si custa ~2 s (medido: 4 s
  // para 10.000 paginas), mas o chunk inteiro inclui anti-join e
  // enfileiramento; a 10.000 paginas um chunk levou 36 s contra producao e
  // consumia o orcamento de descoberta sozinho. Chunk menor tambem encurta a
  // janela em que inserts concorrentes ficam invisiveis ao snapshot do
  // statement.
  SYNC_CHUNK_BLOCKS: z.coerce.number().int().min(500).max(50_000).default(5_000),
  // Orcamento de tempo do ciclo. Fica abaixo do maxDuration de 60 s da rota de
  // cron para o ciclo terminar limpo em vez de ser morto no meio de um chunk.
  SYNC_CYCLE_BUDGET_MS: z.coerce.number().int().min(5_000).max(600_000).default(45_000),
  // Piso de data do mirror: nada anterior a isto entra em mirror.raw_payloads.
  //
  // O mirror deixou de ser copia integral do OMS em 2026-08-21, quando as
  // 604.418 linhas de 26/04 a 31/07 foram truncadas de proposito. Sem o piso, a
  // auditoria por ctid enxerga essas linhas como ausentes e as rebaixa de novo:
  // o truncate se auto-reverte e o consumo que derrubou o Supabase em 11/08
  // volta inteiro.
  //
  // Vem do ambiente porque o piso e politica e vai se mover. Mas o DEFAULT e o
  // piso, nao "sem piso": a falha segura, se a variavel faltar, e nao rebaixar
  // 604 mil linhas. O valor e identico ao literal usado no recorte do CSV de
  // agosto.
  //
  // z.coerce.date() rejeita Invalid Date. Isso importa: um piso NaN faria toda
  // comparacao ser falsa, nenhuma linha seria elegivel e o mirror pararia de
  // crescer em silencio -- pior que o problema original, porque nao ha erro.
  SYNC_MIRROR_FLOOR_AT: z.coerce.date().default(new Date("2026-08-01T00:00:00-03:00")),
});

export type WorkerEnv = z.infer<typeof envSchema>;

export function getWorkerEnv(): WorkerEnv {
  return envSchema.parse(process.env);
}
