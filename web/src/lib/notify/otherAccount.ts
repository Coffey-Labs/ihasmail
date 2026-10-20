/**
 * JMAP calls made as a signed-in account that isn't in front,
 * through the webmail server's narrow route for it
 * (POST /api/auth/accounts/<sessionId>/jmap). The server allows only what
 * notifications need: push subscriptions, mailboxes, and marking or filing
 * mail.
 */
import { apiFetch, CAP } from "@/jmap/client";
import type { JmapCall } from "@/lib/notify/webpush";

export function otherAccountCall(sessionId: string): JmapCall {
  return async <T,>(method: string, args: Record<string, unknown>, using: string[]): Promise<T> => {
    const res = await apiFetch<{ methodResponses?: [string, unknown, string][] }>(
      `/api/auth/accounts/${encodeURIComponent(sessionId)}/jmap`,
      { method: "POST", body: JSON.stringify({ using: [...new Set([CAP.core, ...using])], methodCalls: [[method, args, "0"]] }) },
    );
    const [name, out] = res.methodResponses?.[0] ?? [];
    if (!name) throw new Error("The mail server sent no response.");
    if (name === "error") throw new Error(String((out as { type?: string } | undefined)?.type ?? "error"));
    return out as T;
  };
}
