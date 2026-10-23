import type { PriceSnapshot } from "../domain/pricing";
export function leaseDisplayLines(s: Record<string, unknown>) {
  const date = (v: unknown) =>
    typeof v === "string" ? v.slice(0, 10) : "As stated in the agreement";
  const pricing = s.pricing as PriceSnapshot | undefined;
  const amount = (v: string) => {
    const n = BigInt(v);
    return `${pricing?.currency || "USD"} ${n / 100n}.${String(n % 100n).padStart(2, "0")}`;
  };
  const lines = [`Agreement version: ${s.version}`, `Resident: ${s.resident}`];
  if (s.property) lines.push(`Property: ${s.property}`);
  if (s.legalEntity) lines.push(`Accommodation provider: ${s.legalEntity}`);
  if (s.location) lines.push(`Property location: ${s.location}`);
  if (s.space) lines.push(`Allocated space: ${s.space}`);
  lines.push(
    `Stay: ${date(s.startAt)} to ${date(s.endAt)} (end date exclusive)`,
  );
  if (pricing?.totalMinor) {
    lines.push(`Quoted rent for this stay: ${amount(pricing.totalMinor)}`);
    for (const r of pricing.segments || [])
      lines.push(
        `Rent rate ${date(r.start)} to ${date(r.end)}: ${amount(r.monthlyMinor)} per calendar month, prorated for the dates stayed.`,
      );
  }
  lines.push("AGREEMENT TERMS", String(s.terms || ""));
  if (s.electronicSigningDisclosure)
    lines.push(
      "ELECTRONIC SIGNING DISCLOSURE",
      String(s.electronicSigningDisclosure),
    );
  return lines;
}
