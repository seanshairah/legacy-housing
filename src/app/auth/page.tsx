import { PublicNav } from "../../components/ui";
import { AuthForm } from "../../components/auth-form";
export default function Auth() {
  return (
    <>
      <PublicNav />
      <main id="main" className="auth-layout">
        <div className="auth-aside">
          <div className="eyebrow">LIVE WELL. GROW HERE.</div>
          <h2>
            Good things
            <br />
            start with a<br />
            <em>place to belong.</em>
          </h2>
          <p>
            Applications, payments, agreements, and support — all together, all
            yours.
          </p>
          <div className="abstract-door" />
        </div>
        <AuthForm />
      </main>
    </>
  );
}
