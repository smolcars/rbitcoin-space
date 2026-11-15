import { describe, expect, it } from "vitest";
import { ApiError } from "../../lib/api";
import { answerOf, IMPLEMENTATIONS, names, offered, verdict } from "./lookup";

const [BARK, ARKADE] = offered(["arkade", "bark"]);
const BOTH = IMPLEMENTATIONS;

describe("lookup", () => {
  it("offers what the network has, in the page's order, and nothing it does not know", () => {
    expect(offered(["arkade", "bark", "other"]).map((i) => i.id)).toStrictEqual(["bark", "arkade"]);
    expect(offered(undefined)).toStrictEqual([]);
  });

  it("reads each route's answer", () => {
    expect(answerOf(true, undefined)).toBe("found");
    expect(answerOf(false, new ApiError(404, "vtxo not found"))).toBe("unknown");
    expect(answerOf(false, new ApiError(502, "bark server answer did not verify"))).toBe("found");
    expect(answerOf(false, new ApiError(502, "bark server unavailable"))).toBe("down");
    expect(answerOf(false, new ApiError(429, "too many requests"))).toBe("down");
    expect(answerOf(false, new TypeError("network"))).toBe("down");
  });

  it("one that knows it is the page", () => {
    expect(verdict(BOTH, ["unknown", "found"])).toStrictEqual({ kind: "one", impl: ARKADE });
    expect(verdict(BOTH, ["found", "down"])).toStrictEqual({ kind: "one", impl: BARK });
    expect(
      verdict(
        [BARK].filter((i) => i !== undefined),
        ["found"],
      ).kind,
    ).toBe("one");
  });

  it("two that know it are a choice, none a refusal naming who could not be asked", () => {
    expect(verdict(BOTH, ["found", "found"])).toStrictEqual({ kind: "many", impls: [...BOTH] });
    expect(verdict(BOTH, ["unknown", "unknown"])).toStrictEqual({ kind: "none", down: [] });
    expect(verdict(BOTH, ["down", "unknown"])).toStrictEqual({ kind: "none", down: [BARK] });
  });

  it("names a list as a reader would", () => {
    expect(names(BOTH, "or")).toBe("Bark or Arkade");
    expect(names(BOTH, "and")).toBe("Bark and Arkade");
    expect(names(BOTH.slice(1), "or")).toBe("Arkade");
  });
});
