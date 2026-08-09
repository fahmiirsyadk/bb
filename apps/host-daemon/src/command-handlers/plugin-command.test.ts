import { describe, expect, it } from "vitest";
import { runPluginCommand } from "./plugin-command.js";

describe("runPluginCommand", () => {
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
