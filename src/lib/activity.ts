import { db } from "./db";
import { randomUUID } from "node:crypto";
export async function activity(
  actorId: string,
  propertyId: string | null,
  action: string,
  objectId: string,
) {
  await db.auditEvent.create({
    data: {
      actorId,
      propertyId,
      action,
      objectId,
      detail: {},
      traceId: randomUUID(),
    },
  });
}
