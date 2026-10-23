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
export const accountingCsv: ExchangeConnector = {
  provider: "ACCOUNTING_CSV",
  async testConnection(actor, propertyId) {
    await permit(actor, propertyId, "finance.read");
    await db.$queryRaw`SELECT 1`;
    return health();
  },
  async export(actor, propertyId) {
    await permit(actor, propertyId, "finance.read");
    const charges = await db.charge.findMany({
      where: { propertyId },
      orderBy: { id: "asc" },
      take: 500,
    });
    return {
      headers: [
        "external_id",
        "resident_id",
        "currency",
        "amount_minor",
        "due_at",
        "category",
      ],
      rows: charges.map((c) => [
        c.id,
        c.userId,
        c.currency,
        String(c.amountMinor),
        c.dueAt.toISOString(),
        c.category,
      ]),
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
    const beds = await db.bed.findMany({
      where: { room: { floor: { building: { propertyId } } } },
      include: {
        room: { include: { floor: { include: { building: true } } } },
      },
      take: 500,
    });
    return {
      headers: ["external_id", "building", "floor", "room", "space", "blocked"],
      rows: beds.map((b) => [
        b.id,
        b.room.floor.building.name,
        b.room.floor.name,
        b.room.name,
        b.label,
        String(b.blocked),
      ]),
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
    const students = await db.user.findMany({
      where: {
        residentType: "STUDENT",
        applications: { some: { propertyId } },
        consents: { some: { purpose: "SIS_EXCHANGE", version: "v1" } },
      },
      select: { id: true, institution: true },
      take: 500,
    });
    return {
      headers: ["resident_id", "institution"],
      rows: students.map((u) => [u.id, u.institution || ""]),
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
