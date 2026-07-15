import { WelcomeCard } from "@/components/welcome-card";

export default function Home() {
  return (
    <main className="page">
      <h1>maple-standard</h1>
      <p>
        A Next.js (App Router, TypeScript) + Supabase + Vercel starter with the
        quality/observability/security framework already wired in. Replace
        this page — the framework is what matters.
      </p>
      <WelcomeCard projectName="your-project" />
    </main>
  );
}
