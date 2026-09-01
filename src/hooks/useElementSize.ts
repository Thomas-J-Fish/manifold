import { useEffect, useRef, useState } from 'react';

export interface Size {
  width: number;
  height: number;
}

/**
 * Tracks an element's content-box size with a ResizeObserver.
 *
 * Reading `getBoundingClientRect` on every render would be simpler and would
 * also force a layout on every frame of a window resize; the observer reports
 * the size the browser has already computed, which is both cheaper and correct
 * when the element is resized by something other than the window.
 */
export function useElementSize<T extends HTMLElement>(): [React.RefObject<T | null>, Size] {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const box = entry.contentRect;
      // Rounding here stops a fractional layout size producing a canvas whose
      // backing store changes by a sub-pixel on every frame.
      setSize((prev) => {
        const width = Math.round(box.width);
        const height = Math.round(box.height);
        return prev.width === width && prev.height === height ? prev : { width, height };
      });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return [ref, size];
}
