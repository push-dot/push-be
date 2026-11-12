/** Static catalog. Kept in lockstep with `OPENAI_MODELS` in the Python API. */

export const AI_PROVIDERS = ["OPENAI", "OPENROUTER", "CLAUDE", "GEMINI", "GROK"] as const;
export const EFFORTS = ["LOW", "MEDIUM", "HIGH", "MAX"];

export interface ModelRow {
  provider: string;
  model: string;
  label: string;
  available: boolean;
  supportedEfforts: string[];
}

export const OPENAI_MODELS: Array<{ provider: string; model: string; label: string }> = [
  { provider: "OPENAI", model: "deepseek/deepseek-v4.1-flash", label: "DeepSeek V4.1 Flash" },
];

export function validProvider(value: string): boolean {
  return (AI_PROVIDERS as readonly string[]).includes(value);
}

export function listModels(opts: {
  provider: string;
  managedAi: boolean;
}): ModelRow[] {
  const models: ModelRow[] = [];
  for (const m of OPENAI_MODELS) {
    if (opts.provider && opts.provider !== m.provider) continue;
    models.push({
      provider: m.provider,
      model: m.model,
      label: m.label,
      available: opts.managedAi,
      supportedEfforts: EFFORTS,
    });
  }
  return models;
}

export const JOB_SITE_CHECKLIST = [
  "Open the job posting in the built-in browser",
  "Review the extracted fields against the posting",
  "Upload finalized documents manually",
  "Confirm submission in the site UI",
  "Record the submission via POST /applications/:id/submission-drafts",
];

export function jobSitesBody(): { data: unknown[] } {
  return {
    data: ["WANTED", "JUMPIT", "JOBKOREA"].map((provider) => ({
      provider,
      enabled: false,
      permissionVerified: false,
      mode: "MANUAL_CHECKLIST",
      supportedFields: [],
      checklist: JOB_SITE_CHECKLIST,
    })),
  };
}
