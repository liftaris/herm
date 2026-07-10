import type { Gateway } from "../context/gateway"

export async function undo(gw: Gateway, count: number, sid?: string): Promise<void> {
  for (let i = 0; i < count; i++)
    await gw.request("session.undo", sid ? { session_id: sid } : {})
}
