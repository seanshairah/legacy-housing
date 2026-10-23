import { APPLICATION_POLICY } from "../../domain/policies";
import { PublicNav } from "../../components/ui";
export default function Privacy() {
  return (
    <>
      <PublicNav />
      <main id="main" className="section" style={{ maxWidth: 850 }}>
        <div className="eyebrow">PLATFORM POLICIES · APPLICATION POLICY V1</div>
        <h1>Your information, treated with care.</h1>
        <p>{APPLICATION_POLICY}</p>
        <h2>Private documents</h2>
        <p>
          Identity and supporting files are encrypted and remain quarantined
          until scanning succeeds. Authorized reviewers access documents by
          property and job role. Medical declarations are restricted separately.
          Only upload information requested for your application.
        </p>
        <h2>Account security</h2>
        <p>
          Verify your email and mobile number, choose a unique password, and
          consider enabling an authenticator. Staff accounts require an
          authenticator. You can revoke all sessions from your portal.
        </p>
        <h2>Development and launch status</h2>
        <p>
          This is a development implementation. The client’s approved privacy
          notice, legal entity and contact, lawful bases, retention periods,
          data access request route, operative lease terms and Zimbabwe legal
          review must be supplied before real personal data is processed. This
          text is an application disclosure, not a legal compliance
          certification.
        </p>
        <h2>Application consent</h2>
        <p>
          By selecting the application policy checkbox you consent to processing
          the submitted details for this application under policy version
          application-policy-v1. Separate optional marketing and medical consent
          must not be assumed.
        </p>
      </main>
    </>
  );
}
