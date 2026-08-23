import { describe, expect, it } from "vitest";
import { setErrorMessage } from "@/jmap/client";

describe("setErrorMessage", () => {
  it("names the offending properties, which is usually the whole answer", () => {
    expect(setErrorMessage({ type: "invalidProperties", description: "Invalid property or value.", properties: ["sentAt"] }))
      .toBe("Invalid property or value. (sentAt)");
    expect(setErrorMessage({ type: "invalidProperties", properties: ["to", "cc"] }))
      .toBe("invalidProperties (to, cc)");
  });

  it("falls back cleanly when the server says less", () => {
    expect(setErrorMessage({ type: "forbidden" })).toBe("forbidden");
    expect(setErrorMessage({ type: "forbidden", description: "Not allowed" })).toBe("Not allowed");
    expect(setErrorMessage({ type: "x", properties: [] })).toBe("x");
    expect(setErrorMessage(null)).toBe("Unknown error");
  });
});
