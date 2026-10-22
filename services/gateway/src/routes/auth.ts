import { pyJson } from "../time.ts";
import type { Deps, FrontEnv } from "../types.ts";
import { conditional, USER_CACHE_CONTROL } from "../http.ts";
import { requireUser } from "../middleware/auth.ts";

export async function authMe(request: Request, env: FrontEnv, deps: Deps, rid: string, limits: { user: number; public: number; windowMs: number }, now: () => Date): Promise<Response> {
  const user = await requireUser(request, env, deps, rid, limits, now);
  if (user instanceof Response) return user;
  const text = pyJson({
    data: {
      id: user.id, displayName: user.displayName,
      locale: user.locale, createdAt: user.createdAt,
      accountType: user.accountType, companyId: user.companyId, companyRole: user.companyRole,
      email: user.email, provider: user.provider, plan: user.plan,
    },
  });
  return conditional(text, request, rid, USER_CACHE_CONTROL);
}
