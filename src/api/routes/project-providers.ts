import { sendJson } from "../http.ts";
import { audit, isObj } from "./shared.ts";
import { errMessage } from "../../util/errors.ts";
import { scopeId, type ScopeId } from "../../types.ts";
import type { ProjectBeadhiveOrigin } from "../../projects/project-store.ts";
import type { ApiCtx, Route } from "./route.ts";

function actorOf(ctx: ApiCtx): string {
  const body = isObj(ctx.body) ? ctx.body : {};
  const requested = typeof body.principalId === "string" ? body.principalId.trim() : "";
  return ctx.capability?.actorId ?? requested;
}

function scopeOf(ctx: ApiCtx, ownerId: string): ScopeId | null {
  const fromQuery = ctx.url.searchParams.get("scopeId")?.trim();
  const body = isObj(ctx.body) ? ctx.body : {};
  const fromBody = typeof body.scopeId === "string" ? body.scopeId.trim() : "";
  const requested = fromQuery || fromBody;
  if (requested) return requested as ScopeId;
  return ownerId ? scopeId("personal", ownerId) : null;
}

async function listProviders(ctx: ApiCtx): Promise<void> {
  const registry = ctx.deps.projectProviders;
  if (!registry) return sendJson(ctx.res, 200, { providers: [] });
  const providers = await Promise.all(
    registry.all().map(async (p) => ({ id: p.id, label: p.label, enabled: await p.enabled() })),
  );
  return sendJson(ctx.res, 200, { providers });
}

async function syncProviders(ctx: ApiCtx): Promise<void> {
  const registry = ctx.deps.projectProviders;
  if (!registry) return sendJson(ctx.res, 404, { error: "not_found" });
  const ownerId = actorOf(ctx);
  if (!ownerId) return sendJson(ctx.res, 400, { error: "bad_request", message: "principalId required" });
  const scope = scopeOf(ctx, ownerId);
  if (!scope) return sendJson(ctx.res, 400, { error: "bad_request", message: "scopeId required" });

  const body = isObj(ctx.body) ? ctx.body : {};
  const wanted = typeof body.providerId === "string" ? body.providerId : "";
  const enabled = await registry.enabled();
  const providers = wanted ? enabled.filter((p) => p.id === wanted) : enabled;
  if (wanted && !providers.length) return sendJson(ctx.res, 404, { error: "not_found" });

  const results = [];
  for (const provider of providers) {
    try {
      const result = await provider.sync({
        ownerId,
        scope,
        list: () => ctx.app.listProjects(ownerId),
        create: (name, origin) => ctx.app.createProject(ownerId, name, origin as unknown as ProjectBeadhiveOrigin),
      });
      results.push(result);
      audit(ctx.deps, {
        principalId: ownerId,
        action: "projects.sync",
        resource: `${provider.id}: ${result.created.length} created, ${result.orphaned.length} orphaned`,
        scopeLabel: scope,
      });
    } catch (e) {
      return sendJson(ctx.res, 502, { error: "sync_failed", providerId: provider.id, message: errMessage(e) });
    }
  }
  return sendJson(ctx.res, 200, { results });
}

async function getWork(ctx: ApiCtx): Promise<void> {
  const store = ctx.deps.projectWork;
  if (!store) return sendJson(ctx.res, 404, { error: "not_found" });
  const scope = scopeOf(ctx, actorOf(ctx));
  if (!scope) return sendJson(ctx.res, 400, { error: "bad_request", message: "scopeId required" });
  const snapshot = await store.get(scope);
  if (snapshot) {
    void store.refresh(scope).catch(() => undefined);
  }
  return sendJson(ctx.res, 200, { scopeId: scope, snapshot });
}

async function refreshWork(ctx: ApiCtx): Promise<void> {
  const store = ctx.deps.projectWork;
  if (!store) return sendJson(ctx.res, 404, { error: "not_found" });
  const scope = scopeOf(ctx, actorOf(ctx));
  if (!scope) return sendJson(ctx.res, 400, { error: "bad_request", message: "scopeId required" });
  const result = await store.refresh(scope);
  return sendJson(ctx.res, result.status === "failed" ? 502 : 200, { scopeId: scope, ...result });
}

export const projectProviderRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "GET", path: "/v1/project-providers", auth: "either", handle: listProviders },
  { method: "POST", path: "/v1/projects/sync", auth: "either", handle: syncProviders },
  { method: "GET", path: "/v1/projects/work", auth: "either", handle: getWork },
  { method: "POST", path: "/v1/projects/work/refresh", auth: "either", handle: refreshWork },
];
