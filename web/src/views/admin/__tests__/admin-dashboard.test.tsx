import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { JmapMethodError } from "@/jmap/client";
import { useSession } from "@/store/session";
import type { JmapSession } from "@/jmap/types";
import type { MetricRecord } from "@/lib/admin/adminDashboard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const feeds = vi.hoisted(() => ({
  counts: { Account: 35, Domain: 3, QueuedMessage: 9 } as Record<string, number>,
  metrics: (): Promise<MetricRecord[]> => Promise.resolve([]),
}));

vi.mock("@/lib/admin/adminDashboard", async (original) => ({
  ...(await original<typeof import("@/lib/admin/adminDashboard")>()),
  countObjects: vi.fn(async (object: string) => feeds.counts[object]),
  loadMetrics: vi.fn(() => feeds.metrics()),
}));

const { AdminDashboard } = await import("../AdminDashboard");

const signIn = (permissions: string[]) =>
  useSession.setState({ session: { capabilities: {}, accounts: {}, primaryAccounts: {}, username: "a@example.com", ihasmail: { permissions } } as unknown as JmapSession });

const HELPDESK = ["sysAccountGet", "sysAccountQuery", "sysAccountUpdate", "sysDomainGet", "sysDomainQuery"];
const TENANT = [...HELPDESK, "sysAccountCreate", "sysDomainCreate", "sysQueuedMessageGet", "sysQueuedMessageQuery"];
const ADMIN = [...TENANT, "sysMetricGet", "sysMetricQuery"];

/** The dashboard shows what the role may read, and nothing a server refuses. */
describe("the Administration dashboard", () => {
  let host: HTMLDivElement;
  let root: Root;
  const render = async () => {
    const { hook } = memoryLocation({ path: "/admin" });
    await act(async () => {
      root.render(<Router hook={hook}><AdminDashboard /></Router>);
    });
    await act(async () => {});
  };
  const cards = () => [...host.querySelectorAll(".admin-card")].map((c) => [c.querySelector(".admin-card-label")?.textContent, c.querySelector(".admin-card-value")?.textContent, c.querySelector(".hint")?.textContent]);
  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    feeds.metrics = () => Promise.resolve([]);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it("gives a helpdesk role its two counts and nothing about the server", async () => {
    signIn(HELPDESK);
    await render();
    expect(cards()).toEqual([
      ["Users", "35", "User accounts"],
      ["Domains", "3", "Mail domains"],
    ]);
  });

  it("gives a tenant administrator the queue as well, but no history", async () => {
    signIn(TENANT);
    await render();
    expect(cards().map((c) => c[0])).toEqual(["Users", "Domains", "Pending"]);
  });

  it("adds the history for a role that reads metrics", async () => {
    feeds.metrics = () =>
      Promise.resolve([
        { "@type": "Gauge", metric: "server.memory", count: 360_000_000, timestamp: "2026-09-15T15:00:00Z" },
        { "@type": "Counter", metric: "queue.message-queued", count: 93, timestamp: "2026-09-15T15:00:00Z" },
        { "@type": "Counter", metric: "queue.report-queued", count: 39, timestamp: "2026-09-15T15:00:00Z" },
      ]);
    signIn(ADMIN);
    await render();
    expect(cards().map((c) => [c[0], c[1]])).toEqual([
      ["Users", "35"],
      ["Domains", "3"],
      ["Pending", "9"],
      ["Server memory", "343 MB"],
      ["Received", "93"],
      ["Sent", "39"],
    ]);
  });

  it("leaves the history off where the server refuses it, as Community does", async () => {
    feeds.metrics = () => Promise.reject(new JmapMethodError("x:Metric/query", { type: "forbidden", description: "This feature is only available in the Enterprise edition" }));
    signIn(ADMIN);
    await render();
    expect(cards().map((c) => c[0])).toEqual(["Users", "Domains", "Pending"]);
  });

  it("says the history is not recorded rather than showing a quiet day", async () => {
    signIn(ADMIN);
    await render();
    expect(cards().slice(3)).toEqual([
      ["Server memory", "—", "Not recorded on this server"],
      ["Received", "—", "Not recorded on this server"],
      ["Sent", "—", "Not recorded on this server"],
    ]);
  });

  it("keeps a card that failed for another reason, and says so", async () => {
    feeds.metrics = () => Promise.reject(new Error("offline"));
    signIn(ADMIN);
    await render();
    expect(cards()[4]).toEqual(["Received", "—", "Could not be loaded"]);
  });
});

describe("the pointer to Stalwart's own administration", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  const renderWith = async (adminUrl: string | null) => {
    useSession.setState({ session: { capabilities: {}, accounts: {}, primaryAccounts: {}, username: "a@example.com", ihasmail: { permissions: HELPDESK, server: { edition: "enterprise", adminUrl } } } as unknown as JmapSession });
    const { hook } = memoryLocation({ path: "/admin" });
    await act(async () => {
      root.render(<Router hook={hook}><AdminDashboard /></Router>);
    });
    await act(async () => {});
  };

  it("names it, and links it where the operator has said where it is", async () => {
    await renderWith("https://admin.example.com");
    const note = host.querySelector(".admin-dashboard-note")!;
    expect(note.textContent).toContain("Stalwart's own administration");
    const link = note.querySelector("a")!;
    expect(link.getAttribute("href")).toBe("https://admin.example.com");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("names it without a link where nobody has", async () => {
    await renderWith(null);
    expect(host.querySelector(".admin-dashboard-note")?.textContent).toContain("Stalwart's own administration");
    expect(host.querySelector(".admin-dashboard-note a")).toBeNull();
  });
});
