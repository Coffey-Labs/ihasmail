import { describe, expect, it } from "vitest";
import { labelTree, visibleLabels, descendantKeywords } from "@/lib/labelTree";
import type { Label } from "@/store/settings";

const L = (keyword: string, over: Partial<Label> = {}): Label => ({ keyword, name: keyword, color: "#000", ...over });

const flat = (labels: Label[], counts: Record<string, number> = {}) =>
  visibleLabels(labelTree(labels, counts)).map((n) => `${"  ".repeat(n.depth)}${n.label.keyword}`);

describe("labelTree", () => {
  it("nests a label under its parent and indents it", () => {
    const roots = labelTree([L("work"), L("work_urgent", { parent: "work" })]);
    expect(roots).toHaveLength(1);
    expect(roots[0]!.label.keyword).toBe("work");
    expect(roots[0]!.children[0]!.label.keyword).toBe("work_urgent");
    expect(roots[0]!.children[0]!.depth).toBe(1);
  });

  it("nests three deep", () => {
    expect(flat([L("a"), L("b", { parent: "a" }), L("c", { parent: "b" })])).toEqual(["a", "  b", "    c"]);
  });

  it("puts a label back at the top when its parent no longer exists", () => {
    // Settings sync between devices; a parent can be deleted on one while
    // another still points at it. Dropping the child would lose it for good.
    expect(flat([L("orphan", { parent: "gone" })])).toEqual(["orphan"]);
  });

  it("survives a cycle rather than hanging", () => {
    const out = flat([L("a", { parent: "b" }), L("b", { parent: "a" })]);
    expect(out).toHaveLength(2);
    expect(out.map((s) => s.trim()).sort()).toEqual(["a", "b"]);
  });

  it("survives a label parented to itself", () => {
    expect(flat([L("a", { parent: "a" })])).toEqual(["a"]);
  });

  it("carries each label's own unread count, not its children's", () => {
    const roots = labelTree([L("a"), L("b", { parent: "a" })], { a: 2, b: 5 });
    expect(roots[0]!.unread).toBe(2);
    expect(roots[0]!.children[0]!.unread).toBe(5);
  });
});

describe("visibleLabels", () => {
  it("draws everything set to always", () => {
    expect(flat([L("a"), L("b")])).toEqual(["a", "b"]);
  });

  it("never draws a hidden label", () => {
    expect(flat([L("a"), L("b", { visibility: "hidden" })], { b: 9 })).toEqual(["a"]);
  });

  it("draws an unread-only label just while it has unread mail", () => {
    const labels = [L("a", { visibility: "unread" })];
    expect(flat(labels, { a: 0 })).toEqual([]);
    expect(flat(labels, { a: 1 })).toEqual(["a"]);
  });

  it("keeps a parent that would otherwise be dropped, when a child survives", () => {
    // A child cannot be drawn under a parent that is not there, and promoting
    // it would silently rearrange the tree. The parent comes back as a
    // container instead.
    const labels = [L("work", { visibility: "unread" }), L("work_urgent", { parent: "work" })];
    expect(flat(labels, { work: 0 })).toEqual(["work", "  work_urgent"]);
  });

  it("keeps a hidden parent too, when a child survives", () => {
    const labels = [L("work", { visibility: "hidden" }), L("work_urgent", { parent: "work" })];
    expect(flat(labels, {})).toEqual(["work", "  work_urgent"]);
  });

  it("drops a whole branch when nothing in it survives", () => {
    const labels = [
      L("work", { visibility: "unread" }),
      L("work_urgent", { parent: "work", visibility: "unread" }),
      L("other"),
    ];
    expect(flat(labels, { work: 0, work_urgent: 0 })).toEqual(["other"]);
  });

  it("keeps a grandparent when only a grandchild survives", () => {
    const labels = [
      L("a", { visibility: "hidden" }),
      L("b", { parent: "a", visibility: "hidden" }),
      L("c", { parent: "b" }),
    ];
    expect(flat(labels, {})).toEqual(["a", "  b", "    c"]);
  });

  it("treats a label with no visibility set as always, so old settings parse unchanged", () => {
    const l = L("a");
    expect(l.visibility).toBeUndefined();
    expect(flat([l], {})).toEqual(["a"]);
  });
});

describe("descendantKeywords", () => {
  it("names everything below a label, so the parent picker cannot offer a cycle", () => {
    const roots = labelTree([L("a"), L("b", { parent: "a" }), L("c", { parent: "b" }), L("d")]);
    expect([...descendantKeywords(roots, "a")].sort()).toEqual(["b", "c"]);
    expect([...descendantKeywords(roots, "d")]).toEqual([]);
  });

  it("says nothing about a label that is not there", () => {
    expect([...descendantKeywords(labelTree([L("a")]), "missing")]).toEqual([]);
  });
});
