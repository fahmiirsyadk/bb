import type { HostDaemonOnlineRpcRequestMessage } from "@bb/host-daemon-contract";
import { describe, expect, it } from "vitest";
import { registerHostRpcResponder } from "../helpers/host-rpc.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
} from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

const FILE_RESULT = {
  path: "src/main.ts",
  content: "export const value = 1;",
  contentEncoding: "utf8",
  mimeType: "text/typescript",
  modifiedAtMs: 1,
  sha256: "a".repeat(64),
  sizeBytes: 23,
} as const;

describe("environment diff file route", () => {
  it("uses the target host's relative reader for working-tree content", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "C:\\Users\\void\\repo",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "C:\\Users\\void\\repo",
      });
      const requests: HostDaemonOnlineRpcRequestMessage[] = [];
      registerHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        handle: (request) => {
          requests.push(request);
          expect(request.command.type).toBe("host.read_file_relative");
          return { ok: true, result: FILE_RESULT };
        },
      });

      const response = await harness.app.request(
        `/api/v1/environments/${environment.id}/diff/file?target=uncommitted&path=src%2Fmain.ts&side=new`,
      );
      expect(response.status, await response.clone().text()).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        path: FILE_RESULT.path,
        content: FILE_RESULT.content,
      });
      expect(requests).toHaveLength(1);
      expect(requests[0]?.command).toEqual({
        type: "host.read_file_relative",
        rootPath: "C:\\Users\\void\\repo",
        path: "src/main.ts",
        dotfiles: "allow",
      });
    });
  });

  it("joins ref reads with the remote host's path syntax", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "C:\\Users\\void\\repo",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "C:\\Users\\void\\repo",
      });
      const requests: HostDaemonOnlineRpcRequestMessage[] = [];
      registerHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        handle: (request) => {
          requests.push(request);
          expect(request.command.type).toBe("host.read_file");
          return {
            ok: true,
            result: {
              ...FILE_RESULT,
              path: "C:\\Users\\void\\repo\\src\\main.ts",
            },
          };
        },
      });

      const response = await harness.app.request(
        `/api/v1/environments/${environment.id}/diff/file?target=uncommitted&path=src%2Fmain.ts&side=old`,
      );
      expect(response.status, await response.clone().text()).toBe(200);
      expect(requests[0]?.command).toEqual({
        type: "host.read_file",
        path: "C:\\Users\\void\\repo\\src\\main.ts",
        rootPath: "C:\\Users\\void\\repo",
        ref: "HEAD",
      });
    });
  });

  it("rejects backslash traversal before sending a host command", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const requests: HostDaemonOnlineRpcRequestMessage[] = [];
      registerHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        handle: (request) => {
          requests.push(request);
          return { ok: true, result: FILE_RESULT };
        },
      });

      const response = await harness.app.request(
        `/api/v1/environments/${environment.id}/diff/file?target=uncommitted&path=..%5Csecret.txt&side=new`,
      );
      expect(response.status).toBe(400);
      expect(requests).toEqual([]);
    });
  });
});
