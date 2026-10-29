import { PrismaClient, Prisma } from "@prisma/client";
// The identity/worker control plane still uses the dedicated deployment role.
// Do not enable shared hosting until every request and job has a scoped context.
if (process.env.TENANCY_MODE === "shared")
  throw new Error("SHARED_TENANCY_REQUIRES_FULL_REQUEST_CONTEXT");
if (process.env.TENANCY_MODE && process.env.TENANCY_MODE !== "dedicated")
  throw new Error("INVALID_TENANCY_MODE");
const scope = globalThis as unknown as { legacyDb?: PrismaClient };
export const db = scope.legacyDb ?? new PrismaClient();
if (process.env.NODE_ENV !== "production") scope.legacyDb = db;
export type Tx = Prisma.TransactionClient;
export async function transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  for (let i = 0; i < 4; i++) {
    try {
      return await db.$transaction(fn, {
        isolationLevel: "Serializable",
        maxWait: 10000,
        timeout: 20000,
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        (error.code === "P2034" ||
          (error.code === "P2010" &&
            ["40001", "40P01"].includes(String(error.meta?.code)))) &&
        i < 3
      ) {
        await new Promise((resolve) => setTimeout(resolve, 20 * (i + 1)));
        continue;
      }
      throw error;
    }
  }
  throw new Error("TRANSACTION_RETRY_EXHAUSTED");
}
