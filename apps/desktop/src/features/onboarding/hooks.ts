import { useEffect, useState, useSyncExternalStore } from 'react';

const REDUCED = '(prefers-reduced-motion: reduce)';

function subscribe(onChange: () => void) {
  const query = window.matchMedia(REDUCED);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(REDUCED).matches,
    () => false,
  );
}

/**
 * Milliseconds since `running` became true, updated every frame until
 * `duration` is reached. With reduced motion it jumps straight to the end.
 */
export function useTimeline(running: boolean, duration: number): number {
  const reduced = useReducedMotion();
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!running || reduced) return;
    let frame = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const e = Math.min(duration, now - start);
      setElapsed(e);
      if (e < duration) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      setElapsed(0);
    };
  }, [running, reduced, duration]);

  if (!running) return 0;
  return reduced ? duration : elapsed;
}
