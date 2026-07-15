import { useEffect } from "react"
import { useRenderer } from "@opentui/react"

export function useTerminalTitle(active: boolean, cwd?: string) {
  const renderer = useRenderer()
  useEffect(() => {
    const title = active ? "● Herm" : "Herm"
    const name = cwd?.split(/[\\/]/).filter(Boolean).at(-1)
    renderer.setTerminalTitle(name ? `${title} · ${name}` : title)
  }, [renderer, active, cwd])
}
