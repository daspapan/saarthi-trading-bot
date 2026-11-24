// Analyst process (the AI side). It uses loadAnalystEnv, which refuses to start
// if any exchange key is visible. It will never import anything that places orders.
// Phase 4 adds snapshots, the Ollama call and POST /signals.
import { loadAnalystEnv, runWorker } from "@saarthi/core";

runWorker("analyst", () => loadAnalystEnv(), ({ env }) => ({
  detail: () => `no keys loaded; model ${env.ollamaModel} every ${env.analysisIntervalMin} min (phase 4)`,
}));
