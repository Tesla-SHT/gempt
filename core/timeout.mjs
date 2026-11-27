// Run records store absolute deadlines in Unix seconds.
export function deadlineForTimeout(timeoutSec, startMs = Date.now()) {
  return timeoutSec > 0 ? startMs / 1000 + timeoutSec : null;
}

// Node turns a delay above 2^31 - 1 ms into a 1 ms timer.
export function scheduleTimeout(callback, timeoutSec) {
  if (!(timeoutSec > 0)) return;
  const deadline = deadlineForTimeout(timeoutSec);
  let timer;
  function arm() {
    const remainingMs = (deadline - Date.now() / 1000) * 1000;
    timer = setTimeout(() => {
      if (Date.now() / 1000 < deadline) arm();
      else callback();
    }, Math.max(1, Math.min(2 ** 31 - 1, Math.round(remainingMs))));
  }
  arm();
  return () => clearTimeout(timer);
}
