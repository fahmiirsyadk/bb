import { access, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createDesktopReleaseConfig,
  resolveDesktopReleaseChannel,
} from "./desktop-release-channel.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(scriptDirectory, "..");
const releaseDir = join(packageRoot, "release");
const releaseConfig = createDesktopReleaseConfig(
  resolveDesktopReleaseChannel(process.env),
);

function createElectronAppEnv(env) {
  const childEnv = {
    ...env,
    BB_DESKTOP_OPEN_DEVTOOLS: env.BB_DESKTOP_OPEN_DEVTOOLS ?? "1",
  };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  return childEnv;
}

async function resolvePackagedAppLaunch() {
  if (process.platform === "linux") {
    const linuxOutputDirectory = join(releaseDir, "linux-unpacked");
    const linuxExecutableCandidates = [
      releaseConfig.linuxExecutableName,
      releaseConfig.applicationName,
      releaseConfig.linuxPackageName,
    ];

    for (const executableName of linuxExecutableCandidates) {
      const executablePath = join(linuxOutputDirectory, executableName);
      try {
        await access(executablePath);
        return { args: [], command: executablePath };
      } catch {
        continue;
      }
    }

    const entries = await readdir(releaseDir, { withFileTypes: true }).catch(
      () => [],
    );
    const appImage = entries
      .filter(
        (entry) =>
          entry.isFile() && entry.name.toLowerCase().endsWith(".appimage"),
      )
      .map((entry) => join(releaseDir, entry.name))
      .sort()[0];
    if (appImage !== undefined) {
      return { args: [], command: appImage };
    }

    throw new Error(
      `No packaged Linux desktop executable found. Expected ${linuxOutputDirectory}/${releaseConfig.linuxExecutableName} or a Linux AppImage under ${releaseDir}. Package the app first with --linux --x64.`,
    );
  }

  if (process.platform === "darwin") {
    const appBundleName = `${releaseConfig.applicationName}.app`;
    const appBinaryRelativePath = join(
      appBundleName,
      "Contents",
      "MacOS",
      releaseConfig.applicationName,
    );
    const entries = await readdir(releaseDir, { withFileTypes: true }).catch(
      () => [],
    );

    for (const entry of entries
      .filter(
        (candidate) =>
          candidate.isDirectory() && candidate.name.startsWith("mac"),
      )
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const appBinary = join(releaseDir, entry.name, appBinaryRelativePath);
      try {
        await access(appBinary);
        return { args: [], command: appBinary };
      } catch {
        continue;
      }
    }

    throw new Error(
      `No packaged macOS ${appBundleName} found under ${releaseDir}. Package the app first with the macOS desktop build.`,
    );
  }

  throw new Error(
    `Packaged desktop launch is supported on macOS and Linux, not ${process.platform}.`,
  );
}

try {
  const launch = await resolvePackagedAppLaunch();
  const child = spawn(launch.command, launch.args, {
    env: createElectronAppEnv(process.env),
    stdio: "inherit",
  });

  process.once("SIGINT", () => {
    child.kill("SIGINT");
  });
  process.once("SIGTERM", () => {
    child.kill("SIGTERM");
  });

  const exitCode = await new Promise((resolveExitCode) => {
    child.once("error", (error) => {
      console.error(`Could not launch packaged desktop app: ${error.message}`);
      resolveExitCode(1);
    });
    child.once("exit", (code, signal) => {
      if (typeof code === "number") {
        resolveExitCode(code);
        return;
      }
      resolveExitCode(signal === null ? 1 : 128);
    });
  });
  process.exitCode = exitCode;
} catch (error) {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(message);
  process.exitCode = 1;
}
