type TelemetryMetric = {
  count: number;
  errorCount: number;
  totalDurationMs: number;
};

const endpointMetrics = new Map<string, TelemetryMetric>();

export function trackEndpointCall(endpoint: string, durationMs: number, isError: boolean) {
  const current = endpointMetrics.get(endpoint) ?? {
    count: 0,
    errorCount: 0,
    totalDurationMs: 0,
  };

  current.count += 1;
  current.totalDurationMs += durationMs;
  if (isError) current.errorCount += 1;

  endpointMetrics.set(endpoint, current);
}

export function getEndpointMetrics() {
  const result: Record<string, { count: number; errorRate: number; avgDurationMs: number }> = {};

  for (const [endpoint, metric] of endpointMetrics.entries()) {
    const avgDurationMs = metric.count > 0 ? metric.totalDurationMs / metric.count : 0;
    const errorRate = metric.count > 0 ? metric.errorCount / metric.count : 0;
    result[endpoint] = {
      count: metric.count,
      errorRate,
      avgDurationMs,
    };
  }

  return result;
}
