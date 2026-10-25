import * as THREE from 'three';
import type { SceneContext, SceneDefinition, SceneInstance } from '../types.js';
import { disposeObject } from '../../core/loader.js';
import { ParticleSpace, wrapParticleField } from '../../core/particle-space.js';
import { createMoteField, updateMoteScale } from './lib/mote-field.js';
import { createCloudTexture, createRadialTexture } from './lib/scene-kit.js';

/**
 * 琉璃彩窗
 *
 * 铅条把一扇拱窗切成上百片不规则的彩色玻璃，碎片之间露出深色铅条。
 * 阳光从窗外斜射进来：窗洞在石墙上投下真正的光斑，地上再叠一层按碎片
 * 颜色算出的色斑，空气里飘着缓慢下沉的尘埃。
 */

/* ------------------------------------------------------------------ *
 * 常量
 * ------------------------------------------------------------------ */

const FOV = 50;

/** 窗洞尺寸（米）。 */
const WINDOW_W = 2.6;
const WINDOW_BOTTOM = 0.55;
const WINDOW_SPRING = 2.15;
const WINDOW_TOP = 3.15;
const WINDOW_Z = -2.4;

/** 铅条宽度。 */
const LEAD_GAP = 0.028;

/** 房间尺寸。 */
const ROOM_HALF_W = 2.8;
const ROOM_FRONT_Z = 5.4;
const ROOM_HEIGHT = 4.4;

/** 阳光的传播方向（从窗外射进房间）。 */
const SUN_DIR = new THREE.Vector3(0.26, -0.7, 0.66).normalize();

/** 碎片的调色板：中心玫瑰偏暖，外圈偏冷。 */
const ROSE_PALETTE = [0xd9452c, 0xe3a63c, 0xa8232f, 0xf0c268, 0xc7394a];
const WARM_PALETTE = [0xc8452c, 0xd9962f, 0xe0b53e, 0xb8342f, 0xd86a3a];
const COOL_PALETTE = [0x27408f, 0x2a5fb4, 0x2f7f9c, 0x5a3a86, 0x1f7a52];

/* ------------------------------------------------------------------ *
 * 二维多边形工具
 * ------------------------------------------------------------------ */

/** 顶点坐标。 */
type Pt = [number, number];

function clipHalfPlane(poly: Pt[], nx: number, ny: number, c: number): Pt[] {
  if (poly.length === 0) return poly;
  const out: Pt[] = [];
  for (let i = 0; i < poly.length; i += 1) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const da = nx * a[0] + ny * a[1] - c;
    const db = nx * b[0] + ny * b[1] - c;
    const aIn = da <= 0;
    const bIn = db <= 0;
    if (aIn) out.push(a);
    if (aIn !== bIn) {
      const t = da / (da - db);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

/**
 * 凸多边形的等距偏移。
 * d > 0 向外扩（外框），d < 0 向内收（铅条留出的缝隙）。
 */
function offsetConvex(poly: Pt[], d: number): Pt[] {
  let out = poly;
  for (let i = 0; i < poly.length && out.length > 0; i += 1) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];
    const len = Math.hypot(ex, ey);
    if (len < 1e-6) continue;
    // 逆时针多边形：左法线指向内部
    const nx = -ey / len;
    const ny = ex / len;
    // 保留 dot(n, p) >= dot(n, a) - d 的一侧
    out = clipHalfPlane(out, -nx, -ny, -(nx * a[0] + ny * a[1]) + d);
  }
  return out;
}

/** 拱形窗洞的轮廓（逆时针）。 */
function createWindowOutline(): Pt[] {
  const half = WINDOW_W / 2;
  const pts: Pt[] = [
    [-half, WINDOW_BOTTOM],
    [half, WINDOW_BOTTOM],
    [half, WINDOW_SPRING],
  ];
  const segments = 24;
  for (let i = 1; i < segments; i += 1) {
    const t = (i / segments) * Math.PI;
    pts.push([
      half * Math.cos(t),
      WINDOW_SPRING + (WINDOW_TOP - WINDOW_SPRING) * Math.sin(t),
    ]);
  }
  pts.push([-half, WINDOW_SPRING]);
  return pts;
}

/** 抖动网格取点，让碎片大小不致太整齐。 */
function createSeeds(cols: number, rows: number, random: () => number): Pt[] {
  const seeds: Pt[] = [];
  const w = WINDOW_W;
  const h = WINDOW_TOP - WINDOW_BOTTOM;
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const x = -w / 2 + (w * (c + 0.5)) / cols + (random() - 0.5) * (w / cols) * 0.72;
      const y =
        WINDOW_BOTTOM + (h * (r + 0.5)) / rows + (random() - 0.5) * (h / rows) * 0.72;
      seeds.push([x, y]);
    }
  }
  return seeds;
}

/** 用半平面裁剪得到每个种子的 Voronoi 胞元。 */
function buildCells(outline: Pt[], seeds: Pt[]): Pt[][] {
  const cells: Pt[][] = [];
  for (let i = 0; i < seeds.length; i += 1) {
    let poly = outline;
    const [sx, sy] = seeds[i];
    for (let j = 0; j < seeds.length && poly.length > 0; j += 1) {
      if (i === j) continue;
      const [ox, oy] = seeds[j];
      const dx = ox - sx;
      const dy = oy - sy;
      const mx = (sx + ox) * 0.5;
      const my = (sy + oy) * 0.5;
      // 离 i 更近的一侧：dot(p - mid, oj - si) <= 0
      poly = clipHalfPlane(poly, dx, dy, dx * mx + dy * my);
    }
    cells.push(poly);
  }
  return cells;
}

/** 沿阳光方向把窗上的碎片投影到地面（返回 xz 坐标）。 */
function projectToFloor(poly: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const [x, y] of poly) {
    const t = -y / SUN_DIR.y;
    out.push([x + SUN_DIR.x * t, WINDOW_Z + SUN_DIR.z * t]);
  }
  return out;
}

/** 把地面上的多边形裁进房间地板范围。 */
function clipToFloor(poly: Pt[]): Pt[] {
  let out = poly;
  out = clipHalfPlane(out, -1, 0, -(-ROOM_HALF_W + 0.05));
  out = clipHalfPlane(out, 1, 0, ROOM_HALF_W - 0.05);
  out = clipHalfPlane(out, 0, -1, -(WINDOW_Z + 0.05));
  out = clipHalfPlane(out, 0, 1, ROOM_FRONT_Z - 0.05);
  return out;
}

/* ------------------------------------------------------------------ *
 * 地面色斑
 * ------------------------------------------------------------------ */

interface PatchBuffer {
  positions: number[];
  colors: number[];
  uvs: number[];
}

function createPatchBuffer(): PatchBuffer {
  return { positions: [], colors: [], uvs: [] };
}

function pushTriangle(
  buffer: PatchBuffer,
  a: Pt,
  b: Pt,
  c: Pt,
  color: THREE.Color,
  gain: number,
  y: number,
): void {
  const tri = [a, b, c];
  for (const p of tri) {
    buffer.positions.push(p[0], y, p[1]);
    buffer.colors.push(color.r * gain, color.g * gain, color.b * gain);
    buffer.uvs.push(p[0] * 0.22 + 0.5, p[1] * 0.22 + 0.5);
  }
}

/** 扇形三角化一个凸多边形。 */
function pushPolygon(
  buffer: PatchBuffer,
  poly: Pt[],
  color: THREE.Color,
  gain: number,
  y: number,
): void {
  for (let i = 1; i < poly.length - 1; i += 1) {
    pushTriangle(buffer, poly[0], poly[i], poly[i + 1], color, gain, y);
  }
}

function buildPatchGeometry(buffer: PatchBuffer): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(buffer.positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(buffer.colors, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(buffer.uvs, 2));
  geometry.computeBoundingSphere();
  return geometry;
}

/* ------------------------------------------------------------------ *
 * 场景
 * ------------------------------------------------------------------ */

function createStainedGlass(ctx: SceneContext): SceneInstance {
  const root = new THREE.Group();
  root.name = 'stainedglass-scene';

  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.05, 60);
  camera.position.set(0, 1.5, 2.5);
  camera.lookAt(0, 1.55, WINDOW_Z);

  const quality = THREE.MathUtils.clamp(ctx.quality, 0.4, 2);
  let state = 0x51ed270b;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };

  /** 需要单独释放的自建贴图。 */
  const ownTextures: THREE.Texture[] = [];

  /* ---------------- 房间 ---------------- */

  const wallMaterial = new THREE.MeshStandardMaterial({
    color: 0x342d25,
    roughness: 0.94,
    metalness: 0.02,
    side: THREE.DoubleSide,
  });
  wallMaterial.envMap = ctx.env.envMap;
  wallMaterial.envMapIntensity = 0.3;

  const outline = createWindowOutline();

  // 后墙：带窗洞的整面墙（用 Shape 的孔洞挖出窗口）
  const wallShape = new THREE.Shape([
    new THREE.Vector2(-ROOM_HALF_W, 0),
    new THREE.Vector2(ROOM_HALF_W, 0),
    new THREE.Vector2(ROOM_HALF_W, ROOM_HEIGHT),
    new THREE.Vector2(-ROOM_HALF_W, ROOM_HEIGHT),
  ]);
  wallShape.holes.push(
    new THREE.Path(
      outline
        .slice()
        .reverse()
        .map(([x, y]) => new THREE.Vector2(x, y)),
    ),
  );
  const backWall = new THREE.Mesh(new THREE.ShapeGeometry(wallShape), wallMaterial);
  backWall.name = 'back-wall';
  backWall.position.z = WINDOW_Z - 0.12;
  backWall.castShadow = true;
  backWall.receiveShadow = true;
  root.add(backWall);

  const sideGeometry = new THREE.PlaneGeometry(ROOM_FRONT_Z - WINDOW_Z, ROOM_HEIGHT);
  for (const side of [-1, 1]) {
    const wall = new THREE.Mesh(sideGeometry, wallMaterial);
    wall.name = side < 0 ? 'left-wall' : 'right-wall';
    wall.position.set(side * ROOM_HALF_W, ROOM_HEIGHT / 2, (WINDOW_Z + ROOM_FRONT_Z) / 2);
    wall.rotation.y = side < 0 ? Math.PI / 2 : -Math.PI / 2;
    wall.receiveShadow = true;
    root.add(wall);
  }

  const ground = ctx.env.createGround(18) as THREE.Mesh;
  const groundMaterial = new THREE.MeshStandardMaterial({
    color: 0x1d1915,
    roughness: 0.9,
    metalness: 0.02,
  });
  groundMaterial.envMap = ctx.env.envMap;
  groundMaterial.envMapIntensity = 0.1;
  const previousGroundMaterial = ground.material;
  ground.material = groundMaterial;
  if (Array.isArray(previousGroundMaterial)) previousGroundMaterial.forEach((m) => m.dispose());
  else previousGroundMaterial.dispose();
  root.add(ground);

  /* ---------------- 窗框与铅条 ---------------- */

  const leadMaterial = new THREE.MeshStandardMaterial({
    color: 0x16130f,
    roughness: 0.62,
    metalness: 0.45,
  });
  leadMaterial.envMap = ctx.env.envMap;
  leadMaterial.envMapIntensity = 0.25;

  // 窗洞后面的深色底板：碎片之间的缝隙露出的就是它
  const backingShape = new THREE.Shape(outline.map(([x, y]) => new THREE.Vector2(x, y)));
  const backing = new THREE.Mesh(new THREE.ShapeGeometry(backingShape), leadMaterial);
  backing.name = 'window-backing';
  backing.position.z = WINDOW_Z - 0.03;
  backing.castShadow = false;
  root.add(backing);

  // 外框
  const frameOuter = offsetConvex(outline, 0.1);
  const frameShape = new THREE.Shape(frameOuter.map(([x, y]) => new THREE.Vector2(x, y)));
  frameShape.holes.push(
    new THREE.Path(outline.slice().reverse().map(([x, y]) => new THREE.Vector2(x, y))),
  );
  const frame = new THREE.Mesh(
    new THREE.ExtrudeGeometry(frameShape, {
      depth: 0.09,
      bevelEnabled: true,
      bevelSize: 0.014,
      bevelThickness: 0.014,
      bevelSegments: 2,
      curveSegments: 1,
    }),
    leadMaterial,
  );
  frame.name = 'window-frame';
  frame.position.z = WINDOW_Z - 0.02;
  frame.castShadow = true;
  frame.receiveShadow = true;
  root.add(frame);

  /* ---------------- 彩色玻璃碎片 ---------------- */

  const seeds = createSeeds(7, 9, random);
  const cells = buildCells(outline, seeds);
  const patchBuffer = createPatchBuffer();
  const haloBuffer = createPatchBuffer();

  for (const cell of cells) {
    if (cell.length < 3) continue;
    const glass = offsetConvex(cell, -LEAD_GAP * 0.5);
    if (glass.length < 3) continue;

    let cx = 0;
    let cy = 0;
    for (const [x, y] of glass) {
      cx += x / glass.length;
      cy += y / glass.length;
    }

    // 离窗心越近越暖（中心的玫瑰），外圈转冷
    const dx = cx / (WINDOW_W * 0.5);
    const dy = (cy - 1.9) / ((WINDOW_TOP - WINDOW_BOTTOM) * 0.5);
    const dist = Math.min(1, Math.hypot(dx, dy));
    const palette = dist < 0.34 ? ROSE_PALETTE : dist < 0.68 ? WARM_PALETTE : COOL_PALETTE;
    const hex = palette[Math.floor(random() * palette.length)];
    const color = new THREE.Color(hex);

    const material = new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      roughness: 0.16,
      metalness: 0,
      transparent: true,
      opacity: 0.92,
      emissive: 0xffffff,
      emissiveIntensity: 0.36 + random() * 0.22,
      clearcoat: 0.65,
      clearcoatRoughness: 0.14,
      side: THREE.DoubleSide,
      vertexColors: true,
      envMap: ctx.env.envMap,
      // 室内侧几乎不反射环境，否则顶部的碎片会被影棚的天花板洗白
      envMapIntensity: 0.08,
    });
    // 自发光也要带上碎片自己的颜色与明暗
    material.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\n\ttotalEmissiveRadiance *= vColor.rgb;',
      );
    };

    const geometry = new THREE.ExtrudeGeometry(
      new THREE.Shape(glass.map(([x, y]) => new THREE.Vector2(x, y))),
      { depth: 0.016, bevelEnabled: false, curveSegments: 1 },
    );
    // 顶点色：以碎片中心为亮点，靠近铅条处压暗，玻璃才有厚度感
    const position = geometry.getAttribute('position') as THREE.BufferAttribute;
    const shadeColors = new Float32Array(position.count * 3);
    let glassRadius = 0.001;
    for (const [x, y] of glass) {
      glassRadius = Math.max(glassRadius, Math.hypot(x - cx, y - cy));
    }
    for (let i = 0; i < position.count; i += 1) {
      const d = Math.min(
        1,
        Math.hypot(position.getX(i) - cx, position.getY(i) - cy) / Math.max(glassRadius, 0.001),
      );
      const shade = THREE.MathUtils.lerp(1.05, 0.42, d * d);
      shadeColors[i * 3] = color.r * shade;
      shadeColors[i * 3 + 1] = color.g * shade;
      shadeColors[i * 3 + 2] = color.b * shade;
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(shadeColors, 3));

    const shard = new THREE.Mesh(geometry, material);
    shard.name = 'glass-shard';
    shard.position.z = WINDOW_Z + (random() - 0.5) * 0.006;
    shard.castShadow = false;
    shard.receiveShadow = false;
    root.add(shard);

    // 地面上的彩色光斑：碎片沿阳光方向投下去的形状
    const projected = clipToFloor(projectToFloor(glass));
    if (projected.length >= 3) {
      const gain = (0.7 + random() * 0.26) * 0.72;
      const patchColor = color.clone().lerp(new THREE.Color(0xfff3e0), 0.12);
      pushPolygon(patchBuffer, projected, patchColor, gain, 0.012);

      // 柔化外缘：把多边形绕自身中心放大一圈做光晕
      let mx = 0;
      let mz = 0;
      for (const [x, z] of projected) {
        mx += x / projected.length;
        mz += z / projected.length;
      }
      const halo = projected.map(
        ([x, z]) => [mx + (x - mx) * 1.32, mz + (z - mz) * 1.32] as Pt,
      );
      pushPolygon(haloBuffer, halo, patchColor, gain * 0.3, 0.008);
    }
  }

  // 结构铅条：横竖各两道，压在碎片上方
  const barGeometry = new THREE.BoxGeometry(1, 0.024, 0.022);
  for (const y of [1.35, WINDOW_SPRING]) {
    const bar = new THREE.Mesh(barGeometry, leadMaterial);
    bar.name = 'lead-bar';
    bar.position.set(0, y, WINDOW_Z + 0.022);
    bar.scale.x = WINDOW_W - 0.06;
    bar.castShadow = false;
    root.add(bar);
  }
  const verticalGeometry = new THREE.BoxGeometry(0.024, 1, 0.022);
  for (const x of [-0.64, 0.64]) {
    const bar = new THREE.Mesh(verticalGeometry, leadMaterial);
    bar.name = 'lead-bar';
    bar.position.set(x, (WINDOW_BOTTOM + WINDOW_SPRING) / 2, WINDOW_Z + 0.022);
    bar.scale.y = WINDOW_SPRING - WINDOW_BOTTOM;
    bar.castShadow = false;
    root.add(bar);
  }

  /* ---------------- 地面的彩色光斑 ---------------- */

  const cloudTexture = createCloudTexture(256);
  ownTextures.push(cloudTexture);

  const patchMaterial = new THREE.MeshBasicMaterial({
    map: cloudTexture,
    vertexColors: true,
    transparent: true,
    opacity: 0.8,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    toneMapped: true,
  });
  const patches = new THREE.Mesh(buildPatchGeometry(patchBuffer), patchMaterial);
  patches.name = 'floor-patches';
  patches.renderOrder = 2;
  root.add(patches);

  const haloMaterial = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.5,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  const halos = new THREE.Mesh(buildPatchGeometry(haloBuffer), haloMaterial);
  halos.name = 'floor-halos';
  halos.renderOrder = 1;
  root.add(halos);

  /* ---------------- 窗外的阳光 ---------------- */

  const sunTarget = new THREE.Vector3(0.6, 0.2, -0.6);
  const sun = new THREE.DirectionalLight(0xffe3b0, 2.3);
  sun.name = 'sunlight';
  sun.position.copy(sunTarget).addScaledVector(SUN_DIR, -11);
  sun.target.position.copy(sunTarget);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 2;
  sun.shadow.camera.far = 26;
  sun.shadow.camera.left = -5;
  sun.shadow.camera.right = 5;
  sun.shadow.camera.top = 5;
  sun.shadow.camera.bottom = -5;
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.02;
  root.add(sun);
  root.add(sun.target);

  // 窗口边缘溢出的暖光
  const glowTexture = createRadialTexture(128, 2.4);
  ownTextures.push(glowTexture);
  const glowMaterial = new THREE.MeshBasicMaterial({
    map: glowTexture,
    color: 0xffcf8a,
    transparent: true,
    opacity: 0.5,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const glow = new THREE.Mesh(new THREE.PlaneGeometry(3.9, 3.5), glowMaterial);
  glow.name = 'window-glow';
  glow.position.set(0, 1.85, WINDOW_Z - 0.09);
  glow.renderOrder = 0;
  root.add(glow);

  const lights = ctx.env.createStudioLights();
  lights.traverse((child) => {
    if (child instanceof THREE.Light) {
      child.intensity *= 0.26;
      child.castShadow = false;
    }
  });
  root.add(lights);

  // 窗口溢出的暖光，压在窗台高度照亮窗前的地
  const spill = new THREE.PointLight(0xffc98a, 0.9, 4.5, 2);
  spill.name = 'window-spill';
  spill.position.set(0, 0.75, WINDOW_Z + 0.7);
  root.add(spill);

  /* ---------------- 光柱里的尘埃 ---------------- */

  const space = new ParticleSpace({
    radius: 1.5,
    spin: 0.008,
    tilt: 0.25,
    position: [0.35, 0.95, -1.3],
  });
  const dust = createMoteField(space, Math.floor(600 * quality), {
    size: 0.024,
    color: new THREE.Color(0xffe0ae),
    core: new THREE.Color(0xfff6e2),
    opacity: 0.38,
    seed: 33217,
    mode: 'dust',
    wander: 0.09,
    falloff: 1.35,
  });
  root.add(dust.points);

  /* ---------------- 相机漂移 ---------------- */

  let driftBase = 0;
  let lastCameraX = Number.NaN;

  return {
    root,
    camera,
    immersive: false,
    xrDistance: 2.5,
    framing: { distance: 2.5, height: 1.5, targetY: 1.55, width: 4.2 },

    update(time: number, delta: number, sceneCtx: SceneContext): void {
      space.breathe = 1 + Math.sin(time * 0.14) * 0.07;
      space.update(delta, time);
      wrapParticleField(dust.points, space.radius, delta, 0.012);
      dust.uniforms.uTime.value = time;
      updateMoteScale(dust.uniforms, sceneCtx, FOV);

      // 光斑随太阳角度极缓慢地游移
      const sway = Math.sin(time * 0.05) * 0.04;
      patches.position.x = sway;
      halos.position.x = sway;
      patches.position.z = sway * 0.4;
      halos.position.z = sway * 0.4;
      glowMaterial.opacity = 0.28 + Math.sin(time * 0.11) * 0.05;

      // 核心层负责摆位，这里只叠加一点极慢的横移
      if (sceneCtx.isXR) return;
      if (!Number.isFinite(lastCameraX) || Math.abs(camera.position.x - lastCameraX) > 0.0005) {
        driftBase = camera.position.x;
      }
      camera.position.x = driftBase + Math.sin(time * 0.055) * 0.26;
      lastCameraX = camera.position.x;
    },

    dispose(): void {
      ownTextures.forEach((texture) => texture.dispose());
      disposeObject(root);
    },
  };
}

export const stainedglassScene: SceneDefinition = {
  id: 'stainedglass',
  title: '琉璃彩窗',
  subtitle: 'Stained Glass',
  description: '铅条把彩窗切成上百片，阳光斜穿而过，在石地上投下一片摇曳的色斑。',
  tags: ['彩窗', '光斑', '尘埃'],
  accent: '#e8a33c',
  gradient: ['#3a2416', '#0a0a10'],
  category: 'procedural',
  create(ctx: SceneContext): SceneInstance {
    return createStainedGlass(ctx);
  },
};

export default stainedglassScene;
