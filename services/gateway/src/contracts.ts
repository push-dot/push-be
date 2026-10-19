/**
 * Routes this worker answers itself, checked against the FastAPI OpenAPI
 * export. Response bodies stay hand-built: a cache hit must not call Python,
 * and the bytes are already covered by the gateway tests. The planned
 * TypeScript core-api service is what should return these operations.
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
