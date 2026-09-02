import { useCallback, useEffect, useRef } from "react";
import type { PointerEvent as ReactPointerEvent, MouseEvent as ReactMouseEvent } from "react";

/**
 * The gestures a phone expects, and the arithmetic behind them.
 *
 * ihasmail's mail list was built for a mouse: a row is clicked, right-clicked
 * and dragged into a folder. None of those exist on a phone, which instead has
 * three conventions so settled that their absence reads as the app being
 * broken -- swipe a row to act on it, hold a row to select it, and pull the
 * top of a list to refresh it.
 *
 * The numbers and the decisions live here rather than in the components so
 * they can be tested without a touchscreen, and so the three gestures agree
 * with each other: the same slop that says "this finger is holding still"
 * decides whether a long press survives, and the same axis lock keeps a swipe
 * from stealing a scroll.
 *
 * Everything here is touch-only by design. A mouse keeps drag-to-folder, which
 * shares the same pointer stream and would otherwise be fighting a swipe for
 * every drag.
 */

/** A press held this long, with the finger still, is a long press. */
export const LONG_PRESS_MS = 450;

/**
 * How far a finger may drift and still count as holding still.
 *
 * A thumb resting on glass wanders a few pixels on its own, so zero would mean
 * a long press almost never fires; much more than this and a slow deliberate
 * drag starts opening a selection instead of moving the row.
 */
export const PRESS_SLOP = 10;

/** How far a drag travels before it commits to being horizontal or vertical. */
export const AXIS_SLOP = 12;

export type Axis = "x" | "y" | null;

/**
 * Which way a drag has committed, once it has moved far enough to tell.
 *
 * Deliberately biased towards the vertical. Scrolling is what a finger on a
 * message list is doing almost every time, and a scroll misread as a swipe
 * grabs the list out from under the reader, while a swipe misread as a scroll
 * costs them a second attempt. So `x` has to win clearly -- a drag that is
 * merely more sideways than not stays a scroll.
 */
export function lockAxis(dx: number, dy: number): Axis {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (Math.max(ax, ay) < AXIS_SLOP) return null;
  return ax > ay * 1.3 ? "x" : "y";
}

/**
 * How far past the row's edge a swipe must reach before letting go fires it.
 *
 * A share of the row rather than a fixed distance, so the gesture feels the
 * same on a phone and on a tablet, but bounded at both ends: on a narrow
 * screen a percentage is a flick nobody meant, and on a wide one it is a
 * reach across the whole device.
 */
export function swipeThreshold(width: number): number {
  return Math.max(56, Math.min(96, width * 0.28));
}

/**
 * How far the row actually moves for a finger that has travelled `dx`.
 *
 * One-to-one until the action would fire, and increasingly reluctant after
 * that. The resistance is the only thing that tells a thumb, without the
 * reader looking down at the exact moment, that it has gone far enough.
 *
 * Stopped dead at the row's own width, because there is nothing past it: the
 * row is already fully off screen, and a curve with no ceiling would go on
 * accumulating travel that has nowhere to show. That only bites on a flick
 * that outruns the screen, which is exactly when the row is moving too fast
 * for anyone to see it stop.
 */
export function swipeOffset(dx: number, width: number): number {
  const limit = swipeThreshold(width);
  const over = Math.abs(dx) - limit;
  if (over <= 0) return dx;
  return Math.sign(dx) * Math.min(width, limit + over * 0.35);
}

/** Pull-to-refresh: how far the list comes down before letting go refreshes. */
export const PULL_TRIGGER = 64;
/** Where the list rests while the refresh it asked for is running. */
export const PULL_REST = 48;
/** As far as the list will ever come down, however hard it is pulled. */
export const PULL_MAX = 110;

/**
 * How far the list follows a finger that has pulled down `dy`.
 *
 * Under half, so the trigger sits at about 116px of travel: far enough that
 * the overscroll at the top of a list -- which happens constantly, to nobody's
 * intent -- does not keep firing refreshes.
 */
export function pullDistance(dy: number): number {
  if (dy <= 0) return 0;
  return Math.min(PULL_MAX, dy * 0.55);
}

/**
 * A short tap of the vibration motor, where there is one.
 *
 * Confirmation that a gesture landed, for the hand rather than the eye: a
 * swipe fires at the moment the finger crosses a threshold it cannot see, and
 * without this the only feedback arrives after the row has already gone.
 *
 * iOS supports none of this and never has, so this is silently nothing there
 * rather than something to apologise for. Wrapped because a vibration inside
 * a cross-origin iframe throws rather than returning false.
 */
export function haptic(pattern: number | number[] = 8): void {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* A device that will not buzz is not a failure worth reporting. */
  }
}

export interface RowGesture {
  /** Whether to listen at all — false on a mouse, and while a menu is open. */
  enabled: boolean;
  /**
   * The finger held still long enough, on `target` — handed over rather than
   * left to the caller's own ref, because the element a press lands on is not
   * always one a ref can reach. A router's `Link` renders the anchor itself
   * and forwards nothing.
   */
  onLongPress?: (target: Element) => void;
  /** Whether a swipe that way leads anywhere; a `false` here never starts one. */
  canSwipe?: (dir: -1 | 1) => boolean;
  /** The row should now sit `dx` from home. Fired continuously while dragging. */
  onSwipeMove?: (dx: number, dir: -1 | 1, armed: boolean) => void;
  /** Let go: `dir` is the direction to act on, or 0 to snap back untouched. */
  onSwipeEnd?: (dir: -1 | 1 | 0) => void;
}

/**
 * Long press and horizontal swipe over one pointer stream.
 *
 * One hook rather than two because they are the same gesture until they are
 * not: a press that moves is no longer a press, and a swipe that does not move
 * is a press. Splitting them meant both hooks watching the same events and
 * disagreeing at the boundary.
 *
 * The element needs `touch-action: pan-y`, which is what makes this possible
 * without breaking the list: the browser keeps handling vertical scrolling
 * itself, at its own frame rate, and hands us the horizontal movement it now
 * knows it is not going to use.
 */
export function useTouchRow({ enabled, onLongPress, canSwipe, onSwipeMove, onSwipeEnd }: RowGesture) {
  const start = useRef<{ x: number; y: number; width: number; id: number; target: Element } | null>(null);
  const axis = useRef<Axis>(null);
  const dir = useRef<-1 | 1>(1);
  const armed = useRef(false);
  const timer = useRef<number | null>(null);
  /*
   * A gesture that did anything must not also be a tap. The row's click
   * handler opens the conversation, and a swipe or a long press both end with
   * the finger lifting off the row -- which is a click as far as the browser is
   * concerned, arriving after every pointer event we could cancel from.
   */
  const swallowClick = useRef(false);
  const fromTouch = useRef(false);

  const clearTimer = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => clearTimer, []);

  const reset = useCallback(() => {
    clearTimer();
    start.current = null;
    axis.current = null;
    armed.current = false;
  }, []);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent) => {
      fromTouch.current = e.pointerType === "touch";
      if (!enabled || e.pointerType !== "touch") return;
      // Read out now: `currentTarget` is only meaningful during dispatch, and
      // the long-press timer runs long after this handler has returned.
      const target = e.currentTarget;
      start.current = { x: e.clientX, y: e.clientY, width: target.getBoundingClientRect().width, id: e.pointerId, target };
      axis.current = null;
      armed.current = false;
      swallowClick.current = false;
      if (onLongPress) {
        timer.current = window.setTimeout(() => {
          timer.current = null;
          // Still here, still not moving: nothing has cancelled us.
          if (!start.current || axis.current) return;
          swallowClick.current = true;
          onLongPress(start.current.target);
        }, LONG_PRESS_MS);
      }
    },
    [enabled, onLongPress],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent) => {
      const s = start.current;
      if (!s || e.pointerId !== s.id) return;
      const dx = e.clientX - s.x;
      const dy = e.clientY - s.y;

      if (axis.current === null) {
        if (Math.abs(dx) > PRESS_SLOP || Math.abs(dy) > PRESS_SLOP) clearTimer();
        const locked = lockAxis(dx, dy);
        if (!locked) return;
        /*
         * A vertical drag is the browser's, and it has already started
         * scrolling with it. Letting go of the whole gesture here -- rather
         * than remembering that we lost -- matters, because the finger will go
         * on to travel a long way sideways during a diagonal flick, and this
         * row would otherwise catch up with it mid-scroll.
         */
        if (locked === "y" || !onSwipeMove) {
          reset();
          return;
        }
        const d: -1 | 1 = dx < 0 ? -1 : 1;
        if (canSwipe && !canSwipe(d)) {
          reset();
          return;
        }
        axis.current = "x";
        dir.current = d;
        swallowClick.current = true;
        try {
          // Throws if the pointer is already gone -- a flick fast enough to
          // have lifted between this event being queued and being handled.
          // The gesture works perfectly well without the capture.
          e.currentTarget.setPointerCapture(s.id);
        } catch {
          /* nothing left to capture */
        }
      }

      const d: -1 | 1 = dx < 0 ? -1 : 1;
      /*
       * Crossing back the other way mid-gesture. The direction is re-read
       * rather than held from the lock, so a reader who overshoots, thinks
       * better of it and drags back past centre gets the other action offered
       * instead of the row refusing to move.
       */
      if (d !== dir.current) {
        if (canSwipe && !canSwipe(d)) {
          onSwipeMove?.(0, dir.current, false);
          return;
        }
        dir.current = d;
      }
      const offset = swipeOffset(dx, s.width);
      const nowArmed = Math.abs(dx) >= swipeThreshold(s.width);
      if (nowArmed !== armed.current) {
        armed.current = nowArmed;
        if (nowArmed) haptic();
      }
      onSwipeMove?.(offset, d, nowArmed);
    },
    [canSwipe, onSwipeMove, reset],
  );

  const onPointerUp = useCallback(
    (e: ReactPointerEvent) => {
      const s = start.current;
      clearTimer();
      if (!s || e.pointerId !== s.id) return;
      if (axis.current === "x") onSwipeEnd?.(armed.current ? dir.current : 0);
      reset();
    },
    [onSwipeEnd, reset],
  );

  const onPointerCancel = useCallback(
    (e: ReactPointerEvent) => {
      if (start.current && e.pointerId !== start.current.id) return;
      if (axis.current === "x") onSwipeEnd?.(0);
      reset();
    },
    [onSwipeEnd, reset],
  );

  const onClickCapture = useCallback((e: ReactMouseEvent) => {
    if (!swallowClick.current) return;
    swallowClick.current = false;
    e.preventDefault();
    e.stopPropagation();
  }, []);

  /*
   * Android fires `contextmenu` for a long press of its own, a little after
   * ours, and would open the desktop right-click menu on top of whatever the
   * long press just did. The desktop handler stays untouched for an actual
   * right-click, which is the only thing that reaches it now.
   */
  const onContextMenuCapture = useCallback(
    (e: ReactMouseEvent) => {
      if (!enabled || !fromTouch.current) return;
      e.preventDefault();
      e.stopPropagation();
    },
    [enabled],
  );

  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onClickCapture, onContextMenuCapture };
}

/**
 * Pull the top of a scroller down to refresh it.
 *
 * Native listeners rather than React props because the move handler has to be
 * able to call `preventDefault`, and React attaches its own passively. Bound
 * to the scroll container itself so that everything inside it -- a virtualised
 * list included -- comes down with the pull without knowing about it.
 */
export function usePullToRefresh(
  el: HTMLElement | null,
  onRefresh: () => Promise<void> | void,
  { enabled, onPull }: { enabled: boolean; onPull: (distance: number, armed: boolean, live: boolean) => void },
) {
  const refresh = useRef(onRefresh);
  refresh.current = onRefresh;
  const pull = useRef(onPull);
  pull.current = onPull;

  useEffect(() => {
    if (!el || !enabled) return;
    let startY: number | null = null;
    let distance = 0;
    let armed = false;
    let running = false;

    const onStart = (e: TouchEvent) => {
      // Only from a list already at the top, and only one finger: a pinch that
      // happens to begin near the top is not a pull.
      if (running || e.touches.length !== 1 || el.scrollTop > 0) return;
      startY = e.touches[0]!.clientY;
      distance = 0;
      armed = false;
    };

    const onMove = (e: TouchEvent) => {
      if (startY === null || e.touches.length !== 1) return;
      const dy = e.touches[0]!.clientY - startY;
      if (dy <= 0) {
        // Pulled back up, or the gesture was a scroll all along.
        if (distance > 0) pull.current((distance = 0), (armed = false), true);
        if (el.scrollTop > 0) startY = null;
        return;
      }
      distance = pullDistance(dy);
      const nowArmed = distance >= PULL_TRIGGER;
      if (nowArmed !== armed) {
        armed = nowArmed;
        if (nowArmed) haptic();
      }
      /*
       * Only once the list is visibly following the finger. Calling this on
       * the first pixel would cancel the tap that starts every scroll, and
       * `cancelable` is false once the browser has already committed the
       * gesture to scrolling -- calling it then is a console warning and
       * nothing else.
       */
      if (distance > 2 && e.cancelable) e.preventDefault();
      pull.current(distance, armed, true);
    };

    const onEnd = () => {
      if (startY === null) return;
      startY = null;
      if (!armed) {
        if (distance > 0) pull.current((distance = 0), false, false);
        return;
      }
      running = true;
      armed = false;
      pull.current(PULL_REST, true, false);
      void Promise.resolve(refresh.current()).finally(() => {
        running = false;
        distance = 0;
        pull.current(0, false, false);
      });
    };

    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd);
    el.addEventListener("touchcancel", onEnd);
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
    };
  }, [el, enabled]);
}

/** How far in from the left edge a drag must start to count as going back. */
export const EDGE_ZONE = 28;

/**
 * Drag in from the left edge to go back, the way every phone does it.
 *
 * Only from the edge. A back gesture that started anywhere would fight the
 * horizontal scrolling that wide HTML mail needs, and mail is exactly the
 * content nobody controls the width of.
 */
export function useEdgeBack(el: HTMLElement | null, onBack: () => void, enabled: boolean) {
  const back = useRef(onBack);
  back.current = onBack;

  useEffect(() => {
    if (!el || !enabled) return;
    let startX: number | null = null;
    let startY = 0;
    let live = false;

    const settle = (offset: number, animate: boolean) => {
      el.style.transition = animate ? "transform .18s var(--ease, ease)" : "";
      el.style.transform = offset ? `translateX(${offset}px)` : "";
    };

    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      const t = e.touches[0]!;
      if (t.clientX - el.getBoundingClientRect().left > EDGE_ZONE) return;
      startX = t.clientX;
      startY = t.clientY;
      live = false;
    };

    const onMove = (e: TouchEvent) => {
      if (startX === null || e.touches.length !== 1) return;
      const t = e.touches[0]!;
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;
      if (!live) {
        if (lockAxis(dx, dy) === "y") {
          startX = null;
          return;
        }
        if (lockAxis(dx, dy) !== "x" || dx < 0) return;
        live = true;
      }
      if (e.cancelable) e.preventDefault();
      settle(Math.max(0, dx * 0.9), false);
    };

    const onEnd = () => {
      if (startX === null) return;
      const offset = parseFloat(el.style.transform.replace(/[^\d.-]/g, "")) || 0;
      startX = null;
      if (!live) return;
      live = false;
      // A third of the way across is enough: a back gesture is a flick, and
      // asking for half the screen makes it feel like the app is resisting.
      if (offset > el.clientWidth / 3) {
        haptic();
        settle(0, false);
        back.current();
      } else {
        settle(0, true);
        window.setTimeout(() => (el.style.transition = ""), 200);
      }
    };

    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd);
    el.addEventListener("touchcancel", onEnd);
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
      el.style.transform = "";
      el.style.transition = "";
    };
  }, [el, enabled]);
}

/**
 * How far a horizontal drag must travel before it moves the calendar to
 * another day or month.
 *
 * Further than a row swipe, and not because the consequence is bigger --
 * stepping a calendar is undone by stepping back, while a swiped row has
 * already been archived. It is because this gesture has no way to change its
 * mind. A row slides open as it goes, so the strip underneath names what is
 * about to happen and letting go early calls it off, and a toast offers Undo
 * afterwards. Stepping the calendar shows nothing on the way and offers
 * nothing after, so the distance is the only chance to not mean it.
 */
export function navSwipeThreshold(width: number): number {
  return Math.max(80, Math.min(180, width * 0.3));
}

/**
 * Which way a finished drag sends the view: -1 back, +1 forward, 0 nowhere.
 *
 * Dragging left pulls the next period in from the right, which is how paper,
 * phones and every other calendar behave. (It would need mirroring for a
 * right-to-left interface; there is not one yet, and the day there is, this is
 * one of the places that has to know.)
 */
export function swipeNavDirection(dx: number, width: number): -1 | 0 | 1 {
  const threshold = navSwipeThreshold(width);
  if (dx <= -threshold) return 1;
  if (dx >= threshold) return -1;
  return 0;
}

/**
 * Swipe sideways across a calendar to step it a period at a time.
 *
 * Three things it deliberately does not do:
 *
 *  - **No visual drag.** The row swipe slides the row open because the strip
 *    underneath has to name which of six actions is about to happen. Stepping
 *    a calendar has two outcomes and the direction of the finger already says
 *    which, so there is nothing to reveal -- and translating the grid would
 *    break the sticky day header, since a transform makes a containing block.
 *    The threshold is reported by the vibration motor instead, which is what
 *    the haptics are for: a swipe fires as the finger passes a line it cannot
 *    see.
 *  - **It does not start on an event.** A drag beginning on an event chip is
 *    left alone, so that moving an event by dragging it stays available to be
 *    built without having to be untangled from this first. Which gesture is
 *    meant is decidable at the moment the finger lands, and that is the only
 *    moment it can be decided cleanly.
 *  - **It does not start on the toolbar.** Buttons live there.
 *
 * The axis lock is the shared one, so it keeps the same bias towards the
 * vertical: the day grid scrolls through the hours, and a scroll misread as a
 * swipe throws the reader into another day.
 */
export function useSwipeNav(
  el: HTMLElement | null,
  opts: { onStep: (n: -1 | 1) => void; enabled: boolean; ignore?: string },
) {
  const step = useRef(opts.onStep);
  step.current = opts.onStep;
  const { enabled, ignore } = opts;

  useEffect(() => {
    if (!el || !enabled) return;
    let startX: number | null = null;
    let startY = 0;
    let axis: Axis = null;
    let fired = false;

    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      const t = e.touches[0]!;
      if (ignore && (t.target as Element | null)?.closest?.(ignore)) return;
      startX = t.clientX;
      startY = t.clientY;
      axis = null;
      fired = false;
    };

    const onMove = (e: TouchEvent) => {
      if (startX === null || e.touches.length !== 1) return;
      const t = e.touches[0]!;
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;
      if (!axis) {
        axis = lockAxis(dx, dy);
        // Committed to scrolling: stay out of the way for the rest of the drag.
        if (axis === "y") startX = null;
        return;
      }
      if (axis !== "x") return;
      // Once sideways, the browser must not also scroll.
      if (e.cancelable) e.preventDefault();
      if (!fired && swipeNavDirection(dx, el.clientWidth || window.innerWidth) !== 0) {
        fired = true;
        haptic();
      }
    };

    const onEnd = (e: TouchEvent) => {
      if (startX === null) return;
      const t = e.changedTouches[0];
      const dx = t ? t.clientX - startX : 0;
      const wasX = axis === "x";
      startX = null;
      axis = null;
      fired = false;
      if (!wasX) return;
      const dir = swipeNavDirection(dx, el.clientWidth || window.innerWidth);
      if (dir !== 0) step.current(dir);
    };

    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd);
    el.addEventListener("touchcancel", onEnd);
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
    };
  }, [el, enabled, ignore]);
}
