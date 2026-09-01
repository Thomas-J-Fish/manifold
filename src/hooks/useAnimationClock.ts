import { useEffect, useRef } from 'react';
import { useStore } from '../core/store';

/**
 * Drives the shared timeline.
 *
 * Time advances by the measured frame delta rather than by a fixed increment,
 * so a sweep that is set to take six seconds takes six seconds whether the
 * window is managing 60 fps or struggling at 20. A delta longer than a fifth of
 * a second is discarded: that means the tab was backgrounded or a long
 * computation blocked the thread, and replaying the whole gap in one step would
 * make the animation jump.
 */
export function useAnimationClock(): void {
  const lastRef = useRef<number | null>(null);
  const frameRef = useRef<number | null>(null);
  /** +1 or −1; only ever −1 while a ping-pong timeline is on its way back. */
  const directionRef = useRef(1);

  useEffect(() => {
    const tick = (now: number) => {
      frameRef.current = requestAnimationFrame(tick);
      const state = useStore.getState();
      const tab = state.activeTab();
      if (!tab?.timeline.playing) {
        lastRef.current = null;
        return;
      }
      const last = lastRef.current;
      lastRef.current = now;
      if (last === null) return;
      const dt = Math.min((now - last) / 1000, 0.2) * tab.timeline.speed;
      if (dt <= 0) return;

      const tl = tab.timeline;
      const span = tl.tMax - tl.tMin || 1;
      let t = tl.t + dt * directionRef.current;
      let playing = true;
      if (tl.mode === 'pingpong') {
        // The direction is held across frames rather than derived from the
        // position, so the clock reverses exactly once at each end instead of
        // chattering while it sits on the boundary.
        if (t >= tl.tMax) {
          t = tl.tMax;
          directionRef.current = -1;
        } else if (t <= tl.tMin) {
          t = tl.tMin;
          directionRef.current = 1;
        }
      } else if (t > tl.tMax) {
        directionRef.current = 1;
        if (tl.mode === 'once') {
          t = tl.tMax;
          playing = false;
        } else {
          t = tl.tMin + ((t - tl.tMin) % span);
        }
      }
      useStore.setState((s) => ({
        project: {
          ...s.project,
          tabs: s.project.tabs.map((x) =>
            x.id === tab.id ? { ...x, timeline: { ...x.timeline, t, playing } } : x,
          ),
        },
      }));
    };

    frameRef.current = requestAnimationFrame(tick);
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    };
  }, []);
}
