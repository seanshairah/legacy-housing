import { workOnce } from "../src/domain/worker";
import { db } from "../src/lib/db";
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
    console.error(
      "Worker cycle failed:",
      error instanceof Error ? error.message : "unknown",
    );
  }
  await new Promise((r) => setTimeout(r, 5000));
}
await db.$disconnect();
