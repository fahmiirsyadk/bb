import { describe, expect, it } from "vitest";
import { resolveDesktopPlatform } from "../src/types.js";

describe("desktop runtime platform boundary", () => {
  it("maps Node platform names to the desktop contract values", () => {
    expect(resolveDesktopPlatform("darwin")).toBe("macos");
    expect(resolveDesktopPlatform("linux")).toBe("linux");
  });

  it("rejects platforms without a desktop contract", () => {
    expect(() => resolveDesktopPlatform("win32")).toThrow(
      "Expected darwin or linux",
    );
  });
});
