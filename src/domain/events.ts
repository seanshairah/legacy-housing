import { randomUUID } from "node:crypto";
import { type Prisma } from "@prisma/client";
import { type Tx } from "../lib/db";
export async function event(
  tx: Tx,
  actorId: string,
  propertyId: string | null,
  action: string,
  objectId: string,
  detail: Prisma.InputJsonValue = {},
  userId?: string,
) {
  const traceId = randomUUID();
  await tx.auditEvent.create({
    data: { actorId, propertyId, action, objectId, detail, traceId },
  });
  await tx.outboxEvent.create({
    data: {
      type: action,
      propertyId,
      userId,
      payload: { objectId, detail },
      traceId,
    },
  });
  if (userId)
    await tx.notification.create({
      data: {
        userId,
        title: action.replaceAll(".", " "),
        body: `Your record has been updated. Reference: ${objectId}. Sign in for details.`,
      },
    });
}
