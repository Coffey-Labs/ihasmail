import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { useSession } from "@/store/session";
import type { JmapSession } from "@/jmap/types";
import { AdminNav } from "../AdminNav";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const signIn = (permissions: string[]) =>
  useSession.setState({ session: { capabilities: {}, accounts: {}, primaryAccounts: {}, username: "a@example.com", ihasmail: { permissions } } as unknown as JmapSession });

/** The folder pane's list of Administration sections: only what the role can read. */
describe("the Administration list in the folder pane", () => {
  let host: HTMLDivElement;
  let root: Root;
  const render = async (path: string) => {
    const { hook } = memoryLocation({ path });
    await act(async () => {
      root.render(<Router hook={hook}><AdminNav /></Router>);
    });
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

  it("lists each readable section under its group and marks the open one", async () => {
    signIn(["sysAccountQuery", "sysAccountGet", "sysDomainQuery", "sysDomainGet"]);
    await render("/admin/domains/d1");
    expect([...host.querySelectorAll(".nav-section")].map((e) => e.textContent)).toEqual(["Overview", "Directory", "Mail"]);
    expect(host.querySelector(".nav-item.active")?.textContent).toBe("Domains");
  });

  it("treats a bare /admin as the dashboard, which is what the page opens", async () => {
    signIn(["sysAccountQuery", "sysAccountGet", "sysDomainQuery", "sysDomainGet"]);
    await render("/admin");
    expect(host.querySelector(".nav-item.active")?.textContent).toBe("Dashboard");
  });

  it("leaves out what the role cannot read", async () => {
    signIn(["sysDomainQuery", "sysDomainGet"]);
    await render("/admin/accounts");
    expect(host.textContent).not.toContain("Accounts");
    expect(host.querySelector(".nav-item.active")?.textContent).toBe("Dashboard");
  });

  it("offers the dashboard alone to a role that can only count", async () => {
    signIn(["sysQueuedMessageQuery"]);
    await render("/admin");
    expect([...host.querySelectorAll(".nav-item")].map((e) => e.textContent)).toEqual(["Dashboard"]);
  });
});
