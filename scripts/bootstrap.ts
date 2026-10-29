import { z } from "zod";
import { db, transaction } from "../src/lib/db";
import { event } from "../src/domain/events";
const data = z
  .object({
    email: z.string().email(),
    name: z.string().min(3),
    slug: z.string().regex(/^[a-z0-9-]+$/),
    location: z.string().min(3),
    legalEntity: z.string().min(3),
    currency: z.string().regex(/^[A-Z]{3}$/),
  })
  .parse(JSON.parse(process.argv[2] || "{}"));
const existing = await db.membership.count({ where: { role: "ADMIN" } });
if (existing) throw new Error("BOOTSTRAP_ALREADY_COMPLETE_USE_SCOPED_ADMIN");
const user = await db.user.findUniqueOrThrow({ where: { email: data.email } });
if (!user.emailVerifiedAt || !user.phoneVerifiedAt || !user.mfaConfirmed)
  throw new Error("VERIFIED_MFA_ACCOUNT_REQUIRED");
await transaction(async (tx) => {
  const { email: _, ...fields } = data;
  void _;
  const p = await tx.property.create({
    data: {
      ...fields,
      description: "Client property — approved catalogue content pending",
      published: false,
    },
  });
  await tx.membership.create({
    data: { userId: user.id, propertyId: p.id, role: "ADMIN" },
  });
  await event(tx, user.id, p.id, "bootstrap.completed", p.id);
});
console.log(
  "Initial scoped administrator created; property remains unpublished.",
);
await db.$disconnect();
