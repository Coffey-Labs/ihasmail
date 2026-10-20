import { afterEach, describe, expect, it, vi } from "vitest";
import { otherAccountCall } from "@/lib/notify/otherAccount";
import { listSubscriptions } from "@/lib/notify/webpush";

/** Push calls made as an account that isn't in front. */

afterEach(() => vi.unstubAllGlobals());

function stub(response: unknown) {
  const seen: { url: string; body: any }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
      return { ok: true, status: 200, json: async () => response, text: async () => JSON.stringify(response) } as Response;
    }),
  );
  return seen;
}

describe("otherAccountCall", () => {
  it("goes through that account's route and answers the method's result", async () => {
    const seen = stub({ methodResponses: [["PushSubscription/get", { list: [{ id: "p1", deviceClientId: "d" }] }, "0"]] });
    const subs = await listSubscriptions(otherAccountCall("sess-2"));
    expect(subs.map((s) => s.id)).toEqual(["p1"]);
    expect(seen[0]!.url).toContain("/api/auth/accounts/sess-2/jmap");
    expect(seen[0]!.body.methodCalls[0][0]).toBe("PushSubscription/get");
    expect(seen[0]!.body.using).toContain("urn:ietf:params:jmap:core");
  });

  it("turns a JMAP error into a thrown one", async () => {
    stub({ methodResponses: [["error", { type: "forbidden" }, "0"]] });
    await expect(listSubscriptions(otherAccountCall("sess-2"))).rejects.toThrow("forbidden");
  });
});
