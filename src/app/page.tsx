import Link from "next/link";
import {
  ArrowUpRight,
  ShieldCheck,
  Wifi,
  HeartHandshake,
  MapPin,
  MoveUpRight,
  ArrowRight,
} from "lucide-react";
import { db } from "../lib/db";
import { PublicNav, Brand } from "../components/ui";
export const dynamic = "force-dynamic";
export default async function Home({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const q = await searchParams;
  const properties = await db.property.findMany({
    where: { published: true },
    include: {
      buildings: {
        include: {
          floors: { include: { rooms: { include: { beds: true } } } },
        },
      },
    },
    take: 6,
  });
  return (
    <>
      <PublicNav />
      {q.success && (
        <p className="notice" role="status" style={{ margin: "20px 6%" }}>
          Your enquiry has been recorded. Thank you.
        </p>
      )}
      {q.error && (
        <p className="notice error" role="alert" style={{ margin: "20px 6%" }}>
          {q.error}
        </p>
      )}
      <main id="main">
        <section className="hero">
          <div className="hero-copy">
            <div className="eyebrow">
              <span className="line" /> SPACE TO LIVE. ROOM TO GROW.
            </div>
            <h1>
              More than a room.
              <br />
              Your next <em>chapter.</em>
            </h1>
            <p>
              A place to settle in, find your people, and make the most of what
              comes next. Welcome to a more thoughtful way of living.
            </p>
            <div className="hero-actions">
              <Link href="/rooms" className="button">
                Explore our spaces <ArrowUpRight size={19} />
              </Link>
              <Link href="/auth?action=register" className="text-link">
                Already feel at home? Sign in <ArrowRight size={16} />
              </Link>
            </div>
            <div className="hero-note">
              <ShieldCheck size={20} />
              <div>
                <strong>A home, thoughtfully managed.</strong>
                <span>
                  Secure access. Clear payments. Support when you need it.
                </span>
              </div>
            </div>
          </div>
          <div
            className="hero-art"
            aria-label="Abstract architectural illustration, not a photograph of a client property"
          >
            <div className="art-sun" />
            <div className="art-building back">
              <div />
              <div />
              <div />
              <div />
              <div />
              <div />
            </div>
            <div className="art-building front">
              <div />
              <div />
              <div />
              <div />
              <div />
              <div />
              <div />
              <div />
              <div />
              <div />
              <div />
              <div />
            </div>
            <div className="art-plant" />
            <div className="art-label">
              <span className="dot" /> A LITTLE MORE ROOM FOR LIFE{" "}
              <MoveUpRight size={18} />
            </div>
            <div className="art-caption">
              Architectural illustration · client photography pending
            </div>
          </div>
        </section>
        <div className="promise-strip">
          <span>Built around your everyday.</span>
          <span>
            <ShieldCheck size={19} /> Peace of mind
          </span>
          <span>
            <Wifi size={19} /> Connected living
          </span>
          <span>
            <HeartHandshake size={19} /> People-first support
          </span>
        </div>
        <section className="section" id="spaces">
          <div className="section-title">
            <div>
              <div className="eyebrow">FIND YOUR PLACE</div>
              <h2>Different spaces. The same care.</h2>
            </div>
            <Link href="/rooms" className="text-link">
              Explore availability <ArrowUpRight size={18} />
            </Link>
          </div>
          <div className="property-grid">
            {properties.map((p, i) => (
              <Link
                key={p.id}
                href={`/rooms?property=${p.id}`}
                className="property-card"
              >
                <div className={`property-visual visual-${i % 2}`}>
                  <BuildingArt />
                  <span className="image-label">
                    {p.slug.startsWith("demo-")
                      ? "SYNTHETIC DEMO PROPERTY"
                      : "EXPLORE THIS PROPERTY"}
                  </span>
                </div>
                <div className="property-info">
                  <div>
                    <h3>{p.name}</h3>
                    <p>
                      <MapPin size={14} />
                      {p.location}
                    </p>
                  </div>
                  <span className="round-arrow">
                    <ArrowUpRight size={20} />
                  </span>
                </div>
                <p className="property-description">{p.description}</p>
              </Link>
            ))}
            {!properties.length && (
              <p>
                Our property catalogue is being prepared. Get in touch for
                availability.
              </p>
            )}
          </div>
        </section>
        <section className="experience section" id="experience">
          <div>
            <div className="eyebrow">LESS ADMIN. MORE LIVING.</div>
            <h2>
              Your home.
              <br />
              All in one place.
            </h2>
            <p className="muted">
              From your first application to your next renewal, your resident
              portal keeps the important things simple.
            </p>
            <Link href="/auth" className="button">
              Meet your resident portal <ArrowUpRight size={18} />
            </Link>
          </div>
          <div className="feature-grid">
            {[
              [
                "01",
                "Find your fit",
                "Browse rooms by floor, compare spaces, and reserve an available bed.",
              ],
              [
                "02",
                "Make it official",
                "Apply securely, track your documents, and review your agreement.",
              ],
              [
                "03",
                "Stay in control",
                "See clear invoices, payment status, and receipts in one place.",
              ],
              [
                "04",
                "Feel looked after",
                "Raise a request, follow its progress, and reach your property team.",
              ],
            ].map(([n, t, b]) => (
              <div key={n} className="feature">
                <span>{n}</span>
                <h3>{t}</h3>
                <p>{b}</p>
              </div>
            ))}
          </div>
        </section>
        <section className="contact-band" id="contact">
          <div>
            <div className="eyebrow">LET’S MAKE ROOM FOR YOU</div>
            <h2>Questions before you move?</h2>
            <p>
              Send an enquiry. Our team will help you find the right next step.
            </p>
          </div>
          <form action="/api/actions" method="post" className="enquiry-form">
            <input name="action" value="enquiry" type="hidden" />
            <input name="next" value="/" type="hidden" />
            <label>
              Your name
              <input name="name" required maxLength={120} />
            </label>
            <label>
              Email
              <input name="email" type="email" required />
            </label>
            <label>
              How can we help?
              <textarea
                name="message"
                required
                minLength={10}
                maxLength={2000}
              />
            </label>
            <button className="button">
              Send enquiry <ArrowUpRight size={18} />
            </button>
          </form>
        </section>
      </main>
      <footer>
        <Brand />
        <p>Thoughtful spaces. Brighter beginnings.</p>
        <Link href="/privacy">Privacy & platform policies</Link>
        <span>© {new Date().getFullYear()} Legacy Heights</span>
      </footer>
    </>
  );
}
function BuildingArt() {
  return (
    <div className="mini-building" aria-hidden="true">
      {Array.from({ length: 12 }, (_, i) => (
        <i key={i} />
      ))}
    </div>
  );
}
