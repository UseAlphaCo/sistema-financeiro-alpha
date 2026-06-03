import { logError, logInfo } from "../../core/observability/logger";
import { runSyncOnce } from "./service";

runSyncOnce()
  .then((summary) => {
    logInfo("sync_completed", summary);
  })
  .catch((error: unknown) => {
    logError("sync_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  });
