import * as THREE from 'three';
import { FLIGHT, type FlappyFlight } from './flappy-model.js';
import type { FlightGuidance } from './flappy-guidance.js';

/** 侧视的水平进度映射到纵深，升降映射到世界高度；碰撞仍由同一物理模型决定。 */
export const FLIGHT_SPACE = { height: 3, depth: 6 } as const;

export class FlightCorridor {
  readonly root = new THREE.Group();
  private readonly gates: THREE.Group[] = [];
  private readonly markers: THREE.Group[] = [];
  private readonly opening = new THREE.Group();
  private readonly openingBars: THREE.Mesh[] = [];
  private readonly flightMarker = new THREE.Group();

  constructor(mint: THREE.Material, paleMint: THREE.Material, gold: THREE.Material) {
    this.root.name = 'flappy-first-person-world';
    const { height, depth } = FLIGHT_SPACE;
    const bottom = FLIGHT.bottom * height, top = FLIGHT.top * height;
    const skyGeometry = new THREE.SphereGeometry(100, 40, 24);
    const vertices = skyGeometry.getAttribute('position');
    const colors = new Float32Array(vertices.count * 3);
    const low = new THREE.Color('#9fcdc0'), high = new THREE.Color('#163f59'), color = new THREE.Color();
    for (let i = 0; i < vertices.count; i++) {
      const t = THREE.MathUtils.clamp(vertices.getY(i) / 75, 0, 1);
      color.lerpColors(low, high, t);
      color.toArray(colors, i * 3);
    }
    skyGeometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const sky = new THREE.Mesh(skyGeometry, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, toneMapped: false }));
    sky.frustumCulled = false; this.root.add(sky);
    const sun = new THREE.Mesh(new THREE.SphereGeometry(5, 24, 16), new THREE.MeshBasicMaterial({ color: 0xffdfa0, toneMapped: false }));
    sun.position.set(32, 27, -75); this.root.add(sun);

    const ground = new THREE.Mesh(new THREE.PlaneGeometry(190, 190), new THREE.MeshStandardMaterial({ color: 0x123e43, roughness: 1 }));
    ground.rotation.x = -Math.PI / 2; ground.position.set(0, bottom - 0.13, -35); this.root.add(ground);
    const path = new THREE.Mesh(new THREE.PlaneGeometry(7.8, 160), new THREE.MeshStandardMaterial({ color: 0x123036, roughness: 0.75 }));
    path.rotation.x = -Math.PI / 2; path.position.set(0, bottom - 0.12, -65); this.root.add(path);

    const mountains = new THREE.MeshStandardMaterial({ color: 0x285b54, roughness: 1, flatShading: true });
    for (let i = 0; i < 18; i++) {
      const hill = new THREE.Mesh(new THREE.ConeGeometry(5 + i % 3 * 2, 7 + i % 5 * 2, 6), mountains);
      hill.position.set((i % 2 ? -1 : 1) * (14 + (i % 4) * 5), bottom + 2, -20 - i * 4);
      hill.rotation.y = i * 0.73; this.root.add(hill);
    }
    for (const x of [-3.8, 3.8]) {
      for (const y of [bottom - 0.06, top + 0.08]) {
        const rail = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.045, 160), paleMint);
        rail.position.set(x, y, -65); this.root.add(rail);
      }
    }
    // 固定高度的淡色侧壁刻度，提供升降时的空间参照。
    const grid: number[] = [];
    for (const x of [-3.8, 3.8]) {
      for (let i = 1; i < 4; i++) {
        const y = bottom + (top - bottom) * i / 4;
        grid.push(x, y, 8, x, y, -56);
      }
      for (let z = 8; z >= -56; z -= 8) grid.push(x, bottom, z, x, top, z);
    }
    const gridGeometry = new THREE.BufferGeometry(); gridGeometry.setAttribute('position', new THREE.Float32BufferAttribute(grid, 3));
    this.root.add(new THREE.LineSegments(gridGeometry, new THREE.LineBasicMaterial({ color: 0xc1ead7, transparent: true, opacity: 0.2, depthWrite: false })));

    // 椭圆截面的立体绿管，在中央飞行线上与侧视的碰撞厚度一致。
    const cylinder = new THREE.CylinderGeometry(1, 1, 1, 32, 1, true);
    const cap = new THREE.CylinderGeometry(1, 1, 1, 32);
    const pipeMaterial = (mint as THREE.MeshStandardMaterial).clone(); pipeMaterial.color.set(0x1b5143);
    const capMaterial = (paleMint as THREE.MeshStandardMaterial).clone(); capMaterial.color.set(0x619a76);
    for (let i = 0; i < 4; i++) {
      const gate = new THREE.Group(); gate.name = `flappy-flight-gate-${i}`;
      for (let j = 0; j < 4; j++) {
        const mesh = new THREE.Mesh(j < 2 ? cylinder : cap, j < 2 ? pipeMaterial : capMaterial);
        mesh.scale.x = j < 2 ? 3.6 : 3.8;
        mesh.scale.z = (FLIGHT.pipeWidth + (j < 2 ? 0 : 0.07)) * depth / 2;
        gate.add(mesh);
      }
      this.gates.push(gate); this.root.add(gate);
    }

    const markerGeometry = new THREE.BoxGeometry(0.08, 0.035, 1.5);
    const beaconGeometry = new THREE.SphereGeometry(0.095, 10, 8);
    for (let i = 0; i < 20; i++) {
      const marker = new THREE.Group(); marker.name = `flappy-route-marker-${i}`;
      for (const x of [-3.5, 3.5]) {
        const strip = new THREE.Mesh(markerGeometry, paleMint);
        strip.position.set(x, bottom - 0.085, 0); marker.add(strip);
        const beacon = new THREE.Mesh(beaconGeometry, gold);
        beacon.position.set(x, bottom + 0.05, 0.8); marker.add(beacon);
      }
      this.markers.push(marker); this.root.add(marker);
    }

    this.opening.name = 'flappy-next-opening';
    const edge = new THREE.MeshBasicMaterial({ color: 0x9af6dc, toneMapped: false, depthTest: false, depthWrite: false });
    const bar = new THREE.BoxGeometry(1, 1, 0.035);
    for (let i = 0; i < 4; i++) {
      const mesh = new THREE.Mesh(bar, edge); mesh.renderOrder = 5; this.openingBars.push(mesh); this.opening.add(mesh);
    }
    this.root.add(this.opening);
    this.flightMarker.name = 'flappy-flight-height-marker';
    const ink = new THREE.MeshBasicMaterial({ color: 0xffd789, toneMapped: false, depthTest: false, depthWrite: false });
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.045, 0.065, 24), ink); ring.renderOrder = 6; this.flightMarker.add(ring);
    for (const x of [-0.3, 0.3]) {
      const wing = new THREE.Mesh(new THREE.BoxGeometry(0.23, 0.035, 0.012), ink);
      wing.position.x = x; wing.renderOrder = 6; this.flightMarker.add(wing);
    }
    this.root.add(this.flightMarker);
  }

  update(flight: FlappyFlight, reducedMotion: boolean, guidance: FlightGuidance): void {
    const { height, depth } = FLIGHT_SPACE;
    const floor = FLIGHT.bottom * height, ceiling = FLIGHT.top * height;
    flight.pipes.forEach((pipe, i) => {
      const gate = this.gates[i];
      gate.position.z = -(pipe.x - FLIGHT.birdX) * depth;
      const bottom = (pipe.center - pipe.gap / 2) * height;
      const top = (pipe.center + pipe.gap / 2) * height;
      const meshes = gate.children as THREE.Mesh[];
      meshes[0].position.y = (floor + bottom) / 2; meshes[0].scale.y = bottom - floor;
      meshes[1].position.y = (ceiling + top) / 2; meshes[1].scale.y = ceiling - top;
      meshes[2].position.y = bottom - 0.045 * height; meshes[2].scale.y = 0.09 * height;
      meshes[3].position.y = top + 0.045 * height; meshes[3].scale.y = 0.09 * height;
    });
    const distance = reducedMotion ? 0 : flight.distance * depth;
    this.markers.forEach((marker, i) => { marker.position.z = 8 - ((i * 8 - distance % 160 + 160) % 160); });
    const target = guidance.target;
    const targetZ = target ? -(target.x - FLIGHT.birdX) * depth + (FLIGHT.pipeWidth + 0.07) * depth / 2 + 0.05 : 0;
    this.opening.visible = !!target && targetZ < -1.5;
    if (target) {
      this.opening.position.set(0, target.center * height, targetZ);
      this.opening.userData.targetIndex = flight.pipes.indexOf(target);
      const safeHeight = (target.gap - FLIGHT.radius * 2) * height;
      this.openingBars.forEach((mesh, i) => {
        if (i < 2) { mesh.scale.set(5.8, 0.065, 1); mesh.position.set(0, (i ? -1 : 1) * safeHeight / 2, 0); }
        else { mesh.scale.set(0.065, safeHeight, 1); mesh.position.set((i === 2 ? -1 : 1) * 2.9, 0, 0); }
      });
    }
    // 标记沿真实飞行轴线放置；转头不会改变它所表示的飞行高度。
    this.flightMarker.position.set(0, flight.y * height, -3.2);
    this.flightMarker.visible = flight.phase === 'playing' || flight.phase === 'paused';
  }
}
