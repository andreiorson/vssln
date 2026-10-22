/** Runs `fn` once per burst of calls, `delayMs` after the first call of the burst. */
export function coalesce(fn: () => void, delayMs: number): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      fn();
    }, delayMs);
  };
}

/** Runs `fn` `delayMs` after the last call of a burst; `cancel` drops a pending run. */
export function debounce(fn: () => void, delayMs: number): (() => void) & { cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      fn();
    }, delayMs);
  };
  return Object.assign(run, {
    cancel() {
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  });
}
