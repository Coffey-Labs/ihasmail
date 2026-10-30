import { afterEach, describe, expect, it, vi } from "vitest";
import { CAP, client } from "@/jmap/client";
import { argsToServer, resultFromServer, shapeFromProbe } from "@/jmap/fileNodeShape";
import type { JmapSession } from "@/jmap/types";

/**
 * Stalwart 1.0 renamed FileNode's `nodeType` and `type` and refuses the old
 * names, so nothing the client wrote for 0.16 could make a folder or a file
 * there and the settings file was never written (Gitea issue #66). The shapes
 * below are what real 0.16.27 and 1.0.0 servers sent on 2026-10-30; the
 * server compatibility test sends the same calls to both.
 */

describe("the probe", () => {
  it("reads 1.0's refusal of a sort by `type`", () => {
    expect(shapeFromProbe(["error", { type: "unsupportedSort", description: "type" }, "shape"])).toBe("1.0");
  });

  it("reads 0.16's answer", () => {
    expect(shapeFromProbe(["FileNode/query", { ids: [] }, "shape"])).toBe("0.16");
  });

  it("decides nothing on any other answer", () => {
    expect(shapeFromProbe(["error", { type: "forbidden" }, "shape"])).toBeNull();
    expect(shapeFromProbe(["error", { type: "accountNotFound" }, "shape"])).toBeNull();
    expect(shapeFromProbe(undefined)).toBeNull();
  });
});

describe("calls to a 1.0 server", () => {
  it("creates a folder and a file in 1.0's names", () => {
    const args = argsToServer("1.0", "FileNode/set", {
      accountId: "a",
      create: {
        d: { parentId: null, name: "ihasmail", nodeType: "directory" },
        f: { parentId: "#d", name: "settings.json", blobId: "B", type: "application/json", nodeType: "file" },
      },
    });
    expect(args.create).toEqual({
      d: { parentId: null, name: "ihasmail", "@type": "Directory" },
      f: { parentId: "#d", name: "settings.json", blobId: "B", mediaType: "application/json", "@type": "File" },
    });
  });

  it("renames `type` in an update", () => {
    const args = argsToServer("1.0", "FileNode/set", { accountId: "a", update: { n1: { blobId: "B", type: "application/json", size: 7 } } });
    expect(args.update).toEqual({ n1: { blobId: "B", mediaType: "application/json", size: 7 } });
  });

  it("asks for the renamed properties", () => {
    const args = argsToServer("1.0", "FileNode/get", { accountId: "a", ids: ["n1"], properties: ["id", "nodeType", "type", "name"] });
    expect(args.properties).toEqual(["id", "@type", "mediaType", "name"]);
  });

  it("drops a filter by kind, which 1.0 answers with nothing", () => {
    expect(argsToServer("1.0", "FileNode/query", { accountId: "a", filter: { nodeType: "directory" } }).filter).toEqual({});
    expect(argsToServer("1.0", "FileNode/query", { accountId: "a", filter: { operator: "AND", conditions: [{ nodeType: "file" }, { parentId: "p" }] } }).filter)
      .toEqual({ operator: "AND", conditions: [{}, { parentId: "p" }] });
  });

  it("sorts by `mediaType` where it was `type`", () => {
    const args = argsToServer("1.0", "FileNode/query", { accountId: "a", sort: [{ property: "type", isAscending: true }, { property: "name" }] });
    expect(args.sort).toEqual([{ property: "mediaType", isAscending: true }, { property: "name" }]);
  });

  it("leaves other methods alone", () => {
    const args = { accountId: "a", properties: ["type"] };
    expect(argsToServer("1.0", "Email/get", args)).toBe(args);
  });
});

describe("answers from a 1.0 server", () => {
  it("reads nodes back in the client's names", () => {
    const res = resultFromServer("1.0", "FileNode/get", {
      list: [
        { id: "b", parentId: null, "@type": "Directory", name: "ihasmail" },
        { id: "c", parentId: "b", "@type": "File", name: "settings.json", mediaType: "application/json", blobId: "B" },
      ],
    });
    expect(res.list).toEqual([
      { id: "b", parentId: null, nodeType: "directory", name: "ihasmail" },
      { id: "c", parentId: "b", nodeType: "file", name: "settings.json", type: "application/json", blobId: "B" },
    ]);
  });

  it("reads what a set created and updated", () => {
    const res = resultFromServer("1.0", "FileNode/set", { created: { f: { id: "c", mediaType: "application/octet-stream" } }, updated: { c: null } });
    expect(res.created).toEqual({ f: { id: "c", type: "application/octet-stream" } });
    expect(res.updated).toEqual({ c: null });
  });
});

describe("0.16", () => {
  it("is the client's own shape, passed through as is", () => {
    const args = { accountId: "a", create: { d: { nodeType: "directory" } }, filter: { nodeType: "directory" } };
    expect(argsToServer("0.16", "FileNode/set", args)).toBe(args);
    const res = { list: [{ nodeType: "file", type: "text/plain" }] };
    expect(resultFromServer("0.16", "FileNode/get", res)).toBe(res);
  });
});

describe("the client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    client.session = null;
  });

  it("asks once per session, then sends and reads in 1.0's names", async () => {
    client.session = {
      capabilities: { [CAP.core]: {}, [CAP.filenode]: {} },
      accounts: {},
      primaryAccounts: { [CAP.filenode]: "own" },
      state: "s1",
    } as unknown as JmapSession;
    const sent: [string, Record<string, unknown>, string][][] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const calls = (JSON.parse(init.body as string) as { methodCalls: [string, Record<string, unknown>, string][] }).methodCalls;
      sent.push(calls);
      const methodResponses = calls.map(([m, a, id]) =>
        id === "shape"
          ? ["error", { type: "unsupportedSort" }, id]
          : [m, { list: [{ id: "b", "@type": "Directory", name: (a.properties as string[]).join(",") }] }, id],
      );
      return { ok: true, status: 200, json: async () => ({ methodResponses }) } as Response;
    }));

    const one = await client.request([["FileNode/get", { accountId: "shared", ids: ["b"], properties: ["id", "nodeType"] }, "g"]], [CAP.core, CAP.filenode]);
    await client.request([["FileNode/get", { accountId: "a", ids: ["b"], properties: ["id"] }, "g"]], [CAP.core, CAP.filenode]);

    expect(sent.map((calls) => calls.map(([m]) => m))).toEqual([["FileNode/query"], ["FileNode/get"], ["FileNode/get"]]);
    // Of the reader's own account, not the shared one asked about.
    expect(sent[0]![0]![1].accountId).toBe("own");
    expect(sent[1]![0]![1].properties).toEqual(["id", "@type"]);
    expect(one.methodResponses[0]![1].list).toEqual([{ id: "b", nodeType: "directory", name: "id,@type" }]);
  });
});
