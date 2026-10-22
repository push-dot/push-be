export type Mail = {
  to: string;
  subject: string;
  text: string;
  html: string;
  idempotencyKey?: string;
};

export interface Mailer {
  send(mail: Mail): Promise<void>;
}

type MailEnv = {
  EMAIL?: {
    send(message: { to: string; from: string; subject: string; text: string; html: string }): Promise<unknown>;
  };
  APP_ENV?: string;
  MAIL_FROM?: string;
  RESEND_API_KEY?: string;
};

export const createMailer = (env: MailEnv, fetchImpl?: typeof fetch): Mailer => ({
  send: async (mail) => {
    const key = (env.RESEND_API_KEY ?? "").trim();
    if (key) {
      const res = await (fetchImpl ?? fetch)("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          "Idempotency-Key": mail.idempotencyKey ?? crypto.randomUUID(),
        },
        body: JSON.stringify({
          from: env.MAIL_FROM ?? "",
          to: mail.to,
          subject: mail.subject,
          html: mail.html,
          text: mail.text,
        }),
      });
      if (!res.ok) {
        console.log(`[mail] resend status ${res.status}`);
        throw new Error("resend failed");
      }
      return;
    }
    if (env.EMAIL?.send) {
      await env.EMAIL.send({
        to: mail.to,
        from: env.MAIL_FROM ?? "",
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
      });
      return;
    }
    const from = env.MAIL_FROM || "noreply@push.local";
    console.log(`[mail] ${from} -> ${mail.to} ${mail.subject} ${mail.text}`);
  },
});
