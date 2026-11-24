// Risk process: every 5 seconds it checks the daily loss limit, the drawdown limit
// and the health of the executor and feed, and sends any new alerts to ntfy /
// Telegram if those are set up. It holds no keys: to close positions it raises the
// "liquidate" flag, which the executor acts on.

import { RiskMonitor, loadBaseEnv, loadSettingsFile, notifyConfigFrom, runWorker, sendPendingAlerts } from "@saarthi/core";

const CHECK_EVERY_MS = 5_000;
const notify = notifyConfigFrom(process.env);

runWorker("risk", () => loadBaseEnv(), ({ env, db, log }) => {
  const monitor = new RiskMonitor(db, () => loadSettingsFile(env.configDir, "risk.json"));
  let detail = "starting";
  let busy = false;

  const check = async () => {
    if (busy) return;
    busy = true;
    try {
      const v = monitor.tick(Date.now());
      const a = v.assessment;
      detail = a
        ? `daily loss ${a.dailyUsedPct.toFixed(0)}% of limit, drawdown ${a.drawdownPct.toFixed(1)}%${v.flags.killSwitch.active ? ", KILL SWITCH ON" : ""}`
        : "waiting for the first equity figure from the executor";
    } catch (err) {
      detail = `check failed: ${(err as Error).message}`;
      log.error({ err: (err as Error).message }, "risk check failed");
    }
    // Notifications are best-effort and separate: a failure here never affects the checks above (AL-02).
    try {
      await sendPendingAlerts(db, notify, { log });
    } catch (err) {
      log.warn({ err: (err as Error).message }, "notification sending failed");
    } finally {
      busy = false;
    }
  };

  void check();
  const timer = setInterval(() => void check(), CHECK_EVERY_MS);
  return {
    detail: () => `${detail}${notify.ntfyUrl || notify.telegram ? "" : " (phone alerts off)"}`,
    stop: () => clearInterval(timer),
  };
}, notify.telegram ? [notify.telegram.botToken] : []); // the bot token never reaches a log line
