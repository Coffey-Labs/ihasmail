import type { ServerResponse } from "node:http";
import { ACCOUNT, state } from "./config.js";

/*
 * The server-sent-events fan-out and the Email/changes ring buffer.
 *
 * Separate from index.ts because the JMAP handlers raise these events and
 * index.ts imports the handlers -- leaving them in index.ts makes that a
 * cycle. Separate from data.ts because a live HTTP response is not fixture
 * data.
 */
export const sseClients = new Set<ServerResponse>();
/** What changed and when, so `Email/changes` can answer honestly. */
export const emailChanges: Array<{ state: number; created: string[]; updated: string[]; destroyed: string[] }> = [];
export function recordEmailChange(change: { created?: string[]; updated?: string[]; destroyed?: string[] }) {
  emailChanges.push({ state: state.n, created: change.created ?? [], updated: change.updated ?? [], destroyed: change.destroyed ?? [] });
  // A window is plenty; the client refetches from scratch if it falls behind.
  if (emailChanges.length > 200) emailChanges.splice(0, emailChanges.length - 200);
}

/** The same for contact cards, so `ContactCard/changes` can answer too. */
export const cardChanges: Array<{ state: number; created: string[]; updated: string[]; destroyed: string[] }> = [];
/** Changes at or below this state have been dropped from the log, so a client that far behind cannot be answered. */
export const cardLog = { floor: 0 };
export function recordCardChange(change: { created?: string[]; updated?: string[]; destroyed?: string[] }) {
  cardChanges.push({ state: state.n, created: change.created ?? [], updated: change.updated ?? [], destroyed: change.destroyed ?? [] });
  if (cardChanges.length > 200) {
    const dropped = cardChanges.splice(0, cardChanges.length - 200);
    cardLog.floor = dropped[dropped.length - 1]!.state;
  }
}

export function broadcast(types: string[]) {
  const payload = `event: state\ndata: ${JSON.stringify({ "@type": "StateChange", changed: { [ACCOUNT]: Object.fromEntries(types.map((t) => [t, String(state.n)])) } })}\n\n`;
  for (const c of sseClients) c.write(payload);
}
