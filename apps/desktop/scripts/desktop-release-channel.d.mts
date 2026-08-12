export type DesktopReleaseChannel = "latest" | "nightly";

export interface DesktopReleaseConfig {
  appId: "dev.bb.desktop" | "dev.bb.desktop.nightly";
  applicationName: "bb" | "bb Nightly";
  artifactName: string;
  iconFileName: "icon.png" | "icon-nightly.png";
  linuxIconPath: "assets/icon.png" | "assets/icon-nightly.png";
  linuxExecutableName: "bb" | "bb-nightly";
  linuxPackageName: "bb" | "bb-nightly";
  macIconPath: "assets/icon.icns" | "assets/icon-nightly.icns";
  releaseTag: "desktop-latest" | "desktop-nightly";
  updateMetadataFileName: "latest-mac.yml" | "nightly-mac.yml";
  linuxUpdateMetadataFileName: "latest-linux.yml" | "nightly-linux.yml";
}

export const DESKTOP_RELEASE_CHANNEL_ENV_NAME: "BB_DESKTOP_RELEASE_CHANNEL";

export function resolveDesktopReleaseChannel(
  env: NodeJS.ProcessEnv,
): DesktopReleaseChannel;

export function createDesktopReleaseConfig(
  channel: DesktopReleaseChannel,
): DesktopReleaseConfig;

export function createDesktopUpdateReleaseBaseUrl(
  releaseTag: DesktopReleaseConfig["releaseTag"],
): string;

export function resolveDesktopUpdateMetadataFileName(
  channel: DesktopReleaseChannel,
  platform: "darwin" | "linux",
):
  | "latest-mac.yml"
  | "nightly-mac.yml"
  | "latest-linux.yml"
  | "nightly-linux.yml";
