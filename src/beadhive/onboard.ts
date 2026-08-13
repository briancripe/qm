import { shq } from "../util/shell.ts";
import type { HiveExec } from "../projects/beadhive-hives.ts";
import { errMessage } from "../util/errors.ts";
import { failureMessage } from "./work.ts";

export type StepStatus = "satisfied" | "ran" | "failed" | "skipped";

export interface OnboardHive {
  provider: string;
  org: string;
  repo: string;
  prefix?: string;
  cloneUrl?: string;
}

export interface OnboardStep {
  id: string;
  title: string;
  probe?: string;
  run: string;
}

export interface OnboardContext {
  bhHome: string;
  workspacePath: string;
  hives: readonly OnboardHive[];
}

export interface StepResult {
  id: string;
  title: string;
  status: StepStatus;
  error?: string;
}

export interface OnboardResult {
  steps: StepResult[];
  ok: boolean;
}

export function hivePath(ctx: Pick<OnboardContext, "workspacePath">, hive: OnboardHive): string {
  return `${ctx.workspacePath.replace(/\/+$/, "")}/${hive.provider}/${hive.org}/${hive.repo}`;
}

export function onboardCommand(ctx: Pick<OnboardContext, "workspacePath">, hive: OnboardHive): string {
  const triplet = `${hive.provider}/${hive.org}/${hive.repo}`;
  const parts = [`bh hive onboard ${shq(triplet)}`];
  if (hive.cloneUrl) parts.push(`--clone-url ${shq(hive.cloneUrl)}`);
  if (hive.prefix) parts.push(`--prefix ${shq(hive.prefix)}`);
  return parts.join(" ");
}

export function onboardingPlan(ctx: OnboardContext): OnboardStep[] {
  const hq = `${ctx.bhHome.replace(/\/+$/, "")}/hq`;
  const steps: OnboardStep[] = [
    { id: "setup-check", title: "Check the toolchain", run: "bh setup check" },
    {
      id: "config-init",
      title: "Write the Beadhive config",
      probe: `test -f ${shq(`${ctx.bhHome.replace(/\/+$/, "")}/config.yaml`)}`,
      run: "bh config init",
    },
    {
      id: "hq-init",
      title: "Stand up Factory HQ",
      probe: `test -d ${shq(`${hq}/.beads`)}`,
      run: "bh hq init",
    },
  ];
  for (const hive of ctx.hives) {
    const triplet = `${hive.provider}/${hive.org}/${hive.repo}`;
    steps.push({
      id: `hive:${triplet}`,
      title: `Onboard ${triplet}`,
      probe: `bh hive list 2>/dev/null | grep -q ${shq(hive.repo)}`,
      run: onboardCommand(ctx, hive),
    });
  }
  steps.push({ id: "doctor", title: "Record what this host observed", run: "bh doctor" });
  return steps;
}

export interface RunOnboardingOptions {
  onStep?: (result: StepResult, index: number, total: number) => void;
  stopOnFailure?: boolean;
}

export async function runOnboarding(
  exec: HiveExec,
  plan: readonly OnboardStep[],
  opts: RunOnboardingOptions = {},
): Promise<OnboardResult> {
  const steps: StepResult[] = [];
  let failed = false;
  for (const [index, step] of plan.entries()) {
    if (failed && opts.stopOnFailure !== false) {
      const skipped: StepResult = { id: step.id, title: step.title, status: "skipped" };
      steps.push(skipped);
      opts.onStep?.(skipped, index, plan.length);
      continue;
    }
    const result = await runStep(exec, step);
    if (result.status === "failed") failed = true;
    steps.push(result);
    opts.onStep?.(result, index, plan.length);
  }
  return { steps, ok: !failed };
}

async function runStep(exec: HiveExec, step: OnboardStep): Promise<StepResult> {
  const base = { id: step.id, title: step.title };
  try {
    if (step.probe && (await exec(step.probe)).code === 0) {
      return { ...base, status: "satisfied" };
    }
    const r = await exec(step.run);
    if (r.code !== 0) return { ...base, status: "failed", error: failureMessage(r.stderr || r.stdout, r.code) };
    if (step.probe && (await exec(step.probe)).code !== 0) {
      return { ...base, status: "failed", error: `${step.run} reported success but ${step.probe} still fails` };
    }
    return { ...base, status: "ran" };
  } catch (e) {
    return { ...base, status: "failed", error: errMessage(e) };
  }
}
