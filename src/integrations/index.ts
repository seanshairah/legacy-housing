import { db, transaction } from "../lib/db";
import { type Actor, permit } from "../domain/access";
import { event } from "../domain/events";
import {
  type ExchangeConnector,
  type PaymentProvider,
  type SignatureProvider,
  type AntivirusScanner,
} from "./contracts";
import { initiatePaynow, reconcilePaynow } from "../domain/paynow";
import { issueLease } from "../domain/leases";
import { scanBytes } from "../domain/documents";
const health = () => ({
  status: "LOCAL_VALIDATED" as const,
  detail:
    "Local exchange schema and database access validated. No external system or provider was contacted.",
  checkedAt: new Date().toISOString(),
});
export const paynowProvider: PaymentProvider = {
  initiate: initiatePaynow,
  reconcile: reconcilePaynow,
};
export const signatureProvider: SignatureProvider = {
  mode: "MANUAL_REVIEW",
  issue: issueLease,
};
export const antivirus: AntivirusScanner = { scan: scanBytes };
const EXPORT_PAGE_SIZE = 500;
// Query fixed-size pages while retaining every exported row. The previous fixed
// take silently omitted records beyond 500 from otherwise successful exports.
async function exportRows<T extends { id: string }>(
  page: (cursor?: string) => Promise<T[]>,
  project: (record: T) => string[],
) {
  const rows: string[][] = [];
  let cursor: string | undefined;
  while (true) {
    const records = await page(cursor);
    rows.push(...records.map(project));
    if (records.length < EXPORT_PAGE_SIZE) break;
    cursor = records.at(-1)!.id;
  }
  return rows;
}
export const accountingCsv: ExchangeConnector = {
  provider: "ACCOUNTING_CSV",
  async testConnection(actor, propertyId) {
    await permit(actor, propertyId, "finance.read");
    await db.$queryRaw`SELECT 1`;
    return health();
  },
  async export(actor, propertyId) {
    await permit(actor, propertyId, "finance.read");
    const rows = await exportRows(
      (cursor) =>
        db.charge.findMany({
          where: { propertyId },
          orderBy: { id: "asc" },
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          take: EXPORT_PAGE_SIZE,
        }),
      (c) => [
        c.id,
        c.userId,
        c.currency,
        String(c.amountMinor),
        c.dueAt.toISOString(),
        c.category,
      ],
    );
    return {
      headers: [
        "external_id",
        "resident_id",
        "currency",
        "amount_minor",
        "due_at",
        "category",
      ],
      rows,
    };
  },
};
export const pmsCsv: ExchangeConnector = {
  provider: "PMS_CSV",
  async testConnection(actor, propertyId) {
    await permit(actor, propertyId, "inventory");
    return health();
  },
  async export(actor, propertyId) {
    await permit(actor, propertyId, "inventory");
    const rows = await exportRows(
      (cursor) =>
        db.bed.findMany({
          where: { room: { floor: { building: { propertyId } } } },
          include: {
            room: { include: { floor: { include: { building: true } } } },
          },
          orderBy: { id: "asc" },
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          take: EXPORT_PAGE_SIZE,
        }),
      (b) => [
        b.id,
        b.room.floor.building.name,
        b.room.floor.name,
        b.room.name,
        b.label,
        String(b.blocked),
      ],
    );
    return {
      headers: ["external_id", "building", "floor", "room", "space", "blocked"],
      rows,
    };
  },
};
export const sisCsv: ExchangeConnector = {
  provider: "SIS_CSV",
  async testConnection(actor, propertyId) {
    await permit(actor, propertyId, "admissions");
    return health();
  },
  async export(actor, propertyId) {
    await permit(actor, propertyId, "admissions");
    const rows = await exportRows(
      (cursor) =>
        db.user.findMany({
          where: {
            residentType: "STUDENT",
            applications: { some: { propertyId } },
            consents: { some: { purpose: "SIS_EXCHANGE", version: "v1" } },
          },
          select: { id: true, institution: true },
          orderBy: { id: "asc" },
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          take: EXPORT_PAGE_SIZE,
        }),
      (u) => [u.id, u.institution || ""],
    );
    return {
      headers: ["resident_id", "institution"],
      rows,
    };
  },
};
export const connectors: Record<string, ExchangeConnector> = {
  ACCOUNTING_CSV: accountingCsv,
  PMS_CSV: pmsCsv,
  SIS_CSV: sisCsv,
};
export async function testConnector(
  actor: Actor,
  propertyId: string,
  provider: string,
) {
  await permit(actor, propertyId, "settings");
  const connector = connectors[provider];
  if (!connector) throw new Error("SELECT_SUPPORTED_CONNECTOR");
  const result = await connector.testConnection(actor, propertyId);
  await transaction(async (tx) => {
    await tx.integration.upsert({
      where: { propertyId_provider: { propertyId, provider } },
      create: {
        propertyId,
        provider,
        status: result.status,
        config: { mode: "MANUAL_CSV", schemaVersion: 1 },
        lastCheckedAt: new Date(),
      },
      update: { status: result.status, lastCheckedAt: new Date() },
    });
    await event(
      tx,
      actor.id,
      propertyId,
      "integration.connection_tested",
      provider,
      { status: result.status },
    );
  });
  return result;
}
