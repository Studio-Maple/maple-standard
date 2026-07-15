"use client";

import { useEffect } from "react";

import * as Sentry from "@sentry/nextjs";
import NextError from "next/error";

/**
 * Root error boundary — Next.js renders this only when an error escapes
 * every nested `error.tsx`. Reports to Sentry via the shared entry point's
 * underlying SDK so a crash at the very top of the tree is never silent.
 */
export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body>
        <NextError statusCode={0} />
      </body>
    </html>
  );
}
