import { describe, expect, it } from "vitest";
import { intend } from "./intent";

describe("intend", () => {
  it("leaves only the latest choice current", () => {
    const date = intend();
    expect(date()).toBe(true);
    const search = intend();
    expect(date()).toBe(false);
    expect(search()).toBe(true);
  });
});
