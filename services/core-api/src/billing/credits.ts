export const DISPLAY_MICRO = 6000;

const PERSONAL: Record<string, number> = {
  FREE: 1_800_000,
  PRO: 30_000_000,
  ULTRA: 100_000_000,
};

const EMPLOYER: Record<string, number> = {
  BASIC: 18_000_000,
  PRO: 90_000_000,
  ULTRA: 180_000_000,
};

export const grantMicro = (audience: "PERSONAL" | "EMPLOYER", plan: string): number => {
  const table = audience === "EMPLOYER" ? EMPLOYER : PERSONAL;
  return table[plan] ?? 0;
};

export const iapTopupMicro = (raw: string | undefined): number => {
  const text = raw?.trim() ?? "";
  if (text === "") return 300 * DISPLAY_MICRO;
  if (!/^[1-9]\d*$/.test(text)) return 300 * DISPLAY_MICRO;
  return Number(text) * DISPLAY_MICRO;
};
