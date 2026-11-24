// Risk process. Phase 7 adds daily loss, drawdown, the kill switch and alerts.
import { loadBaseEnv, runWorker } from "@saarthi/core";

runWorker("risk", () => loadBaseEnv(), () => ({
  detail: () => "monitoring starts in phase 7",
}));
