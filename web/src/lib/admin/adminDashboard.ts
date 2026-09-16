import { client, JmapMethodError } from "@/jmap/client";

/**
 * The numbers on Administration's dashboard, over the ordinary JMAP proxy.
 *
 * Counts are queries with `calculateTotal` and `limit: 0`: Stalwart lifts its
 * own limit when asked for a total, so the number is the whole count, and no
 * ids come back to be thrown away. For a tenant administrator the server scopes
 * all three to the tenancy -- accounts and domains to its members, the queue to
 * messages touching its domains.
 *
 * The rest is read from `x:Metric`, the history Stalwart records once per
 * collection interval (hourly by default): a Counter holds what happened in
 * that interval, a Gauge the reading at its end. Received and sent are the sums
 * Stalwart's own dashboard shows, over the same metric names. The history is
 * Enterprise-only and has to be switched on (`x:MetricsStore`); a Community
 * server refuses the query as `forbidden`, and one that records nothing
 * answers with nothing -- the two cases the dashboard tells apart.
 */

export const RECEIVED_METRICS = ["queue.message-queued"] as const;
export const SENT_METRICS = ["queue.authenticated-message-queued", "queue.dsn-queued", "queue.report-queued"] as const;
export const MEMORY_METRIC = "server.memory";

/** The window received and sent cover. */
export const DASHBOARD_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface MetricRecord {
  "@type": "Counter" | "Gauge" | "Histogram";
  metric: string;
  count: number;
  timestamp: string;
  sum?: number;
}

export interface MessageStats {
  received: number;
  sent: number;
  /** The latest memory reading, or null when none was recorded in the window. */
  memory: { bytes: number; at: string } | null;
  /**
   * Whether the server recorded anything in the window. Memory is written every
   * interval, so a window with no records at all is a history that is switched
   * off -- not a quiet day, which would still say zero.
   */
  recorded: boolean;
}

export function summarizeMetrics(records: readonly MetricRecord[]): MessageStats {
  let received = 0;
  let sent = 0;
  let memory: MessageStats["memory"] = null;
  const receivedNames = new Set<string>(RECEIVED_METRICS);
  const sentNames = new Set<string>(SENT_METRICS);
  for (const r of records) {
    if (r["@type"] === "Counter") {
      if (receivedNames.has(r.metric)) received += r.count;
      else if (sentNames.has(r.metric)) sent += r.count;
    } else if (r["@type"] === "Gauge" && r.metric === MEMORY_METRIC) {
      if (!memory || r.timestamp > memory.at) memory = { bytes: r.count, at: r.timestamp };
    }
  }
  return { received, sent, memory, recorded: records.length > 0 };
}

type CountedObject = "Account" | "Domain" | "QueuedMessage";

/** How many there are. Accounts are counted as users: groups are accounts too. */
export async function countObjects(object: CountedObject): Promise<number> {
  const res = await client.call<{ total?: number; ids?: string[] }>(`x:${object}/query`, {
    ...(object === "Account" ? { filter: { "@type": "User" } } : {}),
    limit: 0,
    calculateTotal: true,
  });
  return res.total ?? res.ids?.length ?? 0;
}

/**
 * Every record of the dashboard's metrics since `since`, newest first.
 *
 * The filter keys are Stalwart's comparison names for the property -- a bare
 * `timestamp` is `unsupportedFilter`. A day at the default hourly interval is
 * well under one page; the paging is for a server that collects far more often.
 */
export async function loadMetrics(since: Date): Promise<MetricRecord[]> {
  const filter = {
    timestampIsGreaterThanOrEqual: since.toISOString().replace(/\.\d{3}Z$/, "Z"),
    metric: [...RECEIVED_METRICS, ...SENT_METRICS, MEMORY_METRIC],
  };
  const step = client.maxObjectsInGet;
  const out: MetricRecord[] = [];
  for (let position = 0; ; position += step) {
    const q = await client.call<{ ids?: string[] }>("x:Metric/query", { filter, sort: [{ property: "timestamp", isAscending: false }], position, limit: step });
    const ids = q.ids ?? [];
    if (ids.length) out.push(...(await client.call<{ list: MetricRecord[] }>("x:Metric/get", { ids })).list);
    if (ids.length < step) return out;
  }
}

/**
 * How many columns the cards take, so no row is left short.
 *
 * `wide` is the most that divides the cards evenly without going past four;
 * `mid` is what they drop to when that no longer fits, again only a count the
 * cards divide into -- three cards go to one column rather than two and one.
 * Five is the one count nothing divides, and takes three over two. A phone
 * always gets one column, which the stylesheet decides.
 */
export function balancedColumns(cards: number): { wide: number; mid: number } {
  switch (cards) {
    case 0:
    case 1:
      return { wide: 1, mid: 1 };
    case 2:
      return { wide: 2, mid: 2 };
    case 3:
      return { wide: 3, mid: 1 };
    case 4:
      return { wide: 4, mid: 2 };
    default:
      return { wide: 3, mid: 2 };
  }
}

/** A refusal from the server itself, as opposed to a failure to reach it. */
export function isRefused(err: unknown): boolean {
  return err instanceof JmapMethodError && err.error.type === "forbidden";
}
