import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import {
  ensureJobsTable,
  insertJob,
  getJob,
  closePool,
} from "./worker-job-repository";

const conn = process.env.CORE_DB_URL ?? process.env.DATABASE_URL;

describe("worker-job-repository (integration)", () => {
  if (!conn) {
    it("skips when no DATABASE_URL or CORE_DB_URL configured", () => {
      expect(true).toBe(true);
    });
    return;
  }

  it("persists and retrieves a job", async () => {
    await ensureJobsTable();
    const id = randomUUID();
    const job = {
      id,
      mode: "retroactive",
      estimated_scope_days: 30,
      status: "queued",
      started_at: new Date().toISOString(),
      finished_at: null,
      requested_by: "test@example.com",
      request_id: "req-1",
      max_runs: 2,
      runs: 0,
      last_error: null,
      summary: null,
    } as any;

    await insertJob(job);
    const loaded = await getJob(id);
    expect(loaded).not.toBeNull();
    expect(loaded?.id).toBe(id);
    await closePool();
  });
});
