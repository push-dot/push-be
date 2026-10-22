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
  { provider: "OPENAI", model: "opencode-go/deepseek-v4.1-flash", label: "DeepSeek V4.1 Flash Go" },
  { provider: "OPENAI", model: "openai/gpt-5.6-luna", label: "GPT-5.6 Luna" },
  { provider: "OPENAI", model: "openai/gpt-5.6-terra", label: "GPT-5.6 Terra" },
  { provider: "OPENAI", model: "openai/gpt-5.6-sol", label: "GPT-5.6 Sol" },
];

export function validProvider(value: string): boolean {
  return (AI_PROVIDERS as readonly string[]).includes(value);
}

export function listModels(opts: {
  provider: string;
  managedAi: boolean;
  managedGo: boolean;
}): ModelRow[] {
  const models: ModelRow[] = [];
  for (const m of OPENAI_MODELS) {
    if (opts.provider && opts.provider !== m.provider) continue;
    const available = m.model.startsWith("opencode-go/") ? opts.managedGo : opts.managedAi;
    models.push({
      provider: m.provider,
      model: m.model,
      label: m.label,
      available,
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
