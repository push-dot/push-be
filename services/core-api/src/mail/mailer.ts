export type Mail = { to: string; subject: string; text: string; html: string };

export interface Mailer {
  send(mail: Mail): Promise<void>;
}

type MailEnv = {
  EMAIL?: {
    send(message: { to: string; from: string; subject: string; text: string; html: string }): Promise<unknown>;
  };
  APP_ENV?: string;
  MAIL_FROM?: string;
};

export const createMailer = (env: MailEnv): Mailer => ({
  send: async (mail) => {
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
