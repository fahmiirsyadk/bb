import { spawn } from "node:child_process";
import { createServer } from "node:http";
import {
  access,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createDesktopReleaseConfig,
  resolveDesktopReleaseChannel,
  resolveDesktopUpdateMetadataFileName,
} from "./desktop-release-channel.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const desktopPackageRoot = resolve(scriptDirectory, "..");
const releaseDir = join(desktopPackageRoot, "release");
const releaseChannel = resolveDesktopReleaseChannel(process.env);
const releaseConfig = createDesktopReleaseConfig(releaseChannel);
const startupTimeoutMs = 30_000;
const runtimeStartupTimeoutMs = 30_000;
const exitTimeoutMs = 8_000;
const pollIntervalMs = 250;
const maxCapturedOutputCharacters = 20_000;

function resolveDesktopPlatform(platform) {
  if (platform === "darwin") {
    return "macos";
  }
  if (platform === "linux") {
    return "linux";
  }
  throw new Error(
    `Packaged desktop smoke is supported on macOS and Linux, not ${platform}.`,
  );
}

const desktopPlatform = resolveDesktopPlatform(process.platform);
const updateMetadataFileName = resolveDesktopUpdateMetadataFileName(
  releaseChannel,
  process.platform,
);

function writeJson(response, body) {
  response.writeHead(200, {
    "content-type": "application/json",
  });
  response.end(JSON.stringify(body));
}

function writeHtml(response, html) {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
  });
  response.end(html);
}

function writeNotFound(response) {
  response.writeHead(404, {
    "content-type": "application/json",
  });
  response.end(JSON.stringify({ message: "not found" }));
}

function incrementPatchVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(version);
  if (!match) {
    throw new Error(`Desktop package version is not semver-like: ${version}`);
  }
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

function createDesktopVersionFeed(version) {
  const latestVersion = incrementPatchVersion(version);
  const artifactStem =
    desktopPlatform === "linux"
      ? releaseConfig.linuxPackageName
      : releaseConfig.applicationName.replaceAll(" ", "-").toLowerCase();
  const artifactName = `${artifactStem}-${latestVersion}-${
    desktopPlatform === "linux" ? "x86_64" : "arm64"
  }.${desktopPlatform === "linux" ? "AppImage" : "zip"}`;

  return {
    schemaVersion: 1,
    channel: releaseChannel,
    platform: desktopPlatform,
    version: latestVersion,
    releaseDate: new Date(0).toISOString(),
    releaseName: `${releaseConfig.applicationName} desktop ${latestVersion}`,
    releaseNotes: null,
    minimumSystemVersion: null,
    files: [
      {
        url: `https://example.invalid/${artifactName}`,
        sha512: "smoke",
        size: 0,
      },
    ],
    path: artifactName,
    sha512: "smoke",
    stagingPercentage: null,
  };
}

function renderSmokePage({ expectedDesktopVersion, expectedLatestVersion }) {
  return `<!doctype html>
<meta charset="utf-8">
<title>bb packaged desktop smoke</title>
<main>packaged desktop smoke</main>
<script>
(async () => {
  let ok = false;
  let reason = "";
  try {
    if (typeof window.bbDesktop !== "object" || window.bbDesktop === null) {
      reason = "missing window.bbDesktop";
    } else if (typeof window.bbDesktop.getInfo !== "function") {
      reason = "missing window.bbDesktop.getInfo";
    } else {
      const expectedPlatform = ${JSON.stringify(desktopPlatform)};
      const expectedVersion = ${JSON.stringify(expectedDesktopVersion)};
      const expectedLatestVersion = ${JSON.stringify(expectedLatestVersion)};
      let info = await window.bbDesktop.getInfo();
      const deadline = Date.now() + 25000;
      while (
        (info.latestVersion !== expectedLatestVersion ||
          info.updateAvailable !== true) &&
        Date.now() < deadline
      ) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
        info = await window.bbDesktop.getInfo();
      }
      ok =
        window.bbDesktop.platform === expectedPlatform &&
        window.bbDesktop.version === expectedVersion &&
        info.platform === expectedPlatform &&
        info.version === expectedVersion &&
        info.latestVersion === expectedLatestVersion &&
        info.updateAvailable === true &&
        info.updateDownloaded === false;
      reason = ok
        ? ""
        : "unexpected platform-aware desktop bridge or update info";
    }
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error);
  }
  const params = new URLSearchParams({
    ok: ok ? "1" : "0",
    reason,
  });
  await fetch("/smoke/preload-ready?" + params.toString(), { method: "POST" });
})();
</script>`;
}

async function readDesktopPackageVersion() {
  const packageJsonText = await readFile(
    join(desktopPackageRoot, "package.json"),
    "utf8",
  );
  const packageJson = JSON.parse(packageJsonText);
  if (
    typeof packageJson !== "object" ||
    packageJson === null ||
    typeof packageJson.version !== "string" ||
    packageJson.version.length === 0
  ) {
    throw new Error("apps/desktop/package.json must define a version");
  }
  return packageJson.version;
}

async function resolvePackagedApp() {
  let entries;
  try {
    entries = await readdir(releaseDir, { withFileTypes: true });
  } catch {
    throw new Error(
      `Packaged desktop release directory is unavailable: ${releaseDir}. Build the Linux linux-unpacked directory or macOS app artifact first.`,
    );
  }

  if (process.platform === "linux") {
    const linuxOutputDirectories = entries
      .filter(
        (entry) =>
          entry.isDirectory() &&
          (entry.name === "linux-unpacked" || entry.name.endsWith("-unpacked")),
      )
      .map((entry) => join(releaseDir, entry.name))
      .sort();
    const executableNames = [
      releaseConfig.linuxExecutableName,
      releaseConfig.applicationName,
      releaseConfig.linuxPackageName,
    ];

    for (const outputDirectory of linuxOutputDirectories) {
      for (const executableName of executableNames) {
        const appBinary = join(outputDirectory, executableName);
        try {
          await access(appBinary);
          return {
            appBinary,
            resourcesPath: join(outputDirectory, "resources"),
          };
        } catch {
          continue;
        }
      }
    }

    const appImage = entries.find(
      (entry) =>
        entry.isFile() && entry.name.toLowerCase().endsWith(".appimage"),
    );
    const appImageHint = appImage
      ? ` An AppImage is present (${appImage.name}), but deterministic runtime smoke requires the unpacked directory; run the directory packaging step first.`
      : "";
    throw new Error(
      `No packaged Linux executable found under ${releaseDir}/linux-unpacked.${appImageHint} Expected ${releaseConfig.linuxExecutableName}.`,
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
    const macOutputDirectories = entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("mac"))
      .map((entry) => entry.name)
      .sort();

    for (const directory of macOutputDirectories) {
      const appBinary = join(releaseDir, directory, appBinaryRelativePath);
      try {
        await access(appBinary);
        const appBundleRoot = resolve(dirname(appBinary), "..", "..");
        return {
          appBinary,
          resourcesPath: join(appBundleRoot, "Contents", "Resources"),
        };
      } catch {
        continue;
      }
    }

    throw new Error(
      `No packaged macOS ${appBundleName} found under ${releaseDir}.`,
    );
  }

  throw new Error(
    `Packaged desktop smoke is supported on macOS and Linux, not ${process.platform}.`,
  );
}

async function resolvePackagedBridge(resourcesPath) {
  const candidates = [
    join(resourcesPath, "app.asar.unpacked", "dist", "bb-app-bridge.mjs"),
    join(resourcesPath, "app", "dist", "bb-app-bridge.mjs"),
  ];
  for (const bridgePath of candidates) {
    try {
      await access(bridgePath);
      return bridgePath;
    } catch {
      continue;
    }
  }
  throw new Error(
    `Packaged ${desktopPlatform} bb-app bridge is unavailable. Checked: ${candidates.join(", ")}`,
  );
}

function appendOutput(chunks, chunk) {
  chunks.push(String(chunk));
  let totalLength = chunks.reduce((total, value) => total + value.length, 0);
  while (totalLength > maxCapturedOutputCharacters && chunks.length > 1) {
    const removed = chunks.shift();
    totalLength -= removed.length;
  }
}

function formatProcessOutput({ stdout, stderr }) {
  const stdoutText = stdout.join("").trim();
  const stderrText = stderr.join("").trim();
  return [
    stdoutText.length > 0 ? `stdout:\n${stdoutText}` : "",
    stderrText.length > 0 ? `stderr:\n${stderrText}` : "",
  ]
    .filter((part) => part.length > 0)
    .join("\n\n");
}

function captureProcessOutput(child) {
  const stdout = [];
  const stderr = [];
  child.stdout?.on("data", (chunk) => appendOutput(stdout, chunk));
  child.stderr?.on("data", (chunk) => appendOutput(stderr, chunk));
  return { stderr, stdout };
}

async function sleep(delayMs) {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs));
}

async function waitForValue(description, readValue, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() <= deadline) {
    try {
      const value = await readValue();
      if (value !== null && value !== undefined && value !== false) {
        return value;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(pollIntervalMs);
  }
  const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
  throw new Error(`Timed out waiting for ${description}${detail}`);
}

async function waitForProcessExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return true;
  }
  return await new Promise((resolvePromise) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolvePromise(false);
    }, timeoutMs);
    const handleExit = () => {
      cleanup();
      resolvePromise(true);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.off("exit", handleExit);
    };
    child.once("exit", handleExit);
  });
}

async function stopProcess(child, label) {
  if (child === null || (await waitForProcessExit(child, 0))) {
    return;
  }
  child.kill("SIGTERM");
  if (await waitForProcessExit(child, exitTimeoutMs)) {
    return;
  }
  child.kill("SIGKILL");
  if (!(await waitForProcessExit(child, exitTimeoutMs))) {
    throw new Error(`${label} did not exit after SIGTERM/SIGKILL`);
  }
}

async function waitForPreloadReady({ child, preloadReady, stdout, stderr }) {
  return await new Promise((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => {
      cleanup();
      rejectPromise(
        new Error(
          `Timed out waiting for the packaged Electron app to report ready.\n${formatProcessOutput(
            {
              stdout,
              stderr,
            },
          )}`,
        ),
      );
    }, startupTimeoutMs);
    const handleExit = (code, signal) => {
      cleanup();
      rejectPromise(
        new Error(
          `Packaged Electron app exited before startup completed: code=${String(
            code,
          )} signal=${String(signal)}.\n${formatProcessOutput({
            stdout,
            stderr,
          })}`,
        ),
      );
    };
    const handleError = (error) => {
      cleanup();
      rejectPromise(
        new Error(
          `Could not launch packaged Electron app: ${error.message}.\n${formatProcessOutput(
            {
              stdout,
              stderr,
            },
          )}`,
        ),
      );
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.off("exit", handleExit);
      child.off("error", handleError);
    };

    child.once("exit", handleExit);
    child.once("error", handleError);
    preloadReady.then(
      (result) => {
        cleanup();
        resolvePromise(result);
      },
      (error) => {
        cleanup();
        rejectPromise(error);
      },
    );
  });
}

async function allocatePort() {
  const server = createServer();
  await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  await new Promise((resolvePromise, rejectPromise) => {
    server.close((error) => (error ? rejectPromise(error) : resolvePromise()));
  });
  if (address === null || typeof address === "string") {
    throw new Error("Expected an allocated TCP port");
  }
  return address.port;
}

async function waitForHttp({ child, label, stderr, stdout, timeoutMs, url }) {
  const deadline = Date.now() + timeoutMs;
  let lastFailure = "connection failed";
  while (Date.now() <= deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `${label} exited before becoming healthy: code=${String(
          child.exitCode,
        )} signal=${String(child.signalCode)}.\n${formatProcessOutput({
          stdout,
          stderr,
        })}`,
      );
    }
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
      lastFailure = `HTTP ${response.status}`;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }
    await sleep(pollIntervalMs);
  }
  throw new Error(`Timed out waiting for ${label} at ${url}: ${lastFailure}`);
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!response.ok) {
    throw new Error(
      `${options.method ?? "GET"} ${url} failed with HTTP ${response.status}: ${String(
        body,
      ).slice(0, 500)}`,
    );
  }
  return body;
}

async function startSmokeServer({ expectedDesktopVersion }) {
  const expectedFeed = createDesktopVersionFeed(expectedDesktopVersion);
  let resolvePreloadReady = () => {};
  const preloadReady = new Promise((resolvePromise) => {
    resolvePreloadReady = resolvePromise;
  });
  let feedRequestCount = 0;
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    if (requestUrl.pathname === "/health") {
      writeJson(response, { ok: true });
      return;
    }
    if (requestUrl.pathname === "/desktop-version.json") {
      feedRequestCount += 1;
      writeJson(response, expectedFeed);
      return;
    }
    if (requestUrl.pathname === "/") {
      writeHtml(
        response,
        renderSmokePage({
          expectedDesktopVersion,
          expectedLatestVersion: expectedFeed.version,
        }),
      );
      return;
    }
    if (requestUrl.pathname === "/smoke/preload-ready") {
      resolvePreloadReady({
        ok: requestUrl.searchParams.get("ok") === "1",
        reason: requestUrl.searchParams.get("reason") ?? "",
      });
      response.writeHead(204);
      response.end();
      return;
    }
    writeNotFound(response);
  });

  await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected desktop smoke server to listen on a TCP port");
  }

  return {
    close: async () =>
      await new Promise((resolvePromise, rejectPromise) => {
        server.close((error) =>
          error ? rejectPromise(error) : resolvePromise(),
        );
      }),
    get feedRequestCount() {
      return feedRequestCount;
    },
    port: address.port,
    preloadReady,
  };
}

function createRuntimeEnv({ dataDir, daemonPort, homeDir, serverPort }) {
  const env = {
    ...process.env,
    BB_APP_SURFACE: "desktop",
    BB_DATA_DIR: dataDir,
    BB_HOST_DAEMON_PORT: String(daemonPort),
    BB_LOG_LEVEL: "debug",
    BB_SERVER_PORT: String(serverPort),
    HOME: homeDir,
    NODE_ENV: "production",
    ELECTRON_RUN_AS_NODE: "1",
    XDG_CACHE_HOME: join(homeDir, ".cache"),
    XDG_CONFIG_HOME: join(homeDir, ".config"),
  };
  delete env.BB_BRIDGE_DIR;
  delete env.BB_CLI;
  delete env.BB_CLI_DIR;
  delete env.BB_HOST_ENROLL_KEY;
  delete env.BB_SERVER_URL;
  return env;
}

async function startPackagedRuntime({ appBinary, bridgePath, smokeRoot }) {
  const serverPort = await allocatePort();
  const daemonPort = await allocatePort();
  const dataDir = join(smokeRoot, "runtime-data");
  const homeDir = join(smokeRoot, "runtime-home");
  const child = spawn(appBinary, [bridgePath], {
    cwd: smokeRoot,
    env: createRuntimeEnv({ dataDir, daemonPort, homeDir, serverPort }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const { stderr, stdout } = captureProcessOutput(child);

  try {
    await waitForHttp({
      child,
      label: "packaged bb-app server",
      stderr,
      stdout,
      timeoutMs: runtimeStartupTimeoutMs,
      url: `http://127.0.0.1:${serverPort}/health`,
    });
    await waitForHttp({
      child,
      label: "packaged host daemon",
      stderr,
      stdout,
      timeoutMs: runtimeStartupTimeoutMs,
      url: `http://127.0.0.1:${daemonPort}/health`,
    });
  } catch (error) {
    await stopProcess(child, "Packaged bb-app runtime").catch(() => {});
    throw error;
  }

  return {
    child,
    dataDir,
    daemonPort,
    serverUrl: `http://127.0.0.1:${serverPort}`,
    serverPort,
    stderr,
    stdout,
  };
}

async function assertSQLiteDatabase(dataDir) {
  const databasePath = join(dataDir, "bb.db");
  await waitForValue(
    `SQLite database at ${databasePath}`,
    async () => {
      const handle = await open(databasePath, "r").catch(() => null);
      if (handle === null) {
        return null;
      }
      try {
        const header = Buffer.alloc(16);
        await handle.read(header, 0, header.length, 0);
        return header.toString("utf8") === "SQLite format 3\0" ? true : null;
      } finally {
        await handle.close();
      }
    },
    runtimeStartupTimeoutMs,
  );
}

async function assertTerminal(serverUrl, smokeRoot, host) {
  const terminal = await fetchJson(`${serverUrl}/api/v1/terminals`, {
    body: JSON.stringify({
      cols: 80,
      rows: 24,
      start: {
        mode: "command",
        // Keep the PTY alive long enough for the server's output replay
        // endpoint to observe it. A command that exits immediately becomes an
        // exited session, whose output endpoint intentionally returns 409.
        command: "printf 'bb-packaged-terminal-smoke\\n'; sleep 10",
      },
      target: {
        kind: "host_path",
        hostId: host.id,
        cwd: smokeRoot,
      },
      title: "packaged desktop smoke",
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  if (typeof terminal?.id !== "string") {
    throw new Error("Packaged terminal API did not return a terminal id");
  }

  try {
    await waitForValue(
      "terminal output from the packaged host daemon",
      async () => {
        const output = await fetchJson(
          `${serverUrl}/api/v1/terminals/${terminal.id}/output?sinceSeq=0`,
        );
        const text = (output.chunks ?? [])
          .map((chunk) => Buffer.from(chunk.dataBase64, "base64").toString())
          .join("");
        return text.includes("bb-packaged-terminal-smoke") ? true : null;
      },
      runtimeStartupTimeoutMs,
    );
  } finally {
    await fetchJson(`${serverUrl}/api/v1/terminals/${terminal.id}/close`, {
      body: JSON.stringify({ mode: "force", reason: "user" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }).catch(() => {});
  }
}

async function assertFilesystemWatching(dataDir, diagnostics) {
  const marker = `bb-packaged-watch-${Date.now()}`;
  const markerPath = join(dataDir, "skills", "packaged-smoke", `${marker}.md`);
  const daemonLogDirectory = join(dataDir, "logs");
  const readHostDaemonLogs = async () => {
    const logNames = await readdir(daemonLogDirectory).catch(() => []);
    const hostDaemonLogNames = logNames.filter((name) =>
      /^host-daemon(?:\.\d+)?\.log$/u.test(name),
    );
    const logContents = await Promise.all(
      hostDaemonLogNames.map((name) =>
        readFile(join(daemonLogDirectory, name), "utf8").catch(() => ""),
      ),
    );
    return logContents.join("\n");
  };
  await mkdir(dirname(markerPath), { recursive: true });
  await writeFile(markerPath, `# ${marker}\n`, "utf8");

  try {
    await waitForValue(
      "packaged data-directory filesystem watcher",
      async () => {
        const log = await readHostDaemonLogs();
        return log.includes("Injected skills changed") && log.includes(marker)
          ? true
          : null;
      },
      runtimeStartupTimeoutMs,
    );
  } catch (error) {
    const log = await readHostDaemonLogs();
    const logDirectoryEntries = await readdir(daemonLogDirectory).catch(
      () => [],
    );
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${detail}. Log files: ${logDirectoryEntries.join(", ") || "none"}. Recent host-daemon log:\n${log.slice(-4_000)}\n${formatProcessOutput(diagnostics)}`,
    );
  }
}

async function assertRuntimeBehavior(runtime, smokeRoot) {
  const hosts = await waitForValue(
    "a connected packaged host daemon",
    async () => {
      const response = await fetchJson(`${runtime.serverUrl}/api/v1/hosts`);
      if (!Array.isArray(response)) {
        throw new Error("GET /api/v1/hosts did not return an array");
      }
      return (
        response.find(
          (host) => host.status === "connected" && typeof host.id === "string",
        ) ?? null
      );
    },
    runtimeStartupTimeoutMs,
  );

  await assertSQLiteDatabase(runtime.dataDir);
  await assertTerminal(runtime.serverUrl, smokeRoot, hosts);
  await assertFilesystemWatching(runtime.dataDir, runtime);
}

async function smokePackagedApp() {
  if (
    process.platform === "linux" &&
    !process.env.DISPLAY &&
    !process.env.WAYLAND_DISPLAY
  ) {
    throw new Error(
      "Linux packaged desktop smoke needs a graphical display; run it under xvfb-run (the Ubuntu CI job does this).",
    );
  }

  const desktopVersion = await readDesktopPackageVersion();
  const packagedApp = await resolvePackagedApp();
  const bridgePath = await resolvePackagedBridge(packagedApp.resourcesPath);
  const smokeRoot = await mkdtemp(join(tmpdir(), "bb-desktop-packaged-smoke-"));
  const smokeServer = await startSmokeServer({
    expectedDesktopVersion: desktopVersion,
  });
  let runtime = null;
  let appChild = null;
  let appOutput = null;

  try {
    runtime = await startPackagedRuntime({
      appBinary: packagedApp.appBinary,
      bridgePath,
      smokeRoot,
    });
    await assertRuntimeBehavior(runtime, smokeRoot);

    const appDataDir = join(smokeRoot, "desktop-data");
    const userDataDir = join(smokeRoot, "user-data");
    const appEnv = {
      ...process.env,
      BB_DATA_DIR: appDataDir,
      BB_DESKTOP_ATTACH_WITHOUT_PROMPT: "1",
      BB_DESKTOP_OPEN_DEVTOOLS: "0",
      BB_DESKTOP_VERSION_FEED_URL: `http://127.0.0.1:${smokeServer.port}/desktop-version.json`,
      BB_HOST_DAEMON_PORT: String(runtime.daemonPort),
      BB_SERVER_PORT: String(runtime.serverPort),
      HOME: join(smokeRoot, "desktop-home"),
      XDG_CACHE_HOME: join(smokeRoot, "desktop-home", ".cache"),
      XDG_CONFIG_HOME: join(smokeRoot, "desktop-home", ".config"),
    };
    delete appEnv.APPIMAGE;
    delete appEnv.BB_DESKTOP_NODE_EXEC_PATH;
    delete appEnv.BB_SERVER_URL;
    delete appEnv.ELECTRON_RUN_AS_NODE;

    const appArgs = [`--user-data-dir=${userDataDir}`];
    if (process.platform === "linux") {
      appArgs.push(
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--password-store=basic",
      );
      if (process.env.CI === "true") {
        appArgs.push("--no-sandbox");
      }
    }
    appEnv.BB_DESKTOP_APP_URL = `http://127.0.0.1:${smokeServer.port}`;
    // Do not let a developer session's DBus keyring delay the packaged shell
    // startup. The smoke app does not exercise desktop credential storage.
    delete appEnv.DBUS_SESSION_BUS_ADDRESS;
    appChild = spawn(packagedApp.appBinary, appArgs, {
      cwd: smokeRoot,
      env: appEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    appOutput = captureProcessOutput(appChild);

    const preloadReady = await waitForPreloadReady({
      child: appChild,
      preloadReady: smokeServer.preloadReady,
      stdout: appOutput.stdout,
      stderr: appOutput.stderr,
    });
    if (!preloadReady.ok) {
      throw new Error(
        `Packaged desktop preload/update bridge did not become ready: ${preloadReady.reason}`,
      );
    }
    if (smokeServer.feedRequestCount === 0) {
      throw new Error(
        `Packaged desktop did not request the platform-aware ${desktopPlatform} desktop-version.json feed`,
      );
    }

    await sleep(300);
    if (appChild.exitCode !== null || appChild.signalCode !== null) {
      throw new Error(
        `Packaged Electron app exited after startup: code=${String(
          appChild.exitCode,
        )} signal=${String(appChild.signalCode)}.\n${formatProcessOutput(
          appOutput,
        )}`,
      );
    }

    await stopProcess(appChild, "Packaged Electron app");
    appChild = null;
    if (runtime.child.exitCode !== null || runtime.child.signalCode !== null) {
      throw new Error(
        `Packaged runtime exited when the Electron shell quit: code=${String(
          runtime.child.exitCode,
        )} signal=${String(runtime.child.signalCode)}`,
      );
    }

    console.log(
      `Packaged ${desktopPlatform} desktop smoke passed: ${packagedApp.appBinary} (metadata ${updateMetadataFileName})`,
    );
  } finally {
    await stopProcess(appChild, "Packaged Electron app");
    await stopProcess(runtime?.child ?? null, "Packaged bb-app runtime");
    await smokeServer.close();
    await rm(smokeRoot, { force: true, recursive: true });
  }
}

await smokePackagedApp().catch((error) => {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(message);
  process.exitCode = 1;
});
