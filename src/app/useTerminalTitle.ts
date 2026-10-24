import { useEffect } from "react"
import { useRenderer } from "@opentui/react"
import { NativeError, NativeStatus } from "@opentui/core"

export function useTerminalTitle(active: boolean, cwd?: string) {
  const renderer = useRenderer()
  useEffect(() => {
    const title = active ? "● Herm" : "Herm"
    const name = cwd?.split(/[\\/]/).filter(Boolean).at(-1)
    try {
      renderer.setTerminalTitle(name ? `${title} · ${name}` : title)
    } catch (error) {
      if (!(error instanceof NativeError && error.status === NativeStatus.InvalidPhase)) throw error
    }
  }, [renderer, active, cwd])
}
