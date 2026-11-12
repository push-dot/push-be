import { isMissingRelation, query } from "../db.ts";
import type { Ctx } from "../types.ts";

const EXPO_PUSH = "https://exp.host/--/api/v2/push/send";

export const deliverPush = async (
  ctx: Ctx,
  userId: string,
  title: string,
  body: string,
  data: Record<string, unknown>,
): Promise<void> => {
  const token = ctx.env.EXPO_ACCESS_TOKEN?.trim() ?? "";
  if (!token) return;
  let rows;
  try {
    // No push during the 30-day deletion grace period.
    rows = await query(ctx.deps.query, "SELECT d.token FROM user_devices d JOIN users u ON u.id = d.user_id WHERE d.user_id = $1 AND u.deletion_requested_at IS NULL", [userId]);
  } catch (err) {
    if (isMissingRelation(err)) return;
    throw err;
  }
  if (!rows.rows.length) return;
  const messages = rows.rows.map((row) => ({ to: String(row.token), title, body, data }));
  const fetchImpl = ctx.deps.fetch ?? fetch;
  try {
    await fetchImpl(EXPO_PUSH, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(messages),
    });
  } catch {
    return;
  }
};
