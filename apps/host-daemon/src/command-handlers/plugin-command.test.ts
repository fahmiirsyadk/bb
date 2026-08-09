import { describe, expect, it } from "vitest";
import { buildPluginCommandEnv, runPluginCommand } from "./plugin-command.js";

describe("runPluginCommand", () => {
  it("preserves user profile variables while runtime-owned values win", () => {
    expect(
      buildPluginCommandEnv(
        { PATH: "runtime-path", BB_SERVER_URL: "https://bb.example" },
        {
          APPDATA: "C:\\Users\\test\\AppData\\Roaming",
          LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local",
          USERPROFILE: "C:\\Users\\test",
          GH_CONFIG_DIR: "C:\\Users\\test\\gh",
          PATH: "inherited-path",
          BB_SERVER_URL: "https://stale.example",
          NODE_ENV: "development",
        },
      ),
    ).toEqual({
      APPDATA: "C:\\Users\\test\\AppData\\Roaming",
      LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local",
      USERPROFILE: "C:\\Users\\test",
      GH_CONFIG_DIR: "C:\\Users\\test\\gh",
      PATH: "runtime-path",
      BB_SERVER_URL: "https://bb.example",
    });
  });

  it("uses argv execution and the host environment without a shell", async () => {
    const result = await runPluginCommand(
      {
        type: "plugin.run_command",
        pluginId: "github",
        executable: "node",
        args: [
          "-e",
          "process.stdout.write(`${process.env.BB_PLUGIN_TEST}:${process.argv[1]}`)",
          "literal;not-a-shell-command",
        ],
        cwd: null,
        timeoutMs: 5_000,
      },
      { ...process.env, BB_PLUGIN_TEST: "host-value" },
    );

    expect(result).toEqual({
      exitCode: 0,
      stdout: "host-value:literal;not-a-shell-command",
      stderr: "",
    });
  });

  it("returns bounded process failures as command results", async () => {
    const result = await runPluginCommand(
      {
        type: "plugin.run_command",
        pluginId: "github",
        executable: "node",
        args: ["-e", "process.stderr.write('nope'); process.exit(7)"],
        cwd: null,
        timeoutMs: 5_000,
      },
      process.env,
    );

    expect(result).toEqual({ exitCode: 7, stdout: "", stderr: "nope" });
  });
});
