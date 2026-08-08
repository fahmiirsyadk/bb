import { describe, expect, it } from "vitest";
import { resolveHostPlatform } from "./host-platform.js";

describe("resolveHostPlatform", () => {
  it("reports native Windows separately from WSL", () => {
    expect(resolveHostPlatform("win32", {})).toBe("windows");
    expect(resolveHostPlatform("linux", { WSL_DISTRO_NAME: "Ubuntu" })).toBe(
      "wsl",
    );
  });
});
