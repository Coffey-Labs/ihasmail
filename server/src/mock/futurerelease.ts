/**
 * FUTURERELEASE (RFC 4865) as Stalwart applies it to a JMAP envelope.
 *
 * A client asks for a delayed send by putting `HOLDUNTIL` (a date-time) or
 * `HOLDFOR` (seconds) in the `mailFrom` parameters; Stalwart hands those to its
 * RFC 5321 parameter parser and derives `sendAt` from the result. `sendAt` is
 * never something the client sets. Kept apart from the mock server itself so
 * the rules can be tested without binding a port.
 */

export type Obj = Record<string, unknown>;

/** Neither parameter given. */
export const NO_HOLD = null;
/** The parameters are contradictory or unparseable; the create must fail. */
export const BAD_HOLD = NaN;

function lookup(params: Obj, name: string): string | undefined {
  const key = Object.keys(params).find((k) => k.toUpperCase() === name);
  return key === undefined ? undefined : String(params[key]);
}

/**
 * The instant an envelope asks to be released: null for "send it now", NaN for
 * parameters the server would refuse.
 */
export function holdUntilOf(envelope: Obj | undefined, now: number): number | null {
  const params = ((envelope?.mailFrom as Obj | undefined)?.parameters ?? {}) as Obj;
  const until = lookup(params, "HOLDUNTIL");
  const forSecs = lookup(params, "HOLDFOR");
  // "501 5.5.4 Only one of HOLDFOR or HOLDUNTIL may be specified."
  if (until !== undefined && forSecs !== undefined) return BAD_HOLD;
  if (until !== undefined) {
    const t = Date.parse(until);
    return Number.isNaN(t) ? BAD_HOLD : t;
  }
  if (forSecs !== undefined) {
    const secs = Number(forSecs);
    return Number.isFinite(secs) && secs > 0 ? now + secs * 1000 : BAD_HOLD;
  }
  return NO_HOLD;
}

/**
 * Pending while the message is still in the queue, which is what Stalwart
 * reports: `undoStatus` is read off the spool, not stored on the submission.
 */
export function undoStatusOf(sub: Obj, now: number): "pending" | "final" | "canceled" {
  if (sub.undoStatus === "canceled") return "canceled";
  return Date.parse(String(sub.sendAt)) > now ? "pending" : "final";
}
