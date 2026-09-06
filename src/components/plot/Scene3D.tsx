import { useEffect, useImperativeHandle, useRef, forwardRef } from 'react';
import * as THREE from 'three';
import { useElementSize } from '../../hooks/useElementSize';

export interface Scene3DHandle {
  toDataUrl(scale?: number): string;
}

export interface SceneContext {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  /** Anything added to this group is disposed automatically on rebuild. */
  content: THREE.Group;
}

interface Props {
  /** Rebuilds the contents of the disposable group. Runs whenever `deps` change. */
  build: (ctx: SceneContext) => void;
  /** Values that, when changed, should trigger a rebuild. */
  deps: unknown[];
  /** Called every animation frame with seconds since mount. */
  onFrame?: (elapsed: number, ctx: SceneContext) => void;
  /** Orbit parameters, controlled by the caller so they can be saved. */
  camera: { theta: number; phi: number; distance: number; target: [number, number, number] };
  onCameraChange?: (c: { theta: number; phi: number; distance: number; target: [number, number, number] }) => void;
  background?: number;
  className?: string;
}

/**
 * A three.js host with hand-rolled orbit controls.
 *
 * The controls are written here rather than imported from three's examples for
 * one reason: the camera state has to live in the project file so that a saved
 * view reopens at the same angle, and OrbitControls owns its state internally
 * with no clean way to drive it from outside without fighting its damping.
 * Spherical coordinates around a target are about thirty lines, and they make
 * the camera a plain serialisable value.
 */
export const Scene3D = forwardRef<Scene3DHandle, Props>(function Scene3D(
  { build, deps, onFrame, camera, onCameraChange, background = 0x11141b, className },
  ref,
) {
  const [containerRef, size] = useElementSize<HTMLDivElement>();
  const mountRef = useRef<HTMLDivElement | null>(null);
  const stateRef = useRef<{
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    content: THREE.Group;
  } | null>(null);
  const cameraRef = useRef(camera);
  cameraRef.current = camera;
  const onFrameRef = useRef(onFrame);
  onFrameRef.current = onFrame;

  // ---------------------------------------------------------------- setup

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      // Required for toDataURL to see anything: without it the buffer is
      // cleared before a read can happen.
      preserveDrawingBuffer: true,
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(background, 1);
    mount.appendChild(renderer.domElement);
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    renderer.domElement.style.display = 'block';

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(background);
    // A little fog keeps distant grid lines from fighting the foreground for
    // attention, which matters a lot when three translucent planes overlap.
    scene.fog = new THREE.Fog(background, 24, 60);

    const cam = new THREE.PerspectiveCamera(45, 1, 0.05, 400);
    const ambient = new THREE.AmbientLight(0xffffff, 0.62);
    const key = new THREE.DirectionalLight(0xffffff, 0.85);
    key.position.set(6, 10, 8);
    const rim = new THREE.DirectionalLight(0x8b7cf6, 0.35);
    rim.position.set(-8, -4, -6);
    scene.add(ambient, key, rim);

    const content = new THREE.Group();
    scene.add(content);

    stateRef.current = { renderer, scene, camera: cam, content };

    let frame = 0;
    const start = performance.now();
    const loop = () => {
      frame = requestAnimationFrame(loop);
      const st = stateRef.current;
      if (!st) return;
      applyCamera(st.camera, cameraRef.current);
      onFrameRef.current?.((performance.now() - start) / 1000, {
        scene: st.scene,
        camera: st.camera,
        content: st.content,
      });
      st.renderer.render(st.scene, st.camera);
    };
    frame = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(frame);
      disposeGroup(content);
      // `renderer.dispose()` releases three's own caches and listeners but
      // leaves the WebGL context alive. A browser allows only a handful of
      // live contexts, and switching between the 2D and 3D linear-algebra
      // views unmounts and remounts this component every time, so the context
      // has to be handed back explicitly or they accumulate until the oldest
      // is force-killed and a view goes black.
      renderer.forceContextLoss();
      renderer.dispose();
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
      stateRef.current = null;
    };
  }, [background]);

  // ---------------------------------------------------------------- sizing

  useEffect(() => {
    const st = stateRef.current;
    if (!st || size.width === 0 || size.height === 0) return;
    st.renderer.setSize(size.width, size.height, false);
    st.camera.aspect = size.width / size.height;
    st.camera.updateProjectionMatrix();
  }, [size.width, size.height]);

  // ---------------------------------------------------------------- contents

  useEffect(() => {
    const st = stateRef.current;
    if (!st) return;
    disposeGroup(st.content);
    build({ scene: st.scene, camera: st.camera, content: st.content });
    // `build` is intentionally not a dependency: it is a new closure on every
    // render, and the caller declares what actually matters through `deps`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  // ---------------------------------------------------------------- gestures

  useEffect(() => {
    const el = mountRef.current;
    if (!el || !onCameraChange) return;
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    let mode: 'orbit' | 'pan' = 'orbit';

    const down = (e: PointerEvent) => {
      dragging = true;
      mode = e.shiftKey || e.button === 1 ? 'pan' : 'orbit';
      lastX = e.clientX;
      lastY = e.clientY;
      el.setPointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      if (!dragging) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      const c = cameraRef.current;
      if (mode === 'orbit') {
        onCameraChange({
          ...c,
          theta: c.theta - dx * 0.008,
          // Clamped just short of the poles: at exactly ±π/2 the up vector
          // becomes degenerate and the view flips.
          phi: Math.max(0.05, Math.min(Math.PI - 0.05, c.phi - dy * 0.008)),
        });
      } else {
        const scale = c.distance * 0.0016;
        const right = new THREE.Vector3(Math.cos(c.theta), 0, -Math.sin(c.theta));
        const up = new THREE.Vector3(0, 1, 0);
        onCameraChange({
          ...c,
          target: [
            c.target[0] - right.x * dx * scale,
            c.target[1] + up.y * dy * scale,
            c.target[2] - right.z * dx * scale,
          ],
        });
      }
    };
    const up = (e: PointerEvent) => {
      dragging = false;
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {
        /* already released */
      }
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const c = cameraRef.current;
      onCameraChange({ ...c, distance: Math.max(1.2, Math.min(120, c.distance * Math.exp(e.deltaY * 0.0014))) });
    };

    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('wheel', wheel, { passive: false });
    return () => {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      el.removeEventListener('wheel', wheel);
    };
  }, [onCameraChange]);

  useImperativeHandle(ref, () => ({
    toDataUrl() {
      const st = stateRef.current;
      if (!st) return '';
      st.renderer.render(st.scene, st.camera);
      return st.renderer.domElement.toDataURL('image/png');
    },
  }));

  return (
    <div ref={containerRef} className={`relative h-full w-full ${className ?? ''}`}>
      <div ref={mountRef} className="h-full w-full cursor-grab touch-none active:cursor-grabbing" />
      {/* A scene you can orbit looks exactly like one you cannot. The grab
          cursor only appears once the pointer is already over the canvas and
          says nothing about scrolling or panning, so the three gestures are
          written down where someone deciding whether to try will see them. */}
      {onCameraChange && (
        <div className="pointer-events-none absolute bottom-2.5 left-3 select-none font-mono text-2xs text-ink-faint/80">
          drag to orbit · scroll to zoom · shift-drag to pan
        </div>
      )}
    </div>
  );
});

function applyCamera(
  cam: THREE.PerspectiveCamera,
  c: { theta: number; phi: number; distance: number; target: [number, number, number] },
): void {
  const sinPhi = Math.sin(c.phi);
  cam.position.set(
    c.target[0] + c.distance * sinPhi * Math.sin(c.theta),
    c.target[1] + c.distance * Math.cos(c.phi),
    c.target[2] + c.distance * sinPhi * Math.cos(c.theta),
  );
  cam.lookAt(c.target[0], c.target[1], c.target[2]);
}

/**
 * Frees geometries, materials and textures before a group is repopulated.
 *
 * WebGL resources are not garbage collected, and `material.dispose()` does not
 * touch the textures the material references — so every label sprite here
 * (each of which owns a CanvasTexture) would strand its texture on the GPU.
 * The plane editor rebuilds this group on every keystroke, so that adds up
 * quickly.
 */
export function disposeGroup(group: THREE.Group): void {
  const doomed: THREE.Object3D[] = [];

  const disposeMaterial = (material: THREE.Material) => {
    for (const key of Object.keys(material) as (keyof THREE.Material)[]) {
      const value = (material as unknown as Record<string, unknown>)[key as string];
      if (value && typeof value === 'object' && value instanceof THREE.Texture) value.dispose();
    }
    material.dispose();
  };

  group.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const material = (mesh as unknown as { material?: THREE.Material | THREE.Material[] }).material;
    if (Array.isArray(material)) material.forEach(disposeMaterial);
    else if (material) disposeMaterial(material);
    if (obj !== group) doomed.push(obj);
  });
  for (const obj of doomed) obj.removeFromParent();
  group.clear();
}

// ------------------------------------------------------------------ helpers

/** A labelled axis triad plus a ground grid, shared by the 3D views. */
export function addAxes(content: THREE.Group, extent = 5): void {
  const grid = new THREE.GridHelper(extent * 2, extent * 2, 0x3b4356, 0x252a36);
  (grid.material as THREE.Material).transparent = true;
  (grid.material as THREE.Material).opacity = 0.55;
  content.add(grid);

  const axes: [THREE.Vector3, number][] = [
    [new THREE.Vector3(1, 0, 0), 0xfb7185],
    [new THREE.Vector3(0, 1, 0), 0x34d399],
    [new THREE.Vector3(0, 0, 1), 0x38bdf8],
  ];
  for (const [dir, colour] of axes) {
    content.add(new THREE.ArrowHelper(dir, new THREE.Vector3(0, 0, 0), extent, colour, 0.32, 0.18));
    const back = dir.clone().multiplyScalar(-1);
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), back.multiplyScalar(extent)]),
      new THREE.LineBasicMaterial({ color: colour, transparent: true, opacity: 0.28 }),
    );
    content.add(line);
  }
}

/** A thick line built from a cylinder, because WebGL ignores lineWidth. */
export function makeVector(
  from: THREE.Vector3,
  to: THREE.Vector3,
  colour: number,
  radius = 0.035,
): THREE.Group {
  const group = new THREE.Group();
  const dir = to.clone().sub(from);
  const length = dir.length();
  if (length < 1e-6) return group;

  const shaftLength = Math.max(0.001, length - 0.28);
  const shaft = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius, shaftLength, 12),
    new THREE.MeshStandardMaterial({ color: colour, roughness: 0.45, metalness: 0.05 }),
  );
  const head = new THREE.Mesh(
    new THREE.ConeGeometry(radius * 2.6, 0.28, 16),
    new THREE.MeshStandardMaterial({ color: colour, roughness: 0.45, metalness: 0.05 }),
  );

  // Both parts are built along +Y and then rotated onto the target direction,
  // which is the cheapest way to orient a cylinder in three.js.
  const quaternion = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    dir.clone().normalize(),
  );
  shaft.position.copy(dir.clone().normalize().multiplyScalar(shaftLength / 2).add(from));
  shaft.quaternion.copy(quaternion);
  head.position.copy(dir.clone().normalize().multiplyScalar(shaftLength + 0.14).add(from));
  head.quaternion.copy(quaternion);

  group.add(shaft, head);
  return group;
}

/** A text sprite, for axis and vector labels. */
export function makeLabel(text: string, colour = '#e6e9f2', scale = 0.6): THREE.Sprite | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const dpr = 3;
  ctx.font = `${13 * dpr}px -apple-system, BlinkMacSystemFont, Inter, system-ui, sans-serif`;
  const width = Math.ceil(ctx.measureText(text).width) + 10 * dpr;
  const height = 20 * dpr;
  canvas.width = width;
  canvas.height = height;
  const c = canvas.getContext('2d')!;
  c.font = `${13 * dpr}px -apple-system, BlinkMacSystemFont, Inter, system-ui, sans-serif`;
  c.fillStyle = 'rgba(11,13,18,0.72)';
  c.fillRect(0, 0, width, height);
  c.fillStyle = colour;
  c.textBaseline = 'middle';
  c.fillText(text, 5 * dpr, height / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false }),
  );
  sprite.scale.set((width / height) * scale, scale, 1);
  return sprite;
}
