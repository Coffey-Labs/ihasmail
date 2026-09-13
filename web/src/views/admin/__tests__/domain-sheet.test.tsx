import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSession } from "@/store/session";
import type { JmapSession } from "@/jmap/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const domain = {
  id: "d1",
  name: "example.com",
  aliases: {},
  subAddressing: { "@type": "Custom" },
  dnsManagement: { "@type": "Manual" },
  dkimManagement: { "@type": "Automatic" },
  certificateManagement: { "@type": "Manual" },
  dnsZoneFile: 'example.com. IN MX 10 mail.example.com.\nexample.com. IN TXT "v=spf1 mx -all"\n',
};

vi.mock("@/lib/adminDomains", async (original) => ({
  ...(await original<typeof import("@/lib/adminDomains")>()),
  getDomains: vi.fn(async () => [domain]),
  listDkimKeys: vi.fn(async () => [{ id: "k1", "@type": "Dkim1Ed25519Sha256", selector: "v1-ed25519", stage: "active" }]),
}));

const { DomainSheet } = await import("../DomainSheet");

const signIn = (permissions: string[]) =>
  useSession.setState({ session: { capabilities: {}, accounts: {}, primaryAccounts: {}, username: "a@example.com", ihasmail: { permissions } } as unknown as JmapSession });

const button = (host: HTMLElement, text: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.includes(text));

/**
 * What decides whether a domain can be removed is not the button but what
 * still uses it, and some of that is the domain's own keys.
 */
describe("the domain sheet", () => {
  let host: HTMLDivElement;
  let root: Root;
  const render = async (accountCount: number | undefined) => {
    await act(async () => {
      root.render(<DomainSheet id="d1" accountCount={accountCount} onClose={() => {}} onChanged={() => {}} onCreated={() => {}} onDeleted={() => {}} />);
    });
    await act(async () => {});
  };

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it("lists the records one per row, unquoted", async () => {
    signIn(["sysDomainGet", "sysDomainQuery"]);
    await render(0);
    expect(host.querySelectorAll(".admin-dns-row").length).toBe(2);
    expect(host.textContent).toContain("v=spf1 mx -all");
    expect(host.textContent).not.toContain('"v=spf1');
  });

  it("will not offer removal while accounts use the domain", async () => {
    signIn(["sysDomainGet", "sysDomainQuery", "sysDomainDestroy", "sysDkimSignatureQuery", "sysDkimSignatureGet", "sysDkimSignatureDestroy"]);
    await render(3);
    expect(host.textContent).toContain("3 accounts use this domain");
    expect(button(host, "Remove domain")?.disabled).toBe(true);
  });

  it("will not offer removal when the keys that must go first cannot be removed", async () => {
    signIn(["sysDomainGet", "sysDomainQuery", "sysDomainDestroy", "sysDkimSignatureQuery", "sysDkimSignatureGet"]);
    await render(0);
    expect(host.textContent).toContain("your role can't remove them");
    expect(button(host, "Remove domain")?.disabled).toBe(true);
  });

  it("leaves a plus-addressing rule set on the server alone", async () => {
    signIn(["sysDomainGet", "sysDomainQuery", "sysDomainUpdate"]);
    await render(0);
    expect(host.textContent).toContain("Set by a custom rule on the server.");
    expect((host.querySelector('button[role="switch"]') as HTMLButtonElement).disabled).toBe(true);
  });
});
