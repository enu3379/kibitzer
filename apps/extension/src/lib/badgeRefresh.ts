export function createBadgeRefresher<T>(
  computeStatus: () => Promise<T>,
  applyStatus: (status: T) => Promise<void>,
): () => Promise<void> {
  let latestSequence = 0
  let applyQueue = Promise.resolve()
  let hasAppliedStatus = false
  let lastAppliedStatus: T

  return async function refreshBadge(): Promise<void> {
    const sequence = ++latestSequence
    const status = await computeStatus()
    if (sequence !== latestSequence) return

    const applyRequest = applyQueue.then(async () => {
      if (sequence !== latestSequence) return
      if (hasAppliedStatus && Object.is(status, lastAppliedStatus)) return

      try {
        await applyStatus(status)
      } catch (error) {
        hasAppliedStatus = false
        throw error
      }

      if (sequence === latestSequence) {
        lastAppliedStatus = status
        hasAppliedStatus = true
      } else {
        // A newer request arrived while this icon update was in flight. The
        // cached status no longer describes the icon that may have been drawn.
        hasAppliedStatus = false
      }
    })
    applyQueue = applyRequest.catch(() => undefined)
    await applyRequest
  }
}
