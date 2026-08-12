import { sendJson } from "../http.ts";
import { isObj } from "./shared.ts";
import { audit } from "./shared.ts";
import { errMessage } from "../../util/errors.ts";
import { scopeId } from "../../types.ts";
import { syncBeadhiveProjects } from "../../beadhive/sync.ts";
import type { ApiCtx, Route } from "./route.ts";

async function projectsEnabled(ctx: ApiCtx): Promise<boolean> {
  return (await ctx.deps.config?.getBeadhiveProjectsDurable()) === true;
}

async function syncProjects(ctx: ApiCtx): Promise<void> {
  if (!(await projectsEnabled(ctx))) return sendJson(ctx.res, 404, { error: "not_found" });
  const { deps } = ctx;
  if (!deps.sandbox) return sendJson(ctx.res, 503, { error: "sandbox_unavailable" });
  if (!deps.beadhiveHome) {
    return sendJson(ctx.res, 503, {
      error: "beadhive_home_unset",
      message: "the sandbox has no BH_HOME, so it does not know where its fleet is",
    });
  }
  const body = isObj(ctx.body) ? ctx.body : {};
  const requested = typeof body.principalId === "string" ? body.principalId.trim() : "";
  const ownerId = ctx.capability?.actorId ?? requested;
  if (!ownerId) return sendJson(ctx.res, 400, { error: "bad_request", message: "principalId required" });
  if (ctx.capability && requested && requested !== ctx.capability.actorId) {
    return sendJson(ctx.res, 404, { error: "not_found" });
  }

  try {
    const result = await syncBeadhiveProjects({
      sandbox: deps.sandbox,
      bhHome: deps.beadhiveHome,
      ownerId,
      list: () => ctx.app.listProjects(ownerId),
      create: (name, beadhive) => ctx.app.createProject(ownerId, name, beadhive),
    });
    audit(deps, {
      principalId: ownerId,
      action: "beadhive.sync",
      resource: `${result.created.length} created, ${result.orphaned.length} orphaned`,
      scopeLabel: scopeId("personal", ownerId),
    });
    return sendJson(ctx.res, 200, result);
  } catch (e) {
    return sendJson(ctx.res, 502, { error: "sync_failed", message: errMessage(e) });
  }
}

export const beadhiveRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "POST", path: "/v1/beadhive/sync", auth: "either", handle: syncProjects },
];
