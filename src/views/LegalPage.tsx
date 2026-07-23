import { useEffect, type ReactNode } from 'react'
import {
  PROJECT_CONTACT_EMAIL,
  PROJECT_REPOSITORY_URL,
  RIOT_PROJECT_NOTICE,
  type LegalPageName,
} from '../lib/legal'

const UPDATED_AT = 'July 11, 2026'
const OPERATOR_NAME = 'Maximilian Mauroner'

export function LegalPage({ page }: { page: LegalPageName }) {
  const title = page === 'legal' ? 'Legal notice' : page === 'privacy' ? 'Privacy policy' : 'Licenses & sources'

  useEffect(() => {
    document.title = `${title} · LoL Esports Power Index`
  }, [title])

  return (
    <main className="min-h-screen bg-[var(--bg)] px-[var(--page-x)] py-8 text-[var(--text)]">
      <div className="mx-auto grid w-full max-w-[900px] gap-6">
        <header className="flex flex-wrap items-center justify-between gap-4 border-b border-[var(--line)] pb-5">
          <div>
            <a className="text-[0.72rem] tracking-[0.16em] text-[var(--accent)] uppercase" href="/">LoL Esports Power Index</a>
            <h1 className="mt-2 text-3xl font-bold text-[var(--text-strong)]">{title}</h1>
            <p className="mt-1 text-sm text-[var(--muted)]">Last updated: {UPDATED_AT}</p>
          </div>
          <nav className="flex flex-wrap gap-3 text-sm" aria-label="Legal pages">
            <LegalLink href="/legal">Legal</LegalLink>
            <LegalLink href="/privacy">Privacy</LegalLink>
            <LegalLink href="/licenses">Licenses</LegalLink>
          </nav>
        </header>

        {page === 'legal' ? <LegalNotice /> : page === 'privacy' ? <PrivacyPolicy /> : <Licenses />}

        <footer className="border-t border-[var(--line)] pt-5 text-sm text-[var(--muted)]">
          <a className="hover:text-[var(--text)] hover:underline" href="/">Back to the rankings</a>
        </footer>
      </div>
    </main>
  )
}

function LegalNotice() {
  return (
    <div className="grid gap-4">
      <Section title="Operator and editorial responsibility">
        <p>{OPERATOR_NAME}</p>
        <p>Private individual · Italy</p>
        <p><EmailLink /></p>
        <p className="mt-3">LoL Esports Power Index and Lab4Code are project names, not separate legal entities or registered companies. No company-register, REA, VAT, or professional-register details apply.</p>
      </Section>
      <Section title="Nature of the project">
        <p>This is a privately operated, free, non-commercial esports analytics project. It has no advertising, subscriptions, sales, gambling, or betting functionality. Rankings are independent model outputs, not official standings, professional advice, or guarantees of future results.</p>
      </Section>
      <Section title="Riot Games notice">
        <p>{RIOT_PROJECT_NOTICE}</p>
      </Section>
      <Section title="Content and external links">
        <p>Ranking claims identify their source coverage and model configuration where available. External sites are responsible for their own content and privacy practices. If you believe that content is inaccurate or infringes a right, contact the operator so it can be reviewed promptly.</p>
      </Section>
    </div>
  )
}

function PrivacyPolicy() {
  return (
    <div className="grid gap-4">
      <Section title="Controller">
        <p>{OPERATOR_NAME}, private individual, Italy</p>
        <p><EmailLink /></p>
      </Section>
      <Section title="Website requests and hosting">
        <p>When you open the site, technical request data such as IP address, requested URL, time, browser headers, and request identifiers is transmitted to Railway, the hosting provider. It is processed to deliver and secure the site under GDPR Article 6(1)(f). The operator does not run visitor analytics or advertising and does not set cookies or use browser storage.</p>
        <p className="mt-3">Operational and security logs are retained only for the period configured by the hosting provider or as needed to investigate abuse and faults. Railway primarily processes data in the United States and provides transfer safeguards through the EU-U.S. Data Privacy Framework or EU Standard Contractual Clauses. See Railway's <ExternalLink href="https://railway.com/legal/privacy">privacy policy</ExternalLink> and <ExternalLink href="https://railway.com/legal/dpa">data-processing terms</ExternalLink>.</p>
      </Section>
      <Section title="Professional esports data">
        <p>The project processes publicly available professional-player identifiers, team membership, match and game statistics, and model-derived performance ratings. Sources include Oracle's Elixir, Leaguepedia, and public LoL Esports information. Processing supports transparent esports research and rankings under the operator's legitimate interests in analysis, documentation, and freedom of expression (GDPR Article 6(1)(f)).</p>
        <p className="mt-3">Ratings are automated statistical assessments of professional match performance. They do not make decisions that produce legal or similarly significant effects. Published data is retained while relevant to historical rankings, model reproducibility, source correction, and auditability. It may be available publicly through this site and the project's GitHub repository.</p>
      </Section>
      <Section title="Contact and GitHub">
        <p>If you email the operator, your address, message, and any information you provide are used only to answer and handle the request and retained only while needed for that purpose or legal recordkeeping. Following a GitHub link transfers you to GitHub, which acts under its own <ExternalLink href="https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement">privacy statement</ExternalLink>.</p>
      </Section>
      <Section title="Your rights">
        <p>You may request access, correction, deletion, restriction, or portability where applicable, and may object to processing based on legitimate interests. You may also complain to the Italian Data Protection Authority, the <ExternalLink href="https://www.garanteprivacy.it/">Garante per la protezione dei dati personali</ExternalLink>. Requests can be sent to <EmailLink />.</p>
      </Section>
    </div>
  )
}

function Licenses() {
  return (
    <div className="grid gap-4">
      <Section title="Riot Games intellectual property">
        <p>{RIOT_PROJECT_NOTICE}</p>
        <p className="mt-3">Riot Games names, game assets, league marks, and related properties remain owned by Riot Games or their respective owners and are not granted under the repository's MIT license. See Riot's <ExternalLink href="https://www.riotgames.com/en/legal">Legal Jibber Jabber</ExternalLink>.</p>
      </Section>
      <Section title="Ranking data sources">
        <ul className="list-disc space-y-2 pl-5">
          <li>Oracle's Elixir match and player CSV data, credited to Oracle's Elixir / Tim Sevenhuysen and subject to upstream terms and Riot game-data policies.</li>
          <li>Leaguepedia Cargo data, credited to Leaguepedia contributors. To the extent the published artifacts adapt copyrightable Leaguepedia content, those adaptations are available under <ExternalLink href="https://creativecommons.org/licenses/by-sa/3.0/">CC BY-SA 3.0</ExternalLink>. The data is transformed and may contain corrections and derived ratings. See the <ExternalLink href="https://lol.fandom.com/wiki/Leaguepedia:Copyrights">Leaguepedia copyright notice</ExternalLink>.</li>
          <li>Public LoL Esports schedule and result references are cached for provenance and are not presented as a supported official API.</li>
        </ul>
      </Section>
      <Section title="Project code and model outputs">
        <p>Original project source code is available under the MIT License in the <ExternalLink href={`${PROJECT_REPOSITORY_URL}/blob/main/LICENSE`}>repository</ExternalLink>. That license does not override third-party data, asset, font, icon, or trademark terms.</p>
      </Section>
      <Section title="Third-party software">
        <p>The application uses open-source packages including React, Recharts, Base UI, Lucide, Tailwind CSS, and JetBrains Mono. Their MIT, ISC, Apache-2.0, BSD, and SIL Open Font License terms remain with the respective authors. Package names and exact versions are recorded in the repository's <ExternalLink href={`${PROJECT_REPOSITORY_URL}/blob/main/package.json`}>package manifest</ExternalLink> and lockfile.</p>
      </Section>
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-[var(--r)] border border-[var(--line)] bg-[var(--surface)] p-5 text-sm leading-7 text-[var(--muted)] shadow-[var(--shadow-1)]">
      <h2 className="mb-3 text-lg font-bold text-[var(--text-strong)]">{title}</h2>
      {children}
    </section>
  )
}

function LegalLink({ href, children }: { href: string; children: ReactNode }) {
  return <a className="text-[var(--muted)] hover:text-[var(--text)] hover:underline" href={href}>{children}</a>
}

function EmailLink() {
  return <a className="text-[var(--accent)] hover:underline" href={`mailto:${PROJECT_CONTACT_EMAIL}`}>{PROJECT_CONTACT_EMAIL}</a>
}

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return <a className="text-[var(--accent)] hover:underline" href={href} target="_blank" rel="noreferrer">{children}</a>
}
