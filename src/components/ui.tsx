import Link from "next/link";
import {
  Building2,
  ArrowUpRight,
  LayoutDashboard,
  Users,
  Wallet,
  ClipboardCheck,
  Settings,
  KeyRound,
  House,
  Wrench,
  FileText,
  ShieldCheck,
  Plug,
  BarChart3,
} from "lucide-react";
import type { ReactNode } from "react";
export function Brand({ displayName }: { displayName?: string } = {}) {
  return (
    <Link href="/" className="brand">
      <span className="brand-mark">
        <Building2 size={23} />
      </span>
      <span>
        {displayName || (
          <>
            LEGACY<span className="brand-sub">H E I G H T S</span>
          </>
        )}
      </span>
    </Link>
  );
}
export function Badge({
  children,
  tone = "",
}: {
  children: ReactNode;
  tone?: string;
}) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
export function Empty({ title, body }: { title: string; body: string }) {
  return (
    <div className="empty">
      <House size={28} />
      <h3>{title}</h3>
      <p>{body}</p>
    </div>
  );
}
export function PageHead({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="page-head">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        <p className="muted">{description}</p>
      </div>
      {action}
    </div>
  );
}
export function Stat({
  label,
  value,
  note,
  icon,
}: {
  label: string;
  value: ReactNode;
  note: string;
  icon?: ReactNode;
}) {
  return (
    <div className="stat">
      <div className="stat-label">
        {label}
        {icon || <ArrowUpRight size={17} />}
      </div>
      <div className="stat-value">{value}</div>
      <div className="stat-note">{note}</div>
    </div>
  );
}
export function ActionForm({
  action,
  next,
  children,
  ...fields
}: {
  action: string;
  next?: string;
  children: ReactNode;
  [key: string]: ReactNode;
}) {
  return (
    <form action="/api/actions" method="post" className="action-form">
      <input type="hidden" name="action" value={action} />
      <input type="hidden" name="next" value={next || "/portal"} />
      {Object.entries(fields).map(([key, value]) => (
        <input key={key} type="hidden" name={key} value={String(value)} />
      ))}
      {children}
    </form>
  );
}
export const navItems = [
  {
    key: "medical",
    label: "Sensitive reviews",
    icon: ShieldCheck,
    cap: "medical",
  },
  { key: "overview", label: "Overview", icon: LayoutDashboard, cap: "reports" },
  { key: "admissions", label: "Applications", icon: Users, cap: "admissions" },
  {
    key: "inventory",
    label: "Properties & rooms",
    icon: Building2,
    cap: "inventory",
  },
  { key: "kyc", label: "Document review", icon: ClipboardCheck, cap: "kyc" },
  {
    key: "finance",
    label: "Finance & payments",
    icon: Wallet,
    cap: "finance.read",
  },
  { key: "leases", label: "Leases & occupancy", icon: FileText, cap: "leases" },
  {
    key: "operations",
    label: "Requests & support",
    icon: Wrench,
    cap: "operations",
  },
  { key: "integrations", label: "Integrations", icon: Plug, cap: "settings" },
  { key: "reports", label: "Reports", icon: BarChart3, cap: "reports" },
  {
    key: "security",
    label: "Security & audit",
    icon: ShieldCheck,
    cap: "audit",
  },
  { key: "settings", label: "Settings", icon: Settings, cap: "settings" },
];
export function PublicNav() {
  return (
    <header className="public-nav">
      <Brand />
      <nav>
        <Link href="/rooms">Find your room</Link>
        <Link href="/#experience">The experience</Link>
        <Link href="/#contact">Get in touch</Link>
      </nav>
      <Link className="button small-button" href="/auth">
        Resident portal <KeyRound size={15} />
      </Link>
    </header>
  );
}
