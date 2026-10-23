import { PrismaClient, Prisma } from "@prisma/client";
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
        error.code === "P2034" &&
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
