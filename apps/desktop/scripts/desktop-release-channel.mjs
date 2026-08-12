export const DESKTOP_RELEASE_CHANNEL_ENV_NAME = "BB_DESKTOP_RELEASE_CHANNEL";

export function resolveDesktopReleaseChannel(env) {
  const rawChannel = env[DESKTOP_RELEASE_CHANNEL_ENV_NAME]?.trim();
  if (rawChannel === undefined || rawChannel.length === 0) {
    return "latest";
  }
  if (rawChannel === "latest" || rawChannel === "nightly") {
    return rawChannel;
  }

  throw new Error(
    `${DESKTOP_RELEASE_CHANNEL_ENV_NAME} must be latest or nightly, got ${rawChannel}.`,
  );
}

export function createDesktopReleaseConfig(channel) {
  if (channel === "nightly") {
    return {
      appId: "dev.bb.desktop.nightly",
      applicationName: "bb Nightly",
      artifactName: "bb-nightly-${version}-${arch}.${ext}",
      iconFileName: "icon-nightly.png",
      linuxIconPath: "assets/icon-nightly.png",
      linuxExecutableName: "bb-nightly",
      linuxPackageName: "bb-nightly",
      macIconPath: "assets/icon-nightly.icns",
      releaseTag: "desktop-nightly",
      updateMetadataFileName: "nightly-mac.yml",
      linuxUpdateMetadataFileName: "nightly-linux.yml",
    };
  }

  return {
    appId: "dev.bb.desktop",
    applicationName: "bb",
    artifactName: "${productName}-${version}-${arch}.${ext}",
    iconFileName: "icon.png",
    linuxIconPath: "assets/icon.png",
    linuxExecutableName: "bb",
    linuxPackageName: "bb",
    macIconPath: "assets/icon.icns",
    releaseTag: "desktop-latest",
    updateMetadataFileName: "latest-mac.yml",
    linuxUpdateMetadataFileName: "latest-linux.yml",
  };
}

export function createDesktopUpdateReleaseBaseUrl(releaseTag) {
  return `https://github.com/get-bb/bb/releases/download/${releaseTag}/`;
}

export function resolveDesktopUpdateMetadataFileName(channel, platform) {
  const releaseConfig = createDesktopReleaseConfig(channel);

  if (platform === "darwin") {
    return releaseConfig.updateMetadataFileName;
  }
  if (platform === "linux") {
    return releaseConfig.linuxUpdateMetadataFileName;
  }

  throw new Error(
    `Unsupported desktop platform for update metadata: ${String(platform)}.`,
  );
}
