import { describe, expect, it, vi } from "vitest";
import { HOST_DAEMON_PROTOCOL_VERSION } from "@bb/host-daemon-contract";
import type { HostDaemonStatusSnapshot } from "./api-host-daemon";
import { findLocalHostDaemonSnapshot } from "./system-config-atoms";

const status: HostDaemonStatusSnapshot = {
  hostId: "host_local",
  connected: true,
  protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
  serverUrl: "https://bb.example.test",
  supportsNativeFolderPicker: false,
  platform: "windows",
};

describe("findLocalHostDaemonSnapshot", () => {
  it("probes the daemon-advertised port instead of the stale configured default", async () => {
    const fetchAdvertisedStatus = vi.fn(async () => status);
    const fetchFallbackStatus = vi.fn(async () => null);

    await expect(
      findLocalHostDaemonSnapshot({
        advertisedPorts: [38888],
        fallbackPort: 38887,
        serverUrl: "https://bb.example.test/",
        fetchAdvertisedStatus,
        fetchFallbackStatus,
      }),
    ).resolves.toEqual({ port: 38888, status });

    expect(fetchAdvertisedStatus).toHaveBeenCalledOnce();
    expect(fetchAdvertisedStatus).toHaveBeenCalledWith(38888);
    expect(fetchFallbackStatus).not.toHaveBeenCalled();
  });
});
