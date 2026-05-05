import { NextResponse } from "next/server";

import type { ApiEnvelope } from "@/types/api";

type MetaExtras = Record<string, unknown>;

export function createApiSuccess<T>(
  requestId: string,
  data: T,
  metaExtras: MetaExtras = {},
  status = 200
) {
  const body: ApiEnvelope<T> = {
    success: true,
    data,
    error: null,
    requestId,
    meta: {
      timestamp: new Date().toISOString(),
      ...metaExtras,
    },
  };

  return NextResponse.json(body, { status });
}

export function createApiError(
  requestId: string,
  error: string,
  status = 500,
  metaExtras: MetaExtras = {}
) {
  const body: ApiEnvelope<null> = {
    success: false,
    data: null,
    error,
    requestId,
    meta: {
      timestamp: new Date().toISOString(),
      ...metaExtras,
    },
  };

  return NextResponse.json(body, { status });
}
