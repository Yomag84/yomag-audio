import { check, type Update } from "@tauri-apps/plugin-updater"
import { relaunch } from "@tauri-apps/plugin-process"

export type { Update }

export interface UpdateProgress {
  downloaded: number
  total: number | null
}

/** Hits the endpoint configured in tauri.conf.json's plugins.updater
 * (a GitHub Releases latest.json, signed against the pubkey there) and
 * returns the available Update, or null if already current. */
export async function checkForUpdate(): Promise<Update | null> {
  return check()
}

/** Downloads, verifies (the plugin rejects anything not signed by the
 * matching private key - see driver/README-adjacent release notes for the
 * signing key handling), installs, and restarts the app. Nothing after
 * relaunch() runs; the process exits from underneath it. */
export async function installUpdateAndRelaunch(
  update: Update,
  onProgress?: (progress: UpdateProgress) => void
): Promise<void> {
  let downloaded = 0
  let total: number | null = null
  await update.downloadAndInstall((event) => {
    switch (event.event) {
      case "Started":
        total = event.data.contentLength ?? null
        onProgress?.({ downloaded, total })
        break
      case "Progress":
        downloaded += event.data.chunkLength
        onProgress?.({ downloaded, total })
        break
      case "Finished":
        break
    }
  })
  await relaunch()
}
