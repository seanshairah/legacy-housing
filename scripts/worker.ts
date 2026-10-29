import { workOnce } from "../src/domain/worker";
import { db } from "../src/lib/db";
import { operationalLog, operationalErrorCode } from "../src/lib/logger";
let running = true;
process.on("SIGTERM", () => {
  running = false;
});
process.on("SIGINT", () => {
  running = false;
});
while (running) {
  try {
    await workOnce();
  } catch (error) {
    operationalLog(
      "worker.cycle_failed",
      {
        outcome: "failed",
        errorCode: operationalErrorCode(error, "WORKER_CYCLE_FAILED"),
      },
      "error",
    );
  }
  await new Promise((r) => setTimeout(r, 5000));
}
await db.$disconnect();
