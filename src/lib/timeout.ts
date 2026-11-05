/** An AbortSignal that also fires after `ms`; `timedOut` tells the two causes apart. */
export function withTimeout(ms: number, parent?: AbortSignal) {
  const controller = new AbortController()
  let timedOut = false
  const onParentAbort = () => controller.abort()
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, ms)
  if (parent?.aborted) controller.abort()
  else parent?.addEventListener('abort', onParentAbort, {once: true})
  return {
    signal: controller.signal,
    get timedOut() {
      return timedOut
    },
    clear() {
      clearTimeout(timer)
      parent?.removeEventListener('abort', onParentAbort)
    },
  }
}
