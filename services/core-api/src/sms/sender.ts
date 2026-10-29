import type { CoreEnv } from "../types.ts";

export interface SmsSender {
  send(phone: string, code: string): Promise<void>;
}

type SmsEnv = Pick<CoreEnv, "APP_ENV" | "PHONE_SMS_MODE">;

export const smsConfigured = (env: SmsEnv): boolean =>
  env.PHONE_SMS_MODE === "log" && env.APP_ENV === "development";

export const createSmsSender = (env: SmsEnv): SmsSender => ({
  send: async (phone, code) => {
    if (!smsConfigured(env)) throw new Error("sms not configured");
    console.log(`[sms] ${phone} ${code}`);
  },
});
