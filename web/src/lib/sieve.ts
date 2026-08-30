/**
 * Visual filter rules <-> Sieve script codec.
 *
 * Rules are persisted inside the Sieve script itself as JSON comments
 * (`# rule:{...}`) so the UI can round-trip them losslessly; the generated
 * Sieve below each comment is what the server actually runs.
 */

export type HeaderOp = "contains" | "notcontains" | "is" | "notis" | "matches" | "notmatches" | "regex" | "notregex" | "exists" | "notexists";

export type SieveTest =
  | { type: "header"; header: string; op: HeaderOp; value: string }
  | { type: "address"; header: string; part: "all" | "localpart" | "domain"; op: HeaderOp; value: string }
  | { type: "size"; op: "over" | "under"; value: number }
  | { type: "body"; op: "contains" | "notcontains"; value: string }
  | { type: "true" };

export type SieveAction =
  | { type: "fileinto"; mailbox: string; mailboxId?: string; copy?: boolean }
  | { type: "redirect"; address: string; copy?: boolean }
  | { type: "discard" }
  | { type: "keep" }
  | { type: "reject"; reason: string }
  | { type: "addflag"; flag: string }
  | { type: "setflag"; flag: string }
  | { type: "removeflag"; flag: string }
  | { type: "markread" }
  | { type: "flag" }
  | { type: "stop" };

export interface SieveRule {
  id: string;
  name: string;
  enabled: boolean;
  join: "allof" | "anyof";
  tests: SieveTest[];
  actions: SieveAction[];
}

export const HEADER_CHOICES = [
  { value: "from", label: "From" },
  { value: "to", label: "To" },
  { value: "cc", label: "Cc" },
  { value: "subject", label: "Subject" },
  { value: "list-id", label: "List-Id" },
  { value: "reply-to", label: "Reply-To" },
  { value: "x-spam-status", label: "X-Spam-Status" },
  { value: "__custom__", label: "Other header…" },
];

export const HEADER_OPS: Array<{ value: HeaderOp; label: string }> = [
  { value: "contains", label: "contains" },
  { value: "notcontains", label: "does not contain" },
  { value: "is", label: "is" },
  { value: "notis", label: "is not" },
  { value: "matches", label: "matches (wildcards * ?)" },
  { value: "notmatches", label: "does not match" },
  { value: "regex", label: "matches regex" },
  { value: "notregex", label: "does not match regex" },
  { value: "exists", label: "exists" },
  { value: "notexists", label: "does not exist" },
];

export function sieveString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, " ")}"`;
}

function opToSieve(op: HeaderOp): { neg: boolean; match: string } {
  const neg = op.startsWith("not");
  const base = neg ? op.slice(3) : op;
  return { neg, match: base === "regex" ? ":regex" : base === "matches" ? ":matches" : base === "is" ? ":is" : base === "exists" ? "exists" : ":contains" };
}

export function testToSieve(t: SieveTest): string {
  switch (t.type) {
    case "true":
      return "true";
    case "header": {
      const { neg, match } = opToSieve(t.op);
      const inner = match === "exists" ? `exists ${sieveString(t.header)}` : `header ${match} ${sieveString(t.header)} ${sieveString(t.value)}`;
      return neg ? `not ${inner}` : inner;
    }
    case "address": {
      const { neg, match } = opToSieve(t.op);
      const part = t.part === "all" ? ":all" : t.part === "localpart" ? ":localpart" : ":domain";
      const inner = match === "exists" ? `exists ${sieveString(t.header)}` : `address ${part} ${match} ${sieveString(t.header)} ${sieveString(t.value)}`;
      return neg ? `not ${inner}` : inner;
    }
    case "size":
      return `size :${t.op} ${Math.max(0, Math.round(t.value))}`;
    case "body": {
      const inner = `body :text :contains ${sieveString(t.value)}`;
      return t.op === "notcontains" ? `not ${inner}` : inner;
    }
  }
}

export function actionToSieve(a: SieveAction): string[] {
  switch (a.type) {
    case "fileinto":
      return [`fileinto${a.copy ? " :copy" : ""} ${sieveString(a.mailbox)};`];
    case "redirect":
      return [`redirect${a.copy ? " :copy" : ""} ${sieveString(a.address)};`];
    case "discard":
      return ["discard;"];
    case "keep":
      return ["keep;"];
    case "reject":
      return [`reject ${sieveString(a.reason || "Message rejected")};`];
    case "addflag":
      return [`addflag ${sieveString(a.flag)};`];
    case "setflag":
      return [`setflag ${sieveString(a.flag)};`];
    case "removeflag":
      return [`removeflag ${sieveString(a.flag)};`];
    case "markread":
      return ['addflag "\\\\Seen";'];
    case "flag":
      return ['addflag "\\\\Flagged";'];
    case "stop":
      return ["stop;"];
  }
}

export function requiredExtensions(rules: SieveRule[]): string[] {
  const req = new Set<string>();
  for (const r of rules) {
    for (const t of r.tests) {
      if (t.type === "body") req.add("body");
      if ((t.type === "header" || t.type === "address") && (t.op === "regex" || t.op === "notregex")) req.add("regex");
      if (t.type === "address") req.add("envelope");
    }
    for (const a of r.actions) {
      if (a.type === "fileinto") {
        req.add("fileinto");
        if (a.copy) req.add("copy");
      }
      if (a.type === "redirect" && a.copy) req.add("copy");
      if (a.type === "reject") req.add("reject");
      if (["addflag", "setflag", "removeflag", "markread", "flag"].includes(a.type)) req.add("imap4flags");
    }
  }
  req.delete("envelope");
  return [...req].sort();
}

export const SCRIPT_HEADER = "# ihasmail filters v1 - edit with care; rules are stored in the `# rule:` comments";

export function rulesToSieve(rules: SieveRule[]): string {
  const ext = requiredExtensions(rules);
  const lines: string[] = [SCRIPT_HEADER];
  if (ext.length) lines.push(`require [${ext.map(sieveString).join(", ")}];`);
  lines.push("");
  for (const r of rules) {
    lines.push(`# rule:${JSON.stringify(r)}`);
    if (!r.enabled) {
      lines.push(`# (disabled) ${r.name}`);
      lines.push("");
      continue;
    }
    const tests = r.tests.filter((t) => t.type !== "true");
    let cond: string;
    if (!tests.length) cond = "true";
    else if (tests.length === 1) cond = testToSieve(tests[0]!);
    else cond = `${r.join} (${tests.map(testToSieve).join(", ")})`;
    const body = r.actions.flatMap(actionToSieve).map((l) => `    ${l}`);
    if (!body.length) body.push("    keep;");
    lines.push(`if ${cond}`);
    lines.push("{");
    lines.push(...body);
    lines.push("}");
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * Why this script must not be rewritten from the rules parsed out of it, or
 * null when rewriting it is safe.
 *
 * Saving replaces the whole script with a fresh serialization of the rules read
 * out of it, so whatever was not read is deleted. `sieveToRules` cannot raise
 * the alarm by itself: it skips what it does not recognise, so a script cut off
 * partway through parses cleanly into a shorter list and looks exactly like one
 * that genuinely has fewer rules. That is the shape of the loss in #76 -- a
 * truncated download, a plausible parse, and a save that wrote the short
 * version back over the real one. The transport fault behind it is fixed in the
 * blob proxy; this is the check that makes the save path refuse regardless of
 * how the content came to be short.
 *
 * The tests are structural rather than an equality check against
 * `rulesToSieve(sieveToRules(content))`. A script written by an older version
 * whose serializer differed in some detail is intact, and refusing to let
 * anyone edit their rules over a changed byte would be the worse bug.
 */
export function scriptDamage(content: string): string | null {
  // Not one of ours: genuinely empty, or hand-written. Both mean something
  // else and are answered elsewhere.
  if (!content.includes("# rule:") && !content.includes(SCRIPT_HEADER)) {
    // Unless it is one of ours cut off inside its own first line, which reads
    // as a very short hand-written script -- and that reading is the one that
    // offers to replace it.
    const head = content.replace(/\n+$/, "");
    if (head !== "" && SCRIPT_HEADER.startsWith(head)) return "breaks off inside its first line";
    return null;
  }
  // Every generated script ends with a newline, so a body that stops mid-line
  // stopped early. The rest of the walk covers the cuts that land on one.
  if (!content.endsWith("\n")) return "stops in the middle of a line";

  const lines = content.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  let hadRequire = false;
  if (lines[0] === SCRIPT_HEADER) {
    i = 1;
    hadRequire = lines[i]?.startsWith("require ") ?? false;
    if (hadRequire) i++;
    if (lines[i] !== "") return "breaks off in its opening lines";
    i++;
  } else {
    // Header edited away but the rule comments kept. Still ours to walk.
    i = lines.findIndex((l) => l.startsWith("# rule:"));
  }

  // Walk the shape rulesToSieve emits, one rule block at a time. Deliberately
  // structural: the condition and action lines are read only for their
  // presence, so a serializer that words them differently is still intact.
  let seen = 0;
  const cut = (r: SieveRule, what: string) => `has a rule in it (“${r.name}”) ${what}`;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.startsWith("# rule:")) return "has a stray line where a rule should start";
    let rule: SieveRule | null = null;
    try {
      const parsed = JSON.parse(line.slice(7)) as SieveRule;
      if (parsed && typeof parsed === "object" && Array.isArray(parsed.tests) && Array.isArray(parsed.actions)) rule = parsed;
    } catch {
      /* reported below */
    }
    if (!rule) return "has a rule in it that breaks off unfinished";
    seen++;
    i++;
    // `!r.enabled` is how rulesToSieve chooses the branch, so match it exactly
    // rather than testing for `=== false`.
    if (rule.enabled) {
      if (!lines[i]?.startsWith("if ")) return cut(rule, "with nothing below it");
      i++;
      if (lines[i] !== "{") return cut(rule, "whose body never opens");
      i++;
      while (i < lines.length && lines[i] !== "}") {
        if (lines[i] === "") return cut(rule, "whose body breaks off");
        i++;
      }
      if (i >= lines.length) return cut(rule, "whose body never closes");
      i++;
    } else {
      if (!lines[i]?.startsWith("# (disabled) ")) return cut(rule, "with nothing below it");
      i++;
    }
    // Each block is followed by a blank line, the last one included: it is the
    // empty final element left by the trailing newline.
    if (lines[i] !== "") return cut(rule, "that runs into what follows it");
    i++;
  }
  // A require line is written only for rules that need it, so one standing over
  // no rules at all means the rules it was written for are gone.
  if (hadRequire && seen === 0) return "breaks off before the first rule";
  return null;
}

/** Returns rules if the script was generated by ihasmail, else null (raw script). */
export function sieveToRules(script: string): SieveRule[] | null {
  if (!script.includes("# rule:")) return script.trim() === "" || script.includes(SCRIPT_HEADER) ? [] : null;
  const out: SieveRule[] = [];
  for (const line of script.split(/\r?\n/)) {
    if (!line.startsWith("# rule:")) continue;
    try {
      const r = JSON.parse(line.slice(7)) as SieveRule;
      if (r && typeof r === "object" && Array.isArray(r.tests) && Array.isArray(r.actions)) out.push(r);
    } catch {
      /* skip */
    }
  }
  return out;
}

export function newRule(partial: Partial<SieveRule> = {}): SieveRule {
  return {
    id: `r${Math.random().toString(36).slice(2, 9)}`,
    name: "New filter",
    enabled: true,
    join: "allof",
    tests: [{ type: "header", header: "from", op: "contains", value: "" }],
    actions: [{ type: "fileinto", mailbox: "INBOX" }],
    ...partial,
  };
}

/**
 * Replaces a rule with the same id in place, or appends it when it is new.
 * Order is evaluation order in Sieve, so an edited rule has to keep its seat.
 */
export function upsertRule(rules: SieveRule[], rule: SieveRule): SieveRule[] {
  return rules.some((x) => x.id === rule.id) ? rules.map((x) => (x.id === rule.id ? rule : x)) : [...rules, rule];
}

/**
 * Moves the rule `fromId` to sit either side of `toId`. `below` says which,
 * decided by which half of the target card the pointer was over.
 */
export function reorderRules(rules: SieveRule[], fromId: string, toId: string, below: boolean): SieveRule[] {
  if (fromId === toId) return rules;
  const moved = rules.find((r) => r.id === fromId);
  const rest = rules.filter((r) => r.id !== fromId);
  const target = rest.findIndex((r) => r.id === toId);
  if (!moved || target < 0) return rules;
  const at = below ? target + 1 : target;
  return [...rest.slice(0, at), moved, ...rest.slice(at)];
}

export function describeRule(r: SieveRule): string {
  const tests = r.tests
    .map((t) => {
      switch (t.type) {
        case "header":
          return `${t.header} ${HEADER_OPS.find((o) => o.value === t.op)?.label ?? t.op} "${t.value}"`;
        case "address":
          return `${t.header} address ${HEADER_OPS.find((o) => o.value === t.op)?.label ?? t.op} "${t.value}"`;
        case "size":
          return `size ${t.op} ${Math.round(t.value / 1024)} KB`;
        case "body":
          return `body ${t.op === "contains" ? "contains" : "does not contain"} "${t.value}"`;
        case "true":
          return "always";
      }
    })
    .join(r.join === "allof" ? " and " : " or ");
  const actions = r.actions
    .map((a) => {
      switch (a.type) {
        case "fileinto":
          return `move to ${a.mailbox}`;
        case "redirect":
          return `forward to ${a.address}`;
        case "discard":
          return "delete";
        case "keep":
          return "keep";
        case "reject":
          return "reject";
        case "markread":
          return "mark read";
        case "flag":
          return "star";
        case "addflag":
        case "setflag":
          return `add ${a.flag}`;
        case "removeflag":
          return `remove ${a.flag}`;
        case "stop":
          return "stop";
      }
    })
    .join(", ");
  return `${tests || "always"} → ${actions}`;
}
