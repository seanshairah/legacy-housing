import { z } from "zod";
import { db, transaction } from "../src/lib/db";
import { event } from "../src/domain/events";

/** Trusted terminal-only bootstrap; never expose this function as an HTTP action. */
export async function bootstrapPlatformOperator(email: string) {
  email = z
    .string()
    .trim()
    .email()
    .transform((v) => v.toLowerCase())
    .parse(email);
  await transaction(async (tx) => {
    await tx.$executeRaw`LOCK TABLE "PlatformGrant" IN SHARE ROW EXCLUSIVE MODE`;
    if (await tx.platformGrant.count())
      throw new Error("PLATFORM_BOOTSTRAP_ALREADY_COMPLETE");
    const user = await tx.user.findUniqueOrThrow({
      where: { email },
      select: {
        id: true,
        active: true,
        emailVerifiedAt: true,
        phoneVerifiedAt: true,
        mfaSecret: true,
        mfaConfirmed: true,
      },
    });
    if (
      !user.active ||
      !user.emailVerifiedAt ||
      !user.phoneVerifiedAt ||
      !user.mfaSecret ||
      !user.mfaConfirmed
    )
      throw new Error("VERIFIED_MFA_ACCOUNT_REQUIRED");
    await tx.platformGrant.create({
      data: { userId: user.id, role: "OPERATOR" },
    });
    await tx.session.deleteMany({ where: { userId: user.id } });
    await event(
      tx,
      user.id,
      null,
      "platform.initial_operator_bootstrapped",
      user.id,
    );
  });
}

if (process.argv[1]?.endsWith("bootstrap-platform.ts")) {
  try {
    await bootstrapPlatformOperator(process.argv[2] || "");
    console.log("Initial platform operator grant saved and audited.");
  } finally {
    await db.$disconnect();
  }
}
