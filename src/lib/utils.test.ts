import { describe, expect, it } from "vitest";

import { clamp, cn, toIsoDate } from "./utils";

describe("cn", () => {
  it("joins truthy class names with a space", () => {
    expect(cn("a", "b", "c")).toBe("a b c");
  });

  it("drops falsy values", () => {
    expect(cn("a", false, null, undefined, "b")).toBe("a b");
  });

  it("returns an empty string when nothing is truthy", () => {
    expect(cn(false, null, undefined)).toBe("");
  });
});

describe("toIsoDate", () => {
  it("formats a Date as YYYY-MM-DD in UTC", () => {
    expect(toIsoDate(new Date("2026-07-15T23:59:59.000Z"))).toBe("2026-07-15");
  });
});

describe("clamp", () => {
  it("returns the value when inside the range", () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });

  it("clamps to the minimum", () => {
    expect(clamp(-5, 0, 10)).toBe(0);
  });

  it("clamps to the maximum", () => {
    expect(clamp(50, 0, 10)).toBe(10);
  });
});
