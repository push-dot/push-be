import type { CoreEnv } from "../types.ts";

export interface SmsSender {
  send(phone: string, code: string): Promise<void>;
}

type SmsEnv = Pick<CoreEnv, "APP_ENV" | "PHONE_SMS_MODE" | "SENS_ACCESS_KEY" | "SENS_SECRET_KEY" | "SENS_SERVICE_ID" | "SMS_FROM">;

type SensKeys = { accessKey: string; secretKey: string; serviceId: string; from: string };

const SENS_ORIGIN = "https://sens.apigw.ntruss.com";
const KR_PREFIX = "+82";

const sensKeys = (env: SmsEnv): SensKeys | null => {
  const accessKey = (env.SENS_ACCESS_KEY ?? "").trim();
  const secretKey = (env.SENS_SECRET_KEY ?? "").trim();
  const serviceId = (env.SENS_SERVICE_ID ?? "").trim();
  const from = (env.SMS_FROM ?? "").replaceAll(/\D/g, "");
  return accessKey && secretKey && serviceId && from ? { accessKey, secretKey, serviceId, from } : null;
};

const logMode = (env: SmsEnv): boolean => env.PHONE_SMS_MODE === "log" && env.APP_ENV === "development";

export const smsConfigured = (env: SmsEnv): boolean => logMode(env) || sensKeys(env) !== null;

const domesticNumber = (phone: string): string => {
  if (!phone.startsWith(KR_PREFIX)) {throw new Error("sens sends to +82 numbers only");}
  return `0${phone.slice(KR_PREFIX.length)}`;
};

const sign = async (secretKey: string, message: string): Promise<string> => {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secretKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
};

const sendSens = async (keys: SensKeys, phone: string, code: string, fetchImpl: typeof fetch): Promise<void> => {
  const path = `/sms/v2/services/${encodeURIComponent(keys.serviceId)}/messages`;
  const timestamp = String(Date.now());
  const res = await fetchImpl(`${SENS_ORIGIN}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "x-ncp-apigw-timestamp": timestamp,
      "x-ncp-iam-access-key": keys.accessKey,
      "x-ncp-apigw-signature-v2": await sign(keys.secretKey, `POST ${path}\n${timestamp}\n${keys.accessKey}`),
    },
    body: JSON.stringify({
      type: "SMS",
      contentType: "COMM",
      countryCode: "82",
      from: keys.from,
      content: `[Push] 인증번호 ${code}`,
      messages: [{ to: domesticNumber(phone) }],
    }),
  });
  if (!res.ok) {
    console.info(`[sms] sens status ${res.status}`);
    throw new Error("sens failed");
  }
};

export const createSmsSender = (env: SmsEnv, fetchImpl?: typeof fetch): SmsSender => ({
  send: async (phone, code) => {
    const keys = sensKeys(env);
    if (keys) {return sendSens(keys, phone, code, fetchImpl ?? fetch);}
    if (!logMode(env)) {throw new Error("sms not configured");}
    console.info(`[sms] ${phone} ${code}`);
  },
});
