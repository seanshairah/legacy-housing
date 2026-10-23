import { leaseDisplayLines } from "../lib/lease-display";
export function LeaseTerms({
  snapshot,
}: {
  snapshot: Record<string, unknown>;
}) {
  return (
    <div
      className="record-card"
      style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
    >
      {leaseDisplayLines(snapshot).map((line, i) => (
        <p key={i}>{line}</p>
      ))}
    </div>
  );
}
