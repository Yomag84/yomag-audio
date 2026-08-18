import { useEffect, useState } from "react"
import { listen } from "@tauri-apps/api/event"
import type { LevelsEvent } from "../types"

export function useDeviceLevels(): LevelsEvent {
  const [levels, setLevels] = useState<LevelsEvent>({})

  useEffect(() => {
    const unlisten = listen<LevelsEvent>("audio://levels", (event) => {
      setLevels(event.payload)
    })

    return () => {
      unlisten.then((fn) => fn())
    }
  }, [])

  return levels
}
