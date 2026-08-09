import { execFile } from "node:child_process";
import type {
  HostDaemonOnlineRpcCommand,
  HostDaemonOnlineRpcResult,
} from "@bb/host-daemon-contract";
import { PLUGIN_COMMAND_OUTPUT_MAX_BYTES } from "@bb/host-daemon-contract";


type PluginRunCommand = Extract<
  HostDaemonOnlineRpcCommand,
  { type: "plugin.run_command" }
>;

export function runPluginCommand(
  command: PluginRunCommand,
  env: NodeJS.ProcessEnv,
): Promise<HostDaemonOnlineRpcResult<"plugin.run_command">> {
  return new Promise((resolve) => {
    execFile(
      command.executable,
      command.args,
      {
        ...(command.cwd === null ? {} : { cwd: command.cwd }),
        env,
        maxBuffer: PLUGIN_COMMAND_OUTPUT_MAX_BYTES,
        timeout: command.timeoutMs,
      },
      (error, stdout, stderr) => {
        let exitCode = 0;
        if (error !== null) {
          if (error.killed) exitCode = 124;
          else if (typeof error.code === "number") exitCode = error.code;
          else if (error.code === "ENOENT") exitCode = 127;
          else exitCode = 1;
        }
        resolve({ exitCode, stdout, stderr });
      },
    );
  });
}
