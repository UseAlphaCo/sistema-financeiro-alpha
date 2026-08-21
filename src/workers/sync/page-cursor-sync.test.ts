import { describe, expect, it, vi } from "vitest";

import type { WorkerEnv } from "@/workers/sync/config";
import { sweepByPageCursor } from "@/workers/sync/page-cursor-sync";
import type { CoreRepository } from "@/workers/sync/repositories/core-repository";
import type { OmsRepository } from "@/workers/sync/repositories/oms-repository";
import type { RawPayloadCandidate, RawPayloadKey, ScanCursor, ScanPass } from "@/workers/sync/types";

vi.mock("@/core/observability/logger", () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

const FLOOR = new Date("2026-08-01T00:00:00-03:00");

const env = {
  OMS_DB_URL: "postgresql://oms",
  CORE_DB_URL: "postgresql://core",
  BATCH_SIZE: 100,
  MAX_RETRIES: 5,
  DLQ_RETENTION_DAYS: 90,
  SYNC_WATERMARK_GRACE_SECONDS: 300,
  SYNC_DISCOVERY_MODE: "ctid",
  SYNC_CHUNK_BLOCKS: 5_000,
  SYNC_CYCLE_BUDGET_MS: 45_000,
  SYNC_MIRROR_FLOOR_AT: FLOOR,
} as WorkerEnv;

function cursorFor(pass: ScanPass): ScanCursor {
  return {
    stream: "teste",
    pass,
    nextBlock: 0,
    lapStartBlock: 0,
    lapEndBlock: null,
    blocksCovered: 0,
    sourceRelfilenode: null,
    sourceHeapBlocks: null,
    lapNumber: 0,
    consecutiveErrors: 0,
    lastRunAt: null,
  };
}

/** Duas de agosto, uma de julho, uma sem data: um chunk representativo. */
const CHUNK_KEYS: RawPayloadKey[] = [
  {
    id: "11111111-1111-1111-1111-111111111111",
    source: "shopify",
    receivedAt: new Date("2026-08-05T10:00:00-03:00"),
    processedAt: null,
    processingStatus: "processed",
  },
  {
    id: "22222222-2222-2222-2222-222222222222",
    source: "shopify",
    receivedAt: new Date("2026-07-15T10:00:00-03:00"),
    processedAt: null,
    processingStatus: "processed",
  },
  {
    id: "33333333-3333-3333-3333-333333333333",
    source: "anymarket",
    receivedAt: null,
    processedAt: null,
    processingStatus: null,
  },
  {
    id: "44444444-4444-4444-4444-444444444444",
    source: "anymarket",
    receivedAt: null,
    processedAt: FLOOR,
    processingStatus: "processed",
  },
];

function buildFakes(overrides: {
  keys?: RawPayloadKey[];
  pending?: { queueId: number; recordId: string }[];
  fetched?: RawPayloadCandidate[];
}) {
  const cursors = new Map<ScanPass, ScanCursor>([
    ["tail", cursorFor("tail")],
    ["audit", cursorFor("audit")],
  ]);

  const antiJoinCalls: string[][] = [];
  const enqueued: string[][] = [];
  const written: string[][] = [];
  const syncedIds: string[][] = [];
  let pendingServed = false;

  const oms = {
    getHeapState: async () => ({ relfilenode: "12345", heapBlocks: 5_000 }),
    findKeysInPageRange: async () => overrides.keys ?? [],
    findRawPayloadsByIds: async () => overrides.fetched ?? [],
  } as unknown as OmsRepository;

  const core = {
    getScanCursor: async (_stream: string, pass: ScanPass) => cursors.get(pass) as ScanCursor,
    saveScanCursor: async () => undefined,
    findMissingRawPayloadIds: async (ids: string[]) => {
      antiJoinCalls.push(ids);
      return ids;
    },
    enqueueMissingIds: async (ids: string[]) => {
      enqueued.push(ids);
      return ids.length;
    },
    findPendingFetchIds: async () => {
      if (pendingServed) {
        return [];
      }
      pendingServed = true;
      return overrides.pending ?? [];
    },
    upsertRawPayloadsBatch: async (records: { id: string }[]) => {
      written.push(records.map((r) => r.id));
      return records.length;
    },
    markFetchSynced: async (ids: string[]) => {
      syncedIds.push(ids);
      return ids.length;
    },
    markFetchFailed: async () => undefined,
    countPendingFetch: async () => 0,
  } as unknown as CoreRepository;

  return { oms, core, antiJoinCalls, enqueued, written, syncedIds };
}

describe("varredura por cursor fisico com piso de data", () => {
  it("manda ao anti-join so as chaves acima do piso", async () => {
    const fakes = buildFakes({ keys: CHUNK_KEYS });

    await sweepByPageCursor(fakes.oms, fakes.core, env, "ciclo-1", "teste");

    // O que nao esta acima do piso nem chega a virar consulta no CORE: e onde
    // esta a economia, e e a garantia de que o truncate nao se auto-reverte.
    expect(fakes.antiJoinCalls.length).toBeGreaterThan(0);
    for (const call of fakes.antiJoinCalls) {
      expect(call).toEqual([
        "11111111-1111-1111-1111-111111111111",
        "44444444-4444-4444-4444-444444444444",
      ]);
    }
    for (const call of fakes.enqueued) {
      expect(call).toHaveLength(2);
    }
  });

  it("conta o heap inteiro em rowsSeen e fecha a soma nos contadores", async () => {
    const fakes = buildFakes({ keys: CHUNK_KEYS });

    const result = await sweepByPageCursor(fakes.oms, fakes.core, env, "ciclo-2", "teste");

    // rowsSeen mede o HEAP, nao o recorte: e o unico numero comparavel com o
    // count(*) do OMS, e sem ele a regra das duas voltas nao tem base.
    const chunks = fakes.antiJoinCalls.length;
    expect(result.rowsSeen).toBe(CHUNK_KEYS.length * chunks);
    expect(result.rowsBelowFloor).toBe(chunks);
    expect(result.rowsUndated).toBe(chunks);
    expect(result.rowsMissing).toBe(2 * chunks);
    expect(result.rowsBelowFloor + result.rowsUndated + result.rowsMissing).toBe(result.rowsSeen);
  });

  it("nao grava no mirror o que a fila legada trouxe abaixo do piso", async () => {
    const fetched: RawPayloadCandidate[] = [
      {
        id: "aaaaaaaa-0000-0000-0000-000000000001",
        source: "shopify",
        externalOrderId: "1",
        eventType: "orders/create",
        payloadJson: {},
        headersJson: {},
        receivedAt: new Date("2026-08-10T00:00:00-03:00"),
        processedAt: null,
        processingStatus: "processed",
        errorMessage: null,
      },
      {
        id: "aaaaaaaa-0000-0000-0000-000000000002",
        source: "shopify",
        externalOrderId: "2",
        eventType: "orders/create",
        payloadJson: {},
        headersJson: {},
        receivedAt: new Date("2026-06-10T00:00:00-03:00"),
        processedAt: null,
        processingStatus: "processed",
        errorMessage: null,
      },
      {
        id: "aaaaaaaa-0000-0000-0000-000000000003",
        source: "shopify",
        externalOrderId: "3",
        eventType: "orders/create",
        payloadJson: {},
        headersJson: {},
        receivedAt: null,
        processedAt: null,
        processingStatus: "processed",
        errorMessage: null,
      },
    ];

    const fakes = buildFakes({
      keys: [],
      pending: fetched.map((row, index) => ({ queueId: index + 1, recordId: row.id })),
      fetched,
    });

    const result = await sweepByPageCursor(fakes.oms, fakes.core, env, "ciclo-3", "teste");

    expect(fakes.written).toEqual([["aaaaaaaa-0000-0000-0000-000000000001"]]);
    expect(result.rowsRepaired).toBe(1);
    // Mas os tres saem da fila: deixar residuo os faria ser retentados
    // MAX_RETRIES vezes e ir para a DLQ, envenenando a fila para sempre.
    expect(fakes.syncedIds).toEqual([fetched.map((row) => row.id)]);
    expect(result.vanished).toBe(0);
  });
});
