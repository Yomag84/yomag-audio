const AUTO_UPDATE_STORAGE_KEY = "yomag-auto-update"

/** Defaults to enabled: most users want a virtual-cable driver app to stay
 * current without babysitting it, and the update is signed/verified by the
 * updater plugin either way - see src-ui/src/lib/updater.ts. */
export function getAutoUpdateEnabled(): boolean {
  const stored = window.localStorage.getItem(AUTO_UPDATE_STORAGE_KEY)
  return stored === null ? true : stored === "true"
}

export function setAutoUpdateEnabled(enabled: boolean): void {
  window.localStorage.setItem(AUTO_UPDATE_STORAGE_KEY, String(enabled))
}
