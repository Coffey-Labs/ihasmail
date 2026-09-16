import { describe, expect, it, vi } from "vitest";
import { client, JmapMethodError } from "@/jmap/client";
import { balancedColumns, countObjects, isRefused, loadMetrics, summarizeMetrics, type MetricRecord } from "@/lib/admin/adminDashboard";

const counter = (metric: string, count: number, timestamp = "2026-09-15T14:00:00Z"): MetricRecord => ({ "@type": "Counter", metric, count, timestamp });

describe("the dashboard's message numbers", () => {
  it("adds received and sent up over the metric names Stalwart's own dashboard uses", () => {
    const stats = summarizeMetrics([
      counter("queue.message-queued", 6),
      counter("queue.message-queued", 4, "2026-09-15T13:00:00Z"),
      counter("queue.authenticated-message-queued", 2),
      counter("queue.dsn-queued", 1),
      counter("queue.report-queued", 3),
      // Recorded, but not either number.
      counter("message-ingest.ham", 50),
    ]);
    expect(stats.received).toBe(10);
    expect(stats.sent).toBe(6);
  });

  it("reads memory from the newest gauge, not the first one listed", () => {
    const stats = summarizeMetrics([
      { "@type": "Gauge", metric: "server.memory", count: 100, timestamp: "2026-09-15T12:00:00Z" },
      { "@type": "Gauge", metric: "server.memory", count: 300, timestamp: "2026-09-15T14:00:00Z" },
      { "@type": "Gauge", metric: "queue.count", count: 7, timestamp: "2026-09-15T15:00:00Z" },
    ]);
    expect(stats.memory).toEqual({ bytes: 300, at: "2026-09-15T14:00:00Z" });
  });

  it("tells a history that records nothing from a quiet day", () => {
    expect(summarizeMetrics([]).recorded).toBe(false);
    const quiet = summarizeMetrics([{ "@type": "Gauge", metric: "server.memory", count: 1, timestamp: "2026-09-15T14:00:00Z" }]);
    expect(quiet).toMatchObject({ recorded: true, received: 0, sent: 0 });
  });
});

describe("the dashboard's queries", () => {
  it("counts users rather than accounts, and asks for no ids", async () => {
    const call = vi.spyOn(client, "call").mockResolvedValue({ ids: [], total: 5 });
    expect(await countObjects("Account")).toBe(5);
    expect(call).toHaveBeenCalledWith("x:Account/query", { filter: { "@type": "User" }, limit: 0, calculateTotal: true });
    await countObjects("QueuedMessage");
    expect(call).toHaveBeenLastCalledWith("x:QueuedMessage/query", { limit: 0, calculateTotal: true });
    call.mockRestore();
  });

  it("filters the history with Stalwart's comparison names, and pages the gets", async () => {
    // A bare `timestamp` or `after` is unsupportedFilter on a live server.
    vi.spyOn(client, "maxObjectsInGet", "get").mockReturnValue(2);
    const call = vi.spyOn(client, "call").mockImplementation(async (method, args) => {
      if (method === "x:Metric/query") return (args as { position: number }).position === 0 ? { ids: ["a", "b"] } : { ids: ["c"] };
      return { list: ((args as { ids: string[] }).ids).map((id) => counter("queue.message-queued", 1, id)) };
    });
    const records = await loadMetrics(new Date("2026-09-14T15:30:00.123Z"));
    expect(records).toHaveLength(3);
    expect(call.mock.calls[0]).toEqual([
      "x:Metric/query",
      {
        filter: { timestampIsGreaterThanOrEqual: "2026-09-14T15:30:00Z", metric: ["queue.message-queued", "queue.authenticated-message-queued", "queue.dsn-queued", "queue.report-queued", "server.memory"] },
        sort: [{ property: "timestamp", isAscending: false }],
        position: 0,
        limit: 2,
      },
    ]);
    vi.restoreAllMocks();
  });

  it("treats only a forbidden answer as the server refusing", () => {
    expect(isRefused(new JmapMethodError("x:Metric/query", { type: "forbidden" }))).toBe(true);
    expect(isRefused(new JmapMethodError("x:Metric/query", { type: "serverFail" }))).toBe(false);
    expect(isRefused(new Error("offline"))).toBe(false);
  });
});

describe("the card grid", () => {
  it("never leaves a row short when the cards can be divided evenly", () => {
    for (const n of [1, 2, 3, 4, 6]) {
      const { wide, mid } = balancedColumns(n);
      expect(n % wide, `${n} cards across ${wide}`).toBe(0);
      expect(n % mid, `${n} cards across ${mid}`).toBe(0);
      expect(wide).toBeLessThanOrEqual(4);
    }
    expect(balancedColumns(6)).toEqual({ wide: 3, mid: 2 });
    expect(balancedColumns(3)).toEqual({ wide: 3, mid: 1 });
  });
});
