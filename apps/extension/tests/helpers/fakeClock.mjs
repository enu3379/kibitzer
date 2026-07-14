export function installFakeClock(startAt = 0) {
  const originalDateNow = Date.now
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout
  let now = startAt
  let nextTimerId = 1
  let restored = false
  const timers = new Map()

  Date.now = () => now
  globalThis.setTimeout = (callback, delay = 0, ...args) => {
    if (typeof callback !== "function") throw new TypeError("fake clock requires a function")
    const id = nextTimerId++
    const numericDelay = Number(delay)
    timers.set(id, {
      id,
      dueAt: now + Math.max(0, Number.isFinite(numericDelay) ? numericDelay : 0),
      callback,
      args,
    })
    return id
  }
  globalThis.clearTimeout = (id) => {
    timers.delete(Number(id))
  }

  async function advanceClockTo(target, maxTimers = 10_000) {
    if (target < now) throw new RangeError("fake clock cannot move backwards")
    let executed = 0
    while (true) {
      const next = [...timers.values()]
        .filter((timer) => timer.dueAt <= target)
        .sort((left, right) => left.dueAt - right.dueAt || left.id - right.id)[0]
      if (!next) break
      if (executed++ >= maxTimers) throw new Error("fake clock timer limit exceeded")
      timers.delete(next.id)
      now = next.dueAt
      await next.callback(...next.args)
      await Promise.resolve()
    }
    now = target
    await Promise.resolve()
  }

  return {
    now: () => now,
    pendingCount: () => timers.size,
    async advanceBy(milliseconds) {
      await advanceClockTo(now + milliseconds)
    },
    async advanceTo(timestamp) {
      await advanceClockTo(timestamp)
    },
    async runAll(maxTimers = 1_000) {
      let executed = 0
      while (timers.size > 0) {
        if (executed++ >= maxTimers) throw new Error("fake clock timer limit exceeded")
        const nextDue = Math.min(...[...timers.values()].map((timer) => timer.dueAt))
        await advanceClockTo(nextDue)
      }
    },
    restore() {
      if (restored) return
      restored = true
      timers.clear()
      Date.now = originalDateNow
      globalThis.setTimeout = originalSetTimeout
      globalThis.clearTimeout = originalClearTimeout
    },
  }
}
