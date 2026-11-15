import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { push, type PushState } from "../push";

/** Just enough of EventSource to drive PushManager by hand. */
class FakeEventSource {
  static last: FakeEventSource | null = null;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private handlers = new Map<string, ((ev: MessageEvent) => void)[]>();
  closed = false;
  constructor(public url: string) { FakeEventSource.last = this; }
  addEventListener(type: string, fn: (ev: MessageEvent) => void) {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), fn]);
  }
  close() { this.closed = true; }
  emit(type: string, data: string) {
    for (const fn of this.handlers.get(type) ?? []) fn(new MessageEvent(type, { data }));
  }
}

describe("push connection state (issue #71)", () => {
  let states: PushState[];
  let off: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", FakeEventSource);
    states = [];
    off = push.onConnection((s) => states.push(s));
    push.start();
  });

  afterEach(() => {
    off();
    push.stop();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("an opened stream is not connected until an event arrives", () => {
    const es = FakeEventSource.last!;
    es.onopen?.();
    expect(push.state).toBe("connecting");
    es.emit("ping", '{"interval": 30}');
    expect(push.state).toBe("connected");
  });

  it("a state change counts as proof of life too", () => {
    const es = FakeEventSource.last!;
    es.emit("state", JSON.stringify({ "@type": "StateChange", changed: {} }));
    expect(push.state).toBe("connected");
  });

  it("a stream that opens and ends at once keeps backing off", () => {
    const delays: number[] = [];
    for (let i = 0; i < 4; i++) {
      const es = FakeEventSource.last!;
      es.onopen?.();
      es.onerror?.();
      const before = Date.now();
      vi.advanceTimersToNextTimer();
      delays.push(Date.now() - before);
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000]);
    expect(states).not.toContain("connected");
  });
});
