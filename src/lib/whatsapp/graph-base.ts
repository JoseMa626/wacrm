/**
 * Base URL of the WhatsApp Cloud API (Meta Graph API).
 *
 * Defaults to Meta's production endpoint. `META_GRAPH_BASE_URL` points the
 * app at a compatible stand-in instead — e.g. the local WhatsApp simulator in
 * `tools/wa-sim` (see docs/simulator.md) — without touching any call site.
 *
 * Server-only and read at runtime: changing it needs a restart/redeploy, not
 * a rebuild. It must include the API version segment, e.g.
 * `https://sim.example.com/v21.0`. A trailing slash is ignored.
 */
export const DEFAULT_META_API_BASE = 'https://graph.facebook.com/v21.0'

export function getMetaApiBase(
  env: Record<string, string | undefined> = process.env,
): string {
  const override = env.META_GRAPH_BASE_URL?.trim()
  if (!override) return DEFAULT_META_API_BASE
  return override.replace(/\/+$/, '')
}
