"use client";

import { Button } from "@/components/ui/button";
import { useMediaQuery } from "@/hooks/useMediaQuery";

/**
 * `components/` composes `ui/` primitives + `hooks/` — never imports
 * `services/` directly (that's what makes `ui/` and `components/` portable
 * across a data-source swap). Fetch in a Server Component or a
 * service-backed hook, then pass data down as props.
 */
export function WelcomeCard({ projectName }: { projectName: string }) {
  const isWide = useMediaQuery("(min-width: 768px)");

  return (
    <section className="card">
      <h2>{projectName}</h2>
      <p>{isWide ? "Wide viewport" : "Narrow viewport"} — resize to see this flip.</p>
      <Button onClick={() => window.open("https://github.com", "_blank", "noopener,noreferrer")}>
        Learn more
      </Button>
    </section>
  );
}
