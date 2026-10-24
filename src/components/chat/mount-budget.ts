const tail = 40
const chunk = 60

export const mountBudget = {
  tail,
  chunk,
  start: (count: number) => Math.max(0, count - tail),
  older: (start: number) => Math.max(0, start - chunk),
} as const
