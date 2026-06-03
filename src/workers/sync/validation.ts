import type { RawPayloadRecord, SyncEventRow, SyncOperation } from "./types";

const OPERATIONS: SyncOperation[] = ["INSERT", "UPDATE", "DELETE"];

function toNullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

function toNullableDate(value: unknown): Date | null {
  if (!value) return null;

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  if (typeof value !== "string") return null;

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function validateSyncEvent(row: SyncEventRow): { valid: true } | { valid: false; reason: string } {
  if (!row.recordId) {
    return { valid: false, reason: "record_id ausente" };
  }

  if (!OPERATIONS.includes(row.operation)) {
    return { valid: false, reason: `operation invalida: ${row.operation}` };
  }

  if ((row.operation === "INSERT" || row.operation === "UPDATE") && !row.payload) {
    return { valid: false, reason: "payload ausente para INSERT/UPDATE" };
  }

  return { valid: true };
}

export function mapPayloadToRawPayloadRecord(row: SyncEventRow): RawPayloadRecord {
  const payloadObj = asRecord(row.payload);
  if (!payloadObj) {
    throw new Error("payload nao e um objeto JSON valido");
  }

  const id = toNullableString(payloadObj.id) ?? row.recordId;
  if (!id) {
    throw new Error("payload sem id");
  }

  return {
    id,
    source: toNullableString(payloadObj.source),
    externalOrderId: toNullableString(payloadObj.external_order_id),
    eventType: toNullableString(payloadObj.event_type),
    payloadJson: payloadObj.payload_json ?? null,
    headersJson: payloadObj.headers_json ?? null,
    receivedAt: toNullableDate(payloadObj.received_at),
    processedAt: toNullableDate(payloadObj.processed_at),
    processingStatus: toNullableString(payloadObj.processing_status),
    errorMessage: toNullableString(payloadObj.error_message),
  };
}
