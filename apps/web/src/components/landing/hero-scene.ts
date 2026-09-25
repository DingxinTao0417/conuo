/**
 * WebGL particle hero. One BufferGeometry carries three target layouts per
 * particle and the vertex shader morphs between them:
 *
 *   scatter  — loose "pages" and dust: materials spread across folders and tabs
 *   logo     — the Conuo glyph, sampled from the app icon's white pixels
 *   network  — a slowly turning sphere of concept nodes joined by arcs
 *
 * `uIntro` (0→1, time-driven on load) gathers the pages into the logo and
 * `uMorph` (0→1, driven by scroll) opens the logo into the knowledge network.
 * This module (and with it three.js) is imported lazily by the hero, so
 * signed-in users never download it.
 */
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Group,
  PerspectiveCamera,
  Points,
  Scene,
  ShaderMaterial,
  Sphere,
  Vector3,
  WebGLRenderer,
} from "three";

export type HeroScene = {
  setMorph(value: number): void;
  setOpacity(value: number): void;
  setActive(active: boolean): void;
  resize(): void;
  dispose(): void;
};

type Options = {
  canvas: HTMLCanvasElement;
  iconUrl: string;
  reducedMotion: boolean;
  onReady?: () => void;
};

const PALETTE = {
  logo: [0.95, 0.94, 1.0],
  logoDeep: [0.66, 0.61, 1.0],
  brand: [0.55, 0.52, 1.0],
  blue: [0.43, 0.66, 1.0],
  teal: [0.31, 0.82, 0.69],
  amber: [0.96, 0.71, 0.38],
  rose: [0.94, 0.48, 0.58],
  dust: [0.36, 0.33, 0.66],
} as const;
const CATEGORY = [PALETTE.rose, PALETTE.blue, PALETTE.teal, PALETTE.amber, PALETTE.brand];

const vertexShader = /* glsl */ `
  uniform float uTime;
  uniform float uIntro;
  uniform float uMorph;
  uniform float uPixelRatio;
  uniform float uSize;
  uniform float uOpacity;
  uniform vec3 uPointer;
  uniform float uPointerForce;
  attribute vec3 aScatter;
  attribute vec3 aLogo;
  attribute vec3 aNetwork;
  attribute vec3 aColorA;
  attribute vec3 aColorB;
  attribute vec3 aColorC;
  attribute float aSeed;
  varying vec3 vColor;
  varying float vAlpha;

  mat2 rot(float a) { float c = cos(a); float s = sin(a); return mat2(c, -s, s, c); }
  float easeInOut(float t) { return t < 0.5 ? 4.0 * t * t * t : 1.0 - pow(-2.0 * t + 2.0, 3.0) * 0.5; }

  void main() {
    float introDelay = aSeed * 0.42;
    float ti = easeInOut(clamp((uIntro - introDelay) / 0.58, 0.0, 1.0));
    float morphDelay = (1.0 - aSeed) * 0.35;
    float tm = easeInOut(clamp((uMorph - morphDelay) / 0.65, 0.0, 1.0));

    vec3 scatter = aScatter;
    scatter.xz = rot(uTime * 0.025 + aSeed * 0.08) * scatter.xz;
    scatter.y += sin(uTime * 0.6 + aSeed * 6.2831) * 0.12;

    vec3 logo = aLogo;
    logo.z += sin(uTime * 1.3 + aLogo.x * 1.7 + aLogo.y * 1.1) * 0.045;

    vec3 network = aNetwork;
    network.xz = rot(uTime * 0.11) * network.xz;
    network.yz = rot(0.38) * network.yz;

    vec3 p = mix(scatter, logo, ti);
    p = mix(p, network, tm);

    float turbulence = sin(3.14159 * ti) * (1.0 - tm) + sin(3.14159 * tm) * 0.9;
    p += vec3(
      sin(uTime * 1.3 + aSeed * 41.0),
      cos(uTime * 1.1 + aSeed * 29.0),
      sin(uTime * 0.9 + aSeed * 17.0)
    ) * 0.32 * turbulence;

    // Pointer "torchlight": a small soft patch lifts toward the viewer and
    // brightens. Nothing is pushed away, so the glyph never opens a hole.
    vec2 away = p.xy - uPointer.xy;
    float glow = exp(-dot(away, away) / 0.09) * uPointerForce * ti * (1.0 - tm);
    p.z += glow * 0.42;
    p.xy += normalize(away + 1e-4) * glow * 0.035;

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    float size = uSize * (0.55 + aSeed * 0.9) * (1.0 + glow * 0.75);
    gl_PointSize = size * uPixelRatio * (10.0 / -mv.z);

    vec3 color = mix(aColorA, aColorB, ti);
    color = mix(color, aColorC, tm);
    vColor = color + glow * vec3(0.32, 0.28, 0.45);
    float twinkle = 0.75 + 0.25 * sin(uTime * 2.0 + aSeed * 60.0);
    vAlpha =
      uOpacity * (0.45 + 0.55 * aSeed) * mix(twinkle, 1.0, ti * (1.0 - tm)) * (1.0 + glow * 0.9);
  }
`;

const fragmentShader = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c);
    float core = smoothstep(0.5, 0.0, d);
    float alpha = pow(core, 1.7) * vAlpha;
    if (alpha < 0.004) discard;
    gl_FragColor = vec4(vColor, alpha);
  }
`;

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function sampleGlyph(url: string): Promise<{ inner: Float32Array; edge: Float32Array }> {
  const image = new Image();
  image.decoding = "async";
  image.src = url;
  await image.decode();
  const size = 192;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("2d context unavailable");
  context.drawImage(image, 0, 0, size, size);
  const { data } = context.getImageData(0, 0, size, size);
  const isGlyph = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return false;
    const i = (y * size + x) * 4;
    return data[i] > 215 && data[i + 1] > 215 && data[i + 2] > 215 && data[i + 3] > 200;
  };
  const inner: number[] = [];
  const edge: number[] = [];
  let minX = size,
    maxX = 0,
    minY = size,
    maxY = 0;
  for (let y = 0; y < size; y += 1)
    for (let x = 0; x < size; x += 1) {
      if (!isGlyph(x, y)) continue;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      const border =
        !isGlyph(x + 1, y) || !isGlyph(x - 1, y) || !isGlyph(x, y + 1) || !isGlyph(x, y - 1);
      (border ? edge : inner).push(x, y);
    }
  if (!inner.length) throw new Error("glyph not found");
  // Normalise to a glyph 3.7 world units tall, centred on the origin.
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const scale = 3.7 / (maxY - minY);
  const normalise = (list: number[]) => {
    const out = new Float32Array(list.length);
    for (let i = 0; i < list.length; i += 2) {
      out[i] = (list[i] - cx) * scale;
      out[i + 1] = -(list[i + 1] - cy) * scale;
    }
    return out;
  };
  return { inner: normalise(inner), edge: normalise(edge) };
}

function buildNetwork(random: () => number) {
  const nodeCount = 72;
  const radius = 2.75;
  const nodes: [number, number, number][] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < nodeCount; i += 1) {
    const y = 1 - (i / (nodeCount - 1)) * 2;
    const r = Math.sqrt(1 - y * y);
    const theta = golden * i;
    const jitter = 1 + (random() - 0.5) * 0.12;
    nodes.push([
      Math.cos(theta) * r * radius * jitter,
      y * radius * jitter,
      Math.sin(theta) * r * radius * jitter,
    ]);
  }
  const edges: [number, number][] = [];
  nodes.forEach((a, i) => {
    const nearest = nodes
      .map((b, j) => ({ j, d: (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2 }))
      .filter(({ j }) => j !== i)
      .sort((p, q) => p.d - q.d)
      .slice(0, 3);
    for (const { j } of nearest)
      if (i < j || !edges.some(([x, y]) => x === j && y === i)) edges.push([i, j]);
  });
  return { nodes, edges, radius };
}

export async function createHeroScene(options: Options): Promise<HeroScene | null> {
  const { canvas, reducedMotion } = options;

  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({
      canvas,
      antialias: false,
      alpha: true,
      powerPreference: "high-performance",
    });
  } catch {
    return null;
  }
  const glyph = await sampleGlyph(options.iconUrl).catch(() => null);
  if (!glyph) {
    renderer.dispose();
    return null;
  }

  const narrow = window.innerWidth < 760;
  const cores = navigator.hardwareConcurrency || 4;
  const budget = narrow ? 7000 : 15000;
  const count = Math.round(budget * (cores <= 4 ? 0.65 : 1));
  const random = mulberry32(20260924);

  const scatter = new Float32Array(count * 3);
  const logo = new Float32Array(count * 3);
  const network = new Float32Array(count * 3);
  const colorA = new Float32Array(count * 3);
  const colorB = new Float32Array(count * 3);
  const colorC = new Float32Array(count * 3);
  const seeds = new Float32Array(count);

  // Scatter layout: small rectangular "pages" with text lines, plus drifting dust.
  const pages = Array.from({ length: 44 }, () => {
    let x = 0,
      y = 0,
      z = 0;
    do {
      x = (random() - 0.5) * 19;
      y = (random() - 0.5) * 10;
      z = -7 + random() * 9;
    } while (Math.abs(x) < 2.6 && Math.abs(y) < 2.2 && z > -3);
    return {
      x,
      y,
      z,
      w: 0.5 + random() * 0.35,
      h: 0.66 + random() * 0.4,
      rz: (random() - 0.5) * 1.2,
      ry: (random() - 0.5) * 1.4,
      color: CATEGORY[Math.floor(random() * CATEGORY.length)],
    };
  });
  const { nodes, edges, radius } = buildNetwork(random);
  const set = (target: Float32Array, i: number, x: number, y: number, z: number) => {
    target[i * 3] = x;
    target[i * 3 + 1] = y;
    target[i * 3 + 2] = z;
  };
  const setColor = (target: Float32Array, i: number, color: readonly number[], shade = 1) =>
    set(target, i, color[0] * shade, color[1] * shade, color[2] * shade);

  for (let i = 0; i < count; i += 1) {
    seeds[i] = random();

    if (random() < 0.74) {
      const page = pages[Math.floor(random() * pages.length)];
      const line = Math.floor(random() * 7);
      const onLine = random() < 0.8;
      const u = (random() - 0.5) * page.w * (onLine && line === 0 ? 0.55 : 1);
      const v = onLine ? page.h / 2 - 0.1 - line * (page.h / 7.5) : (random() - 0.5) * page.h;
      const cz = Math.cos(page.rz),
        sz = Math.sin(page.rz);
      const lx = u * cz - v * sz;
      const ly = u * sz + v * cz;
      const cy = Math.cos(page.ry),
        sy = Math.sin(page.ry);
      set(scatter, i, page.x + lx * cy, page.y + ly, page.z + lx * sy);
      setColor(colorA, i, page.color, onLine ? 1 : 0.6);
    } else {
      const r = 5 + random() * 8;
      const t = random() * Math.PI * 2;
      const p = Math.acos(2 * random() - 1);
      set(
        scatter,
        i,
        r * Math.sin(p) * Math.cos(t),
        r * Math.cos(p) * 0.6,
        r * Math.sin(p) * Math.sin(t) - 3,
      );
      setColor(colorA, i, PALETTE.dust);
    }

    const useEdge = random() < 0.34;
    const source = useEdge ? glyph.edge : glyph.inner;
    const k = Math.floor(random() * (source.length / 2)) * 2;
    const jitter = 0.018;
    set(
      logo,
      i,
      source[k] + (random() - 0.5) * jitter * 2,
      source[k + 1] + (random() - 0.5) * jitter * 2,
      (random() - 0.5) * (useEdge ? 0.08 : 0.3),
    );
    setColor(colorB, i, random() < 0.72 ? PALETTE.logo : PALETTE.logoDeep);

    const roll = random();
    if (roll < 0.26) {
      const n = Math.floor(random() * nodes.length);
      const node = nodes[n];
      const g = () => (random() + random() + random() - 1.5) * 0.09;
      set(network, i, node[0] + g(), node[1] + g(), node[2] + g());
      setColor(colorC, i, CATEGORY[n % CATEGORY.length], 1.05);
    } else if (roll < 0.82) {
      const [a, b] = edges[Math.floor(random() * edges.length)];
      const t = random();
      const x = nodes[a][0] + (nodes[b][0] - nodes[a][0]) * t;
      const y = nodes[a][1] + (nodes[b][1] - nodes[a][1]) * t;
      const z = nodes[a][2] + (nodes[b][2] - nodes[a][2]) * t;
      const len = Math.hypot(x, y, z) || 1;
      const arc = radius * (1 + Math.sin(Math.PI * t) * 0.06);
      set(network, i, (x / len) * arc, (y / len) * arc, (z / len) * arc);
      setColor(colorC, i, PALETTE.brand, 0.75 + random() * 0.35);
    } else {
      const t = random() * Math.PI * 2;
      const p = Math.acos(2 * random() - 1);
      const r = radius * (0.35 + random() * 0.6);
      set(
        network,
        i,
        r * Math.sin(p) * Math.cos(t),
        r * Math.cos(p),
        r * Math.sin(p) * Math.sin(t),
      );
      setColor(colorC, i, PALETTE.dust, 1.2);
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(logo, 3));
  geometry.setAttribute("aScatter", new BufferAttribute(scatter, 3));
  geometry.setAttribute("aLogo", new BufferAttribute(logo, 3));
  geometry.setAttribute("aNetwork", new BufferAttribute(network, 3));
  geometry.setAttribute("aColorA", new BufferAttribute(colorA, 3));
  geometry.setAttribute("aColorB", new BufferAttribute(colorB, 3));
  geometry.setAttribute("aColorC", new BufferAttribute(colorC, 3));
  geometry.setAttribute("aSeed", new BufferAttribute(seeds, 1));
  geometry.boundingSphere = new Sphere(new Vector3(), 20);

  const pixelRatio = Math.min(window.devicePixelRatio || 1, narrow ? 1.75 : 2);
  const material = new ShaderMaterial({
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uIntro: { value: reducedMotion ? 1 : 0 },
      uMorph: { value: 0 },
      uPixelRatio: { value: pixelRatio },
      uSize: { value: narrow ? 5.2 : 4.6 },
      uOpacity: { value: 0 },
      uPointer: { value: new Vector3(99, 99, 0) },
      uPointerForce: { value: 0 },
    },
  });

  const points = new Points(geometry, material);
  const group = new Group();
  group.add(points);
  const scene = new Scene();
  scene.add(group);
  const camera = new PerspectiveCamera(35, 1, 0.1, 100);
  camera.position.set(0, 0, 10);

  renderer.setPixelRatio(pixelRatio);
  renderer.setClearColor(0x000000, 0);

  const pointer = { x: 0, y: 0, tx: 0, ty: 0, inside: false, force: 0 };
  const layout = { baseX: 0, baseY: 0, baseScale: 1, halfW: 1, halfH: 1 };
  let morph = 0;
  let externalOpacity = 1;
  let active = true;
  let frame = 0;
  let disposed = false;
  const startedAt = performance.now();

  function resize() {
    const width = canvas.clientWidth || window.innerWidth;
    const height = canvas.clientHeight || window.innerHeight;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    layout.halfH = Math.tan((camera.fov * Math.PI) / 360) * camera.position.z;
    layout.halfW = layout.halfH * camera.aspect;
    const wide = width >= 960;
    if (wide) {
      layout.baseScale = Math.min(1, (layout.halfW * 0.42) / 1.9);
      layout.baseX = layout.halfW * 0.44;
      layout.baseY = -0.1;
    } else {
      layout.baseScale = Math.min(0.62, (layout.halfW * 0.72) / 1.9, (layout.halfH * 0.36) / 1.85);
      layout.baseX = 0;
      layout.baseY = layout.halfH * 0.5;
    }
    if (reducedMotion) render(performance.now());
  }

  function render(now: number) {
    const elapsed = (now - startedAt) / 1000;
    const uniforms = material.uniforms;
    uniforms.uTime.value = reducedMotion ? 4 : elapsed;
    if (!reducedMotion) uniforms.uIntro.value = Math.min(1, Math.max(0, (elapsed - 0.15) / 2.9));
    const fadeIn = reducedMotion ? 1 : Math.min(1, elapsed / 0.9);
    uniforms.uOpacity.value = fadeIn * externalOpacity;
    uniforms.uMorph.value = morph;

    // Ease the logo toward the centre as it opens into the network.
    const eased = morph * morph * (3 - 2 * morph);
    const networkScale = Math.min(1.15, (Math.min(layout.halfW, layout.halfH) * 0.78) / 2.9);
    group.position.x = layout.baseX * (1 - eased);
    group.position.y = layout.baseY * (1 - eased);
    const scale = layout.baseScale + (networkScale - layout.baseScale) * eased;
    group.scale.setScalar(scale);

    pointer.x += (pointer.tx - pointer.x) * 0.08;
    pointer.y += (pointer.ty - pointer.y) * 0.08;
    pointer.force += ((pointer.inside ? 1 : 0) - pointer.force) * 0.06;
    // A gentle 3D tilt toward the pointer.
    group.rotation.y = pointer.x * 0.26 * (1 - eased);
    group.rotation.x = -pointer.y * 0.16 * (1 - eased);
    const worldX = pointer.x * layout.halfW;
    const worldY = pointer.y * layout.halfH;
    uniforms.uPointer.value.set(
      (worldX - group.position.x) / scale,
      (worldY - group.position.y) / scale,
      0,
    );
    uniforms.uPointerForce.value = reducedMotion ? 0 : pointer.force;

    renderer.render(scene, camera);
  }

  function loop(now: number) {
    if (disposed) return;
    render(now);
    frame = active ? requestAnimationFrame(loop) : 0;
  }

  function onPointerMove(event: PointerEvent) {
    if (event.pointerType === "touch") return;
    const rect = canvas.getBoundingClientRect();
    pointer.tx = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.ty = -(((event.clientY - rect.top) / rect.height) * 2 - 1);
    pointer.inside = event.clientY >= rect.top && event.clientY <= rect.bottom;
  }
  function onPointerLeave() {
    pointer.inside = false;
  }
  function onVisibility() {
    if (document.hidden) {
      cancelAnimationFrame(frame);
      frame = 0;
    } else if (active && !frame && !reducedMotion) frame = requestAnimationFrame(loop);
  }

  window.addEventListener("pointermove", onPointerMove, { passive: true });
  document.documentElement.addEventListener("pointerleave", onPointerLeave);
  document.addEventListener("visibilitychange", onVisibility);
  resize();
  if (reducedMotion) render(performance.now());
  else frame = requestAnimationFrame(loop);
  options.onReady?.();

  return {
    setMorph(value) {
      morph = Math.min(1, Math.max(0, value));
      if (reducedMotion) render(performance.now());
    },
    setOpacity(value) {
      externalOpacity = value;
      if (reducedMotion) render(performance.now());
    },
    setActive(next) {
      active = next;
      if (reducedMotion) return;
      if (next && !frame && !document.hidden) frame = requestAnimationFrame(loop);
      if (!next && frame) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
    },
    resize,
    dispose() {
      disposed = true;
      cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", onPointerMove);
      document.documentElement.removeEventListener("pointerleave", onPointerLeave);
      document.removeEventListener("visibilitychange", onVisibility);
      geometry.dispose();
      material.dispose();
      renderer.dispose();
    },
  };
}
