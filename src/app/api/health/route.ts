import { NextResponse } from "next/server";

/**
 * Minimal liveness endpoint — useful for Vercel deployment checks and as a
 * smoke-test target (see e2e/smoke.spec.ts). Extend with a real Supabase
 * ping once you have a project wired up:
 *
 *   const supabase = await createClient();
 *   const { error } = await supabase.from("<table>").select("id").limit(1);
 */
export function GET() {
  return NextResponse.json({ ok: true, service: "maple-standard", timestamp: new Date().toISOString() });
}
