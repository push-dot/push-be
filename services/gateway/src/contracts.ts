/**
 * Routes this worker answers itself, checked against
 * packages/contracts/openapi.json. Response bodies stay hand-built: a cache hit must not call
 * another worker, and the bytes are already covered by the gateway tests.
 */

import type { paths } from "@push/contracts";

export const GATEWAY_ROUTES = [
  "/healthz",
  "/api/v1/healthz",
  "/api/v1/auth/me",
  "/api/v1/conversations",
  "/api/v1/ai/models",
  "/api/v1/integrations/job-sites",
] as const satisfies readonly (keyof paths)[];
