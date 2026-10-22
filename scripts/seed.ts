import { mkdir, readFile, writeFile } from "node:fs/promises";
import { db } from "../src/lib/db";
import { passwordHash, token, hash } from "../src/lib/security";
if (
  process.env.NODE_ENV === "production" ||
  process.env.LOCAL_DEMO !== "true" ||
  !/\/(legacy_dev)(\?|$)/.test(process.env.DATABASE_URL || "")
)
  throw new Error("SEED_ONLY_ALLOWED_FOR_LOCAL_LEGACY_DEV");
await mkdir(".data", { recursive: true, mode: 0o700 });
let credentials: Record<string, string> = {};
try {
  credentials = JSON.parse(
    await readFile(".data/demo-credentials.json", "utf8"),
  );
} catch {
  /* First setup creates a new local credential file. */
}
const roles = [
  "RESIDENT",
  "ADMIN",
  "ADMISSIONS",
  "FINANCE",
  "PROPERTY_MANAGER",
  "CARETAKER",
  "KYC",
  "AUDITOR",
];
for (const role of roles) {
  const email = `${role.toLowerCase()}@demo.legacy.invalid`;
  credentials[email] ||= token().slice(0, 18) + "!a9";
  const i = roles.indexOf(role);
  await db.user.upsert({
    where: { email },
    update: {},
    create: {
      id: `demo-${role.toLowerCase()}`,
      email,
      name:
        role === "RESIDENT" ? "Alex Demo" : `${role.replace("_", " ")} Demo`,
      phone: `+2637700090${String(i).padStart(2, "0")}`,
      passwordHash: await passwordHash(credentials[email]),
      emailVerifiedAt: new Date(),
      phoneVerifiedAt: new Date(),
      emergencyName: "Synthetic emergency contact",
      emergencyPhone: "+263770009099",
    },
  });
}
await writeFile(
  ".data/demo-credentials.json",
  JSON.stringify(credentials, null, 2),
  { mode: 0o600 },
);
for (let n = 1; n <= 2; n++) {
  const p = await db.property.upsert({
    where: { slug: `demo-residence-${n}` },
    update: {},
    create: {
      id: `demo-property-${n}`,
      name: n === 1 ? "The Courtyard · Demo" : "The Gardens · Demo",
      slug: `demo-residence-${n}`,
      description:
        "Synthetic development inventory. Replace with approved Legacy Heights properties before launch.",
      location: "Demonstration property · location pending",
      published: true,
      holdMinutes: 60,
      depositMinor: 3000n,
    },
  });
  for (const role of roles.filter((r) => r !== "RESIDENT"))
    if (n === 1 || role === "ADMIN")
      await db.membership.upsert({
        where: {
          userId_propertyId_role: {
            userId: `demo-${role.toLowerCase()}`,
            propertyId: p.id,
            role,
          },
        },
        update: {},
        create: {
          userId: `demo-${role.toLowerCase()}`,
          propertyId: p.id,
          role,
        },
      });
  for (let level = 0; level < 3; level++) {
    const building = await db.building.upsert({
      where: { propertyId_name: { propertyId: p.id, name: "Main building" } },
      update: {},
      create: { propertyId: p.id, name: "Main building" },
    });
    const floor = await db.floor.upsert({
      where: { buildingId_level: { buildingId: building.id, level } },
      update: {},
      create: {
        buildingId: building.id,
        name: level === 0 ? "Ground floor" : `Level ${level}`,
        level,
      },
    });
    for (let room = 1; room <= 4; room++) {
      const unit = await db.room.upsert({
        where: {
          floorId_name: { floorId: floor.id, name: `${level + 1}0${room}` },
        },
        update: {},
        create: {
          floorId: floor.id,
          name: `${level + 1}0${room}`,
          category: room === 1 ? "SINGLE" : room === 4 ? "PREMIUM" : "SHARED",
          accessible: level === 0 && room === 1,
          monthlyMinor: room === 1 ? 15000n : room === 4 ? 18000n : 12000n,
        },
      });
      for (let bed = 1; bed <= (room === 2 || room === 3 ? 2 : 1); bed++)
        await db.bed.upsert({
          where: { roomId_label: { roomId: unit.id, label: `Space ${bed}` } },
          update: {},
          create: { roomId: unit.id, label: `Space ${bed}` },
        });
    }
  }
  const body =
    "DEVELOPMENT DEMONSTRATION ONLY. This fixture illustrates the versioned lease workflow. It is not an approved tenancy agreement and must not be used for real occupation. Client legal counsel must supply and approve operative terms.";
  await db.leaseTemplate.upsert({
    where: { propertyId_version: { propertyId: p.id, version: 1 } },
    update: {},
    create: {
      propertyId: p.id,
      version: 1,
      title: "Demonstration template · not for legal use",
      body,
      hash: hash(body),
      approvedAt: new Date(),
      approvedBy: "LOCAL_DEMO_ONLY",
    },
  });
  if (!(await db.announcement.count({ where: { propertyId: p.id } })))
    await db.announcement.create({
      data: {
        propertyId: p.id,
        title: "Welcome to your development workspace",
        body: "All inventory and people in this local environment are synthetic. Live provider connections and approved client content are pending.",
      },
    });
}
console.log(
  "Synthetic inventory prepared. Credentials are in ignored .data/demo-credentials.json. Staff must enroll an authenticator before signing in.",
);
await db.$disconnect();
