import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * A boundary that survives Chrome translating the page.
 *
 * Chrome's translator rewrites the rendered DOM directly, wrapping text nodes
 * in `<font>` elements React has never heard of. React holds references to the
 * nodes it created, so the next update calls `removeChild` or `insertBefore`
 * against a parent whose children have moved, the DOM throws, and the whole
 * component tree unmounts. It is a longstanding React/Chromium problem
 * (facebook/react#11538), not a fault in anything here, and it cannot be
 * fixed from inside React.
 *
 * `translate="no"` and the structural wrapping elsewhere in this change make
 * it rarer. Neither makes it impossible: those are hints to the automatic
 * prompt, and a reader can always force a translation from the extension
 * regardless of what the page asked for. So the last line is to catch it and
 * put the subtree back.
 *
 * Recovery is a remount rather than a crash screen, because there is nothing
 * to lose: this wraps the main content area only, so the header, the sidebar
 * and any open composer are outside it and keep their state. What is inside
 * re-derives from the stores, which is where it came from a moment ago.
 *
 * Deliberately narrow. A boundary is a class component because React offers no
 * hook for this, and that is the whole of the cost -- no dependency, no
 * context, no stored state.
 */

/** The DOM errors Chrome's rewriting produces, as opposed to real bugs. */
export function isDomMutationError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // NotFoundError is what removeChild/insertBefore throw when the node they
  // were given is not where React last saw it. The name is checked first
  // because it is the reliable half -- the message is browser-specific and
  // localised, so matching on it alone would work in English Chrome and
  // nowhere else, which for a translation bug would be a poor joke.
  if (err.name === "NotFoundError" || err.name === "HierarchyRequestError") return true;
  return /removeChild|insertBefore|replaceChild|not a child of this node/i.test(err.message);
}

interface Props {
  children: ReactNode;
  /** Told about each recovery, for whoever is counting. */
  onRecover?: (info: { attempt: number; error: Error }) => void;
}

interface State {
  /** Bumping this remounts the subtree, which is the whole recovery. */
  generation: number;
  failed: Error | null;
}

/**
 * How many times a subtree is put back before it is left broken.
 *
 * Not unlimited: if something genuinely wrong is throwing a DOM error on every
 * render, remounting for ever is an invisible infinite loop that pins a core.
 * Three is enough for a reader toggling a translation on and off, and far too
 * few to hide a real bug.
 */
const MAX_RECOVERIES = 3;

export class TranslateBoundary extends Component<Props, State> {
  state: State = { generation: 0, failed: null };
  private recoveries = 0;

  static getDerivedStateFromError(error: Error): Partial<State> | null {
    // Anything that is not the translator's doing is left to propagate, so a
    // real bug still surfaces as a real bug rather than as a subtree that
    // silently reappears empty.
    if (!isDomMutationError(error)) throw error;
    return { failed: error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    if (!isDomMutationError(error)) throw error;
    this.recoveries += 1;
    if (this.recoveries > MAX_RECOVERIES) {
      console.error("[ihasmail] giving up re-rendering after repeated DOM errors", error, info.componentStack);
      return;
    }
    /*
     * console.info, not console.error. A reader translating the page is not a
     * fault, and logging it as one would put an entry in every error reporter
     * that reads the console, for behaviour that is expected and recovered
     * from. The marker is here to be counted, not alarmed at.
     */
    console.info(
      `[ihasmail] recovered from a DOM error, most likely page translation (recovery ${this.recoveries} of ${MAX_RECOVERIES}): ${error.message}`,
    );
    this.props.onRecover?.({ attempt: this.recoveries, error });
    this.setState((s) => ({ generation: s.generation + 1, failed: null }));
  }

  render(): ReactNode {
    if (this.state.failed) return null;   // one frame, while the remount lands
    return <div key={this.state.generation} className="translate-boundary">{this.props.children}</div>;
  }
}
