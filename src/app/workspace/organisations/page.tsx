import Link from "next/link";
import { db } from "../../../lib/db";
import { requireUser } from "../../../lib/current-user";
import {
  listOrganisations,
  organisationProperties,
  permitOrganisation,
} from "../../../domain/organisations";
import { ActionForm, Brand, Empty, PageHead } from "../../../components/ui";

export const dynamic = "force-dynamic";
const next = "/workspace/organisations";
export default async function OrganisationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const user = await requireUser(),
    q = await searchParams;
  const organisations = await listOrganisations(user, q.cursor),
    selected =
      organisations.data.find((o) => o.id === q.organisation) ||
      organisations.data[0];
  const operator = await db.platformGrant.findUnique({
    where: { userId: user.id },
    select: { userId: true },
  });
  let admin = false,
    member = false;
  if (selected) {
    try {
      await permitOrganisation(user, selected.id);
      member = true;
    } catch {
      /* Operator metadata access does not grant personal-data authority. */
    }
    try {
      await permitOrganisation(user, selected.id, "admin");
      admin = true;
    } catch {
      /* Render controls only for the verified organisation administrator. */
    }
  }
  const properties =
    selected && member
      ? await organisationProperties(user, selected.id, q.propertyCursor)
      : { data: [], nextCursor: null };
  const memberships =
    selected && admin
      ? await db.organisationMembership.findMany({
          where: { organisationId: selected.id },
          select: {
            id: true,
            userId: true,
            role: true,
            user: { select: { name: true, email: true } },
          },
          orderBy: { id: "asc" },
          take: 100,
        })
      : [];
  const branding = selected?.branding as
    | { displayName?: string; primaryColour?: string; supportEmail?: string }
    | undefined;
  const policy = selected?.retentionPolicy as
    { policyReference?: string; noticeVersion?: string } | undefined;
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Brand />
        <div className="sidebar-label">ORGANISATIONS</div>
        <nav>
          <Link href="/portal">Resident portal</Link>
          <Link href="/workspace/overview">Property workspace</Link>
          <Link href={next} className="active">
            Organisation settings
          </Link>
        </nav>
        <div className="sidebar-bottom">
          <strong>{user.name}</strong>
        </div>
      </aside>
      <div className="app-main">
        <header className="app-topbar">
          <span>Organisation administration</span>
        </header>
        <main id="main" className="workspace-content">
          <PageHead
            eyebrow="INDEPENDENT WORKSPACES"
            title="Every organisation, clearly scoped."
            description="Manage organisation settings and individual property access. Platform operators provision workspaces; access to resident records requires explicit property permissions."
          />
          {q.error && (
            <p role="alert" className="notice">
              {q.error}
            </p>
          )}
          {q.success && (
            <p role="status" className="notice">
              Saved successfully.
            </p>
          )}
          <nav aria-label="Choose organisation" className="tabs">
            {organisations.data.map((o) => (
              <Link
                key={o.id}
                href={`${next}?organisation=${o.id}`}
                aria-current={o.id === selected?.id ? "page" : undefined}
              >
                {o.name}
              </Link>
            ))}
          </nav>
          {organisations.nextCursor && (
            <Link href={`${next}?cursor=${organisations.nextCursor}`}>
              More organisations →
            </Link>
          )}
          {!selected && (
            <Empty
              title="No organisation access yet"
              body="An authorised administrator can invite you to a property or grant organisation administration after your account is verified and secured with MFA."
            />
          )}
          {selected && (
            <>
              <section className="panel">
                <h2>{selected.name}</h2>
                <p>{selected.legalEntity}</p>
                <p className="muted">
                  Residency setting:{" "}
                  {selected.residencyRegion ||
                    "Awaiting approved hosting region"}
                  . Merchant mode: {selected.paymentMode}. A configured region
                  records the approved policy; the deployment operator must
                  separately verify where every service actually processes data.
                </p>
                {!member && (
                  <p className="notice">
                    You can view provisioning metadata. Personal records and
                    organisation administration require separate grants.
                  </p>
                )}
                {admin && (
                  <ActionForm
                    action="organisation.update"
                    organisationId={selected.id}
                    next={next}
                  >
                    <h3>Branding and governance</h3>
                    <label>
                      Organisation name
                      <input
                        name="name"
                        required
                        minLength={3}
                        maxLength={120}
                        defaultValue={selected.name}
                      />
                    </label>
                    <label>
                      Legal entity
                      <input
                        name="legalEntity"
                        required
                        minLength={3}
                        maxLength={150}
                        defaultValue={selected.legalEntity}
                      />
                    </label>
                    <label>
                      Display name
                      <input
                        name="displayName"
                        required
                        minLength={2}
                        maxLength={120}
                        defaultValue={branding?.displayName || selected.name}
                      />
                    </label>
                    <label>
                      Primary colour
                      <input
                        name="primaryColour"
                        type="color"
                        defaultValue={branding?.primaryColour || "#174f3b"}
                      />
                    </label>
                    <label>
                      Support email
                      <input
                        name="supportEmail"
                        type="email"
                        maxLength={200}
                        defaultValue={branding?.supportEmail || ""}
                      />
                    </label>
                    <label>
                      Approved residency region
                      <input
                        name="residencyRegion"
                        required
                        minLength={2}
                        maxLength={100}
                        defaultValue={selected.residencyRegion || ""}
                      />
                    </label>
                    <label>
                      Retention policy reference
                      <input
                        name="policyReference"
                        required
                        minLength={3}
                        maxLength={200}
                        defaultValue={policy?.policyReference || ""}
                      />
                    </label>
                    <label>
                      Privacy notice version
                      <input
                        name="noticeVersion"
                        required
                        maxLength={100}
                        defaultValue={policy?.noticeVersion || ""}
                      />
                    </label>
                    <button className="button">
                      Save organisation settings
                    </button>
                  </ActionForm>
                )}
              </section>
              <section className="panel">
                <h2>Properties in this organisation</h2>
                {!properties.data.length ? (
                  <p>
                    No properties are available under your individual grants.
                  </p>
                ) : (
                  <ul>
                    {properties.data.map((p) => (
                      <li key={p.id}>
                        <Link href={`/workspace/inventory?property=${p.id}`}>
                          {p.name}
                        </Link>{" "}
                        · {p.location} ·{" "}
                        {p.published ? "Published" : "Unpublished"}
                      </li>
                    ))}
                  </ul>
                )}
                {properties.nextCursor && (
                  <Link
                    href={`${next}?organisation=${selected.id}&propertyCursor=${properties.nextCursor}`}
                  >
                    More properties →
                  </Link>
                )}
                {admin && (
                  <ActionForm
                    action="property.create"
                    organisationId={selected.id}
                    next={next}
                  >
                    <h3>Create property</h3>
                    <label>
                      Property name
                      <input
                        name="name"
                        required
                        minLength={3}
                        maxLength={120}
                      />
                    </label>
                    <label>
                      Property slug
                      <input
                        name="slug"
                        required
                        pattern="[a-z0-9-]+"
                        maxLength={100}
                      />
                    </label>
                    <label>
                      Property legal entity
                      <input
                        name="legalEntity"
                        required
                        minLength={3}
                        maxLength={150}
                      />
                    </label>
                    <label>
                      Description
                      <textarea
                        name="description"
                        required
                        minLength={20}
                        maxLength={3000}
                      />
                    </label>
                    <label>
                      Location
                      <input
                        name="location"
                        required
                        minLength={3}
                        maxLength={200}
                      />
                    </label>
                    <label>
                      Currency
                      <select name="currency">
                        <option value="USD">USD</option>
                        <option value="ZWG">ZWG</option>
                      </select>
                    </label>
                    <label>
                      Deposit amount
                      <input
                        name="deposit"
                        type="number"
                        min="0"
                        step="0.01"
                        required
                      />
                    </label>
                    <label>
                      Hold minutes
                      <input
                        name="holdMinutes"
                        type="number"
                        min="5"
                        max="1440"
                        defaultValue="15"
                        required
                      />
                    </label>
                    <button className="button">
                      Create unpublished property
                    </button>
                  </ActionForm>
                )}
              </section>
              {admin && (
                <>
                  <section className="panel">
                    <h2>Merchant configuration</h2>
                    <p className="muted">
                      Credentials are encrypted and never displayed. Use only
                      the currency enabled for this merchant. Enabling live mode
                      requires merchant approval and provider acceptance
                      testing; this form creates no financial transaction.
                    </p>
                    <ActionForm
                      action="organisation.payment"
                      organisationId={selected.id}
                      next={next}
                    >
                      <label>
                        Payment mode
                        <select name="mode" defaultValue={selected.paymentMode}>
                          <option value="disabled">Disabled</option>
                          <option value="live">Live provider</option>
                        </select>
                      </label>
                      <label>
                        Replacement integration ID
                        <input
                          name="integrationId"
                          maxLength={100}
                          autoComplete="off"
                        />
                      </label>
                      <label>
                        Replacement integration key
                        <input
                          name="integrationKey"
                          type="password"
                          maxLength={256}
                          autoComplete="new-password"
                        />
                      </label>
                      <label>
                        Merchant currency
                        <input
                          name="currency"
                          pattern="[A-Z]{3}"
                          maxLength={3}
                          placeholder="USD"
                        />
                      </label>
                      <button className="button">
                        Save merchant configuration
                      </button>
                    </ActionForm>
                  </section>
                  <section className="panel">
                    <h2>Organisation staff grants</h2>
                    <p className="muted">
                      Organisation membership gives metadata access. Personal,
                      medical and financial records still require individual
                      property capabilities. Staff must have verified contacts
                      and confirmed MFA.
                    </p>
                    <ActionForm
                      action="organisation.membership"
                      organisationId={selected.id}
                      next={next}
                    >
                      <label>
                        Verified staff account ID
                        <input name="userId" required maxLength={100} />
                      </label>
                      <label>
                        Organisation role
                        <select name="role">
                          <option value="MEMBER">Member</option>
                          <option value="ADMIN">
                            Organisation administrator
                          </option>
                        </select>
                      </label>
                      <button className="button">
                        Grant organisation membership
                      </button>
                    </ActionForm>
                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>Staff account</th>
                            <th>Role</th>
                            <th>Revocation</th>
                          </tr>
                        </thead>
                        <tbody>
                          {memberships.map((m) => (
                            <tr key={m.id}>
                              <td>
                                {m.user.name}
                                <br />
                                <small>{m.user.email}</small>
                              </td>
                              <td>{m.role}</td>
                              <td>
                                <ActionForm
                                  action="organisation.membership.revoke"
                                  id={m.id}
                                  next={next}
                                >
                                  <label>
                                    Revocation reason
                                    <input
                                      name="reason"
                                      required
                                      minLength={10}
                                      maxLength={2000}
                                    />
                                  </label>
                                  <button className="button secondary">
                                    Revoke organisation membership
                                  </button>
                                </ActionForm>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </section>
                </>
              )}
            </>
          )}
          {operator && (
            <section className="panel">
              <h2>Provision an organisation</h2>
              <p className="muted">
                Provisioning does not grant the platform operator access to
                tenant records. The initial organisation administrator must
                already have verified contacts and MFA.
              </p>
              <ActionForm action="organisation.create" next={next}>
                <label>
                  New organisation name
                  <input name="name" required minLength={3} maxLength={120} />
                </label>
                <label>
                  New organisation slug
                  <input
                    name="slug"
                    required
                    pattern="[a-z0-9][a-z0-9-]+"
                    maxLength={80}
                  />
                </label>
                <label>
                  New organisation legal entity
                  <input
                    name="legalEntity"
                    required
                    minLength={3}
                    maxLength={150}
                  />
                </label>
                <label>
                  Initial verified administrator account ID
                  <input name="adminUserId" required maxLength={100} />
                </label>
                <label>
                  Initial approved residency region
                  <input name="residencyRegion" maxLength={100} />
                </label>
                <button className="button">Provision organisation</button>
              </ActionForm>
            </section>
          )}
        </main>
      </div>
    </div>
  );
}
