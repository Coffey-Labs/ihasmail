/**
 * Labels arranged into a tree, and which of them the sidebar draws.
 *
 * **Nesting is display only.** The keywords stay flat on the message, which is
 * what keeps them readable by every other client — moving a label under
 * another rewrites nothing in the mailbox, and a client that knows nothing
 * about ihasmail still sees the same keywords it always did.
 */
import type { Label, LabelVisibility } from "@/store/settings";

export interface LabelNode {
  label: Label;
  /** 0 at the top; only ever used to indent. */
  depth: number;
  children: LabelNode[];
  /** Unread messages carrying this keyword. Its own, not its children's. */
  unread: number;
}

const visibilityOf = (l: Label): LabelVisibility => l.visibility ?? "always";

/**
 * Build the tree.
 *
 * Two malformed shapes have to survive, because settings sync between devices
 * and a label can be deleted on one while another is still pointing at it:
 *
 *  - **A parent that no longer exists** puts its child back at the top level
 *    rather than dropping it. A label that vanishes from the sidebar because
 *    something else was deleted is a label the reader cannot get back.
 *  - **A cycle** — a under b, b under a — is broken by treating the first
 *    label that closes the loop as a root. Nothing is lost and nothing hangs.
 */
export function labelTree(labels: Label[], counts: Record<string, number> = {}): LabelNode[] {
  const byKeyword = new Map<string, Label>();
  for (const l of labels) byKeyword.set(l.keyword, l);

  /** Whether following `parent` from here reaches a real root without looping. */
  const rooted = (l: Label): boolean => {
    const seen = new Set<string>([l.keyword]);
    let cur = l.parent ? byKeyword.get(l.parent) : undefined;
    while (cur) {
      if (seen.has(cur.keyword)) return false;
      seen.add(cur.keyword);
      cur = cur.parent ? byKeyword.get(cur.parent) : undefined;
    }
    return true;
  };

  const nodes = new Map<string, LabelNode>();
  for (const l of labels) nodes.set(l.keyword, { label: l, depth: 0, children: [], unread: counts[l.keyword] ?? 0 });

  const roots: LabelNode[] = [];
  for (const l of labels) {
    const node = nodes.get(l.keyword)!;
    const parent = l.parent && l.parent !== l.keyword && rooted(l) ? nodes.get(l.parent) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  const setDepth = (n: LabelNode, depth: number) => {
    n.depth = depth;
    for (const c of n.children) setDepth(c, depth + 1);
  };
  for (const r of roots) setDepth(r, 0);
  return roots;
}

/**
 * The nodes the sidebar draws, flattened in the order they appear.
 *
 * `hidden` removes a label outright. `unread` shows it only while it has
 * unread mail — which is the point of it: a label you filed something under
 * two years ago should not take up a row for ever.
 *
 * **A label kept by the rule keeps its ancestors, whatever they said.** A
 * child cannot be drawn under a parent that is not there; the alternative is
 * promoting it to the top level, which silently rearranges the tree at the
 * moment the reader is least able to explain why. The parent comes back as a
 * container, and its own count still says whether it has anything of its own.
 */
export function visibleLabels(roots: LabelNode[]): LabelNode[] {
  const keep = new Set<LabelNode>();

  const walk = (n: LabelNode): boolean => {
    // Depth-first: a node's fate depends on its descendants, not the reverse.
    let keptChild = false;
    for (const c of n.children) keptChild = walk(c) || keptChild;

    const v = visibilityOf(n.label);
    const self = v === "always" || (v === "unread" && n.unread > 0);
    if (self || keptChild) {
      keep.add(n);
      return true;
    }
    return false;
  };
  for (const r of roots) walk(r);

  const out: LabelNode[] = [];
  const emit = (n: LabelNode) => {
    if (!keep.has(n)) return;
    out.push(n);
    for (const c of n.children) emit(c);
  };
  for (const r of roots) emit(r);
  return out;
}

/**
 * Keywords that would become unreachable if `keyword` were re-parented under
 * `candidate` — used to keep the parent picker from offering a cycle.
 */
export function descendantKeywords(roots: LabelNode[], keyword: string): Set<string> {
  const out = new Set<string>();
  const find = (n: LabelNode): LabelNode | null => {
    if (n.label.keyword === keyword) return n;
    for (const c of n.children) {
      const hit = find(c);
      if (hit) return hit;
    }
    return null;
  };
  let node: LabelNode | null = null;
  for (const r of roots) {
    node = find(r);
    if (node) break;
  }
  if (!node) return out;
  const collect = (n: LabelNode) => {
    for (const c of n.children) {
      out.add(c.label.keyword);
      collect(c);
    }
  };
  collect(node);
  return out;
}
