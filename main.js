import { THREE, GLTFLoader, VRButton, XRControllerModelFactory, OrbitControls } from './three.bundle.js';

/* =============================================================================
   TIME MACHINE - VR SIMULATOR
   Built against timemachine_control_group.glb. Every mesh/material/locator
   name below is read directly from that file - nothing is renamed. The
   file's own baked root rotation is trusted as-is; only a corrective overall
   scale is applied (see _onModelLoaded), since the file's raw units come out
   centimeter-scale otherwise.
   ============================================================================= */

const CONFIG = Object.freeze({
  modelUrl: './timemachine_control_group.glb',
  startDistance: 3 * 0.3048,        // machine starts 3ft in front of the viewer
  floorY: 0,                         // the machine's wrapper never sinks below this

  // See the scale-correction note in _onModelLoaded - the file's raw units
  // come out centimeter-scale, so this brings it to a sensible real-world
  // footprint without touching any of its authored relative positions.
  minSensibleSize: 0.3, // meters - if the loaded model's largest dimension is below this, correct it
  targetSize: 1.8,       // meters - target largest dimension after correction

  movement: {
    baseSpeed: 0.6,          // m/s at rest input, before trigger boost
    maxAccelMult: 4.0,       // trigger fully pulled multiplies speed by this
    accelSharpness: 6,       // higher = snaps to target velocity faster
    decelSharpness: 4,       // higher = stops faster once input released
    deadzone: 0.12,
    turnSpeed: 1.2, // rad/s at full left-stick X deflection
  },

  lever: {
    maxAngle: THREE.MathUtils.degToRad(28),
    axis: new THREE.Vector3(1, 0, 0), // tilt around local X (forward/back lean)
  },

  button: {
    pressFraction: 0.35, // how far toward its pivot the button travels when pressed (0..1 of the mesh-to-pivot distance)
    smoothing: 14,        // damp() rate for press/release
    hitRadius: 0.15,      // meters - forgiving fallback ray-to-button distance for VR pointing
  },

  pointPowerEffect: {
    color: 0xffb26b,
    radius: 0.15,       // meters, in pointpower_mesh's own local scale (grows with it automatically)
    tubeRadius: 0.01,
    arcLength: Math.PI * 0.35,
    speed: 0.9,
    direction: 1, // counter-clockwise viewed from above
  },

  pointPowerTravel: {
    riseTime: 2.4,      // seconds to travel start -> end locator
    scaleAtEnd: 5,       // multiple of the mesh's own authored scale, reached at t=1
    scaleRampStart: 0.5, // travel progress (0..1) at which scaling begins
  },

  sidePanel: {
    color: 0x9fd6ff,
    sweepSpeed: 0.5,     // cycles/sec of the vertical sweep
    pulseSpeed: 1.6,
  },

  powerFadeSharpness: 3, // how quickly effects fade in/out when power toggles

  drones: {
    count: 3,
    color: 0xff4444,
    bodyRadius: 0.1,
    armLength: 0.22,
    orbitRadiusRange: [3.0, 5.5],   // meters from the machine's center
    orbitHeightRange: [1.4, 3.2],   // meters above the machine's center
    orbitSpeed: 0.5,                // rad/s baseline (randomized ±per drone)
    diveSpeed: 4.0,                 // m/s while diving at the machine
    retreatSpeed: 3.0,              // m/s while climbing back to orbit
    diveCooldownRange: [3, 7],      // seconds between dive attempts, per drone
    attackRadius: 0.7,              // distance from machine center counted as a hit
    rotorSpeed: 24,                 // rad/s visual rotor spin
    spawnFadeSharpness: 6,
    maxHealth: 2,                   // hits from the player's gun before it explodes
    hitRadius: 0.28,                // meters - projectile-to-drone hit distance
    respawnDelayRange: [3, 6],      // seconds before a destroyed drone is replaced
  },

  gun: {
    fireCooldown: 0.22,             // seconds between shots while squeezing
    projectileSpeed: 22,            // m/s
    projectileLife: 2.0,            // seconds before a shot despawns unused
    maxProjectiles: 24,             // pool size (InstancedMesh capacity)
    color: 0xff3322,
    length: 0.09,                   // meters, along travel direction
    radius: 0.012,
  },

  machine: {
    maxHealth: 3,                   // drone hits before the machine is destroyed
  },

  explosion: {
    droneParticleCount: 36,
    droneSpeed: 2.2,
    droneDuration: 0.7,
    machineParticleCount: 220,
    machineSpeed: 0.9,              // slowed down for the gentle, non-nauseating effect
    machineDuration: 3.5,
    machineTimeScale: 0.2,          // slow motion factor applied only to the machine's own explosion update
    particleSize: 0.035,
  },
});

/* =============================================================================
   Utility: shader-based rotating energy band.
   Renders as a bright arc that sweeps around a world-space center, computed
   entirely in world space (Y always vertical, X/Z always horizontal in
   Three.js) so it works correctly regardless of the source mesh's own local
   axis layout - no per-asset guessing required. The mesh itself never moves;
   only the shader's "current angle" uniform advances each frame.
   ============================================================================= */
/**
 * A simple, robust rotating glow effect: a real partial-torus mesh with a
 * plain MeshBasicMaterial, physically rotated each frame. Deliberately
 * avoids onBeforeCompile / shader-chunk injection - that depends on
 * internals I can't visually verify, whereas this uses only plain,
 * well-supported Three.js features (real geometry, a standard material
 * property, object rotation), the same reliable approach that worked when
 * we were building everything procedurally earlier in this project.
 */
class GlowArc {
  constructor({ radius, tubeRadius, color, direction = 1, arcLength = Math.PI * 0.35 }) {
    this.direction = direction;
    this.pivot = new THREE.Group();

    const geo = new THREE.TorusGeometry(radius, tubeRadius, 8, 48, arcLength);
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0 });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.rotation.x = Math.PI / 2; // lie flat
    this.pivot.add(this.mesh);
  }

  update(delta, speed, intensity) {
    this.pivot.rotation.y += this.direction * speed * delta;
    this.mesh.material.opacity = intensity;
  }
}

/* =============================================================================
   Utility: procedurally-generated sound effects (no external audio files).
   Buffers are synthesized once on first use and reused for every playback.
   Uses THREE.PositionalAudio where a source object is given, so shots and
   explosions sound like they're actually happening in the scene.
   ============================================================================= */
class SFX {
  constructor(listener) {
    this.listener = listener;
    this.context = listener.context;
    this._buffers = {};
  }

  _buffer(name, seconds, fill) {
    if (this._buffers[name]) return this._buffers[name];
    const rate = this.context.sampleRate;
    const buffer = this.context.createBuffer(1, Math.ceil(rate * seconds), rate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = fill(i / rate, i, rate);
    this._buffers[name] = buffer;
    return buffer;
  }

  _laserBuffer() {
    return this._buffer('laser', 0.14, (t) => {
      const freq = THREE.MathUtils.lerp(1400, 300, t / 0.14);
      const env = Math.exp(-t * 18);
      return Math.sin(2 * Math.PI * freq * t) * env * 0.6;
    });
  }

  _droneExplosionBuffer() {
    return this._buffer('droneExplosion', 0.45, (t) => {
      const env = Math.exp(-t * 7);
      return (Math.random() * 2 - 1) * env * 0.7;
    });
  }

  _machineExplosionBuffer() {
    return this._buffer('machineExplosion', 2.2, (t) => {
      const env = Math.exp(-t * 1.4);
      const rumble = Math.sin(2 * Math.PI * 55 * t) * 0.4;
      return ((Math.random() * 2 - 1) * 0.7 + rumble) * env;
    });
  }

  _powerOnBuffer() {
    return this._buffer('powerOn', 1.1, (t) => {
      const freq = THREE.MathUtils.lerp(80, 260, Math.min(1, t / 0.9));
      const env = Math.min(1, t * 6) * Math.exp(-Math.max(0, t - 0.7) * 3);
      return Math.sin(2 * Math.PI * freq * t) * env * 0.5;
    });
  }

  _play(buffer, object, volume = 1) {
    if (this.context.state === 'suspended') this.context.resume();
    let sound;
    if (object) {
      sound = new THREE.PositionalAudio(this.listener);
      sound.setRefDistance(1.5);
      object.add(sound);
    } else {
      sound = new THREE.Audio(this.listener);
    }
    sound.setBuffer(buffer);
    sound.setVolume(volume);
    sound.onEnded = () => { if (object) object.remove(sound); };
    sound.play();
  }

  laserShot(object) { this._play(this._laserBuffer(), object, 0.5); }
  droneExplosion(object) { this._play(this._droneExplosionBuffer(), object, 0.7); }
  machineExplosion() { this._play(this._machineExplosionBuffer(), null, 0.8); }
  powerOn() { this._play(this._powerOnBuffer(), null, 0.6); }
}

/* =============================================================================
   Utility: a hand-held gun model attached to a controller grip, plus a
   pooled, InstancedMesh-based set of red projectiles it fires. Pooling +
   instancing keeps this cheap even with several shots in flight at once -
   there's exactly one draw call for every projectile in the scene.
   ============================================================================= */
class Gun {
  constructor(grip, config) {
    this.grip = grip;
    this.config = config;
    this.firing = false;
    this.cooldown = 0;

    this.group = new THREE.Group();
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x2a2e36, roughness: 0.5, metalness: 0.6 });
    const accentMat = new THREE.MeshStandardMaterial({ color: 0xff3322, emissive: 0xff3322, emissiveIntensity: 0.8, roughness: 0.4 });

    const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.035, 0.16), bodyMat);
    barrel.position.set(0, 0.01, -0.09);
    this.group.add(barrel);

    const grip_ = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.09, 0.035), bodyMat);
    grip_.position.set(0, -0.045, 0.01);
    grip_.rotation.x = 0.25;
    this.group.add(grip_);

    const tip = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.02, 10), accentMat);
    tip.rotation.x = Math.PI / 2;
    tip.position.set(0, 0.01, -0.175);
    this.group.add(tip);

    this.muzzle = new THREE.Object3D();
    this.muzzle.position.set(0, 0.01, -0.19);
    this.group.add(this.muzzle);

    grip.add(this.group);
  }

  worldMuzzle(outPos, outDir) {
    this.muzzle.getWorldPosition(outPos);
    outDir.set(0, 0, -1).transformDirection(this.muzzle.matrixWorld);
  }
}

class ProjectilePool {
  constructor(scene, config) {
    this.config = config;
    const geo = new THREE.CylinderGeometry(config.radius, config.radius, config.length, 6);
    geo.rotateX(Math.PI / 2); // cylinder's length axis -> local -Z (travel direction)
    const mat = new THREE.MeshBasicMaterial({ color: config.color, toneMapped: false });
    this.mesh = new THREE.InstancedMesh(geo, mat, config.maxProjectiles);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    scene.add(this.mesh);

    this.slots = Array.from({ length: config.maxProjectiles }, () => ({
      active: false, position: new THREE.Vector3(), velocity: new THREE.Vector3(), life: 0,
    }));

    this._quat = new THREE.Quaternion();
    this._up = new THREE.Vector3(0, 1, 0);
    this._matrix = new THREE.Matrix4();
    this._scaleOne = new THREE.Vector3(1, 1, 1);
  }

  fire(origin, direction) {
    const slot = this.slots.find((s) => !s.active);
    if (!slot) return;
    slot.active = true;
    slot.position.copy(origin);
    slot.velocity.copy(direction).multiplyScalar(this.config.projectileSpeed);
    slot.life = this.config.projectileLife;
  }

  /** @param {(pos:THREE.Vector3)=>boolean} hitTest - return true to consume the projectile */
  update(delta, hitTest) {
    let activeCount = 0;
    for (const slot of this.slots) {
      if (!slot.active) continue;
      slot.position.addScaledVector(slot.velocity, delta);
      slot.life -= delta;
      if (slot.life <= 0 || (hitTest && hitTest(slot.position))) {
        slot.active = false;
        continue;
      }
      this._quat.setFromUnitVectors(new THREE.Vector3(0, 0, -1), slot.velocity.clone().normalize());
      this._matrix.compose(slot.position, this._quat, this._scaleOne);
      this.mesh.setMatrixAt(activeCount, this._matrix);
      activeCount++;
    }
    this.mesh.count = activeCount;
    if (activeCount > 0) this.mesh.instanceMatrix.needsUpdate = true;
  }
}

/* =============================================================================
   Utility: a lightweight particle burst (THREE.Points) for drone / machine
   destruction. Runs its own tiny physics (velocity + light drag, optional
   gravity) and removes itself once its lifetime elapses. The "slowMotion"
   option scales its own internal delta only - nothing else in the scene is
   affected - to give the time machine's destruction a gentle, non-jarring
   pace without touching camera rotation or position.
   ============================================================================= */
class ParticleBurst {
  constructor(scene, { position, color, count, speed, duration, size, gravity = 0.4, timeScale = 1 }) {
    this.scene = scene;
    this.duration = duration;
    this.age = 0;
    this.timeScale = timeScale;
    this.gravity = gravity;
    this.dead = false;

    const positions = new Float32Array(count * 3);
    this.velocities = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      positions[i * 3] = position.x;
      positions[i * 3 + 1] = position.y;
      positions[i * 3 + 2] = position.z;
      const dir = new THREE.Vector3().randomDirection();
      const s = speed * (0.4 + Math.random() * 0.9);
      this.velocities[i * 3] = dir.x * s;
      this.velocities[i * 3 + 1] = dir.y * s;
      this.velocities[i * 3 + 2] = dir.z * s;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({ color, size, transparent: true, opacity: 1, depthWrite: false, toneMapped: false });
    this.points = new THREE.Points(geo, mat);
    scene.add(this.points);
  }

  /** @returns {boolean} true once finished (caller should discard) */
  update(delta) {
    if (this.dead) return true;
    const dt = delta * this.timeScale;
    this.age += dt;
    const pos = this.points.geometry.attributes.position.array;
    for (let i = 0; i < pos.length; i += 3) {
      this.velocities[i + 1] -= this.gravity * dt;
      pos[i] += this.velocities[i] * dt;
      pos[i + 1] += this.velocities[i + 1] * dt;
      pos[i + 2] += this.velocities[i + 2] * dt;
    }
    this.points.geometry.attributes.position.needsUpdate = true;
    const t = this.age / this.duration;
    this.points.material.opacity = Math.max(0, 1 - t);
    if (t >= 1) {
      this.dead = true;
      this.scene.remove(this.points);
      this.points.geometry.dispose();
      this.points.material.dispose();
      return true;
    }
    return false;
  }
}

/* =============================================================================
   Main application.
   ============================================================================= *//* =============================================================================
   Utility: a lever mesh that tilts around an external pivot locator.
   Captures its rest position/rotation once, then every frame recomputes the
   transform from that rest state plus the current input value - proportional
   control with no drift, frame-rate independent by construction.
   ============================================================================= */
class PivotedLever {
  /**
   * @param {THREE.Object3D} mesh
   * @param {THREE.Object3D} pivotLocator - must share the same parent as mesh
   * @param {THREE.Vector3} axis - local rotation axis
   * @param {number} maxAngle - radians, tilt at input = ±1
   */
  constructor(mesh, pivotLocator, axis, maxAngle) {
    this.mesh = mesh;
    this.axis = axis.clone().normalize();
    this.maxAngle = maxAngle;
    this.restPosition = mesh.position.clone();
    this.restQuaternion = mesh.quaternion.clone();
    this.pivotPosition = pivotLocator.position.clone();

    this._deltaQuat = new THREE.Quaternion();
    this._offset = new THREE.Vector3();
  }

  /** @param {number} input -1..1 */
  setInput(input) {
    const angle = THREE.MathUtils.clamp(input, -1, 1) * this.maxAngle;
    this._deltaQuat.setFromAxisAngle(this.axis, angle);

    this._offset.copy(this.restPosition).sub(this.pivotPosition).applyQuaternion(this._deltaQuat);
    this.mesh.position.copy(this.pivotPosition).add(this._offset);
    this.mesh.quaternion.copy(this._deltaQuat).multiply(this.restQuaternion);
  }
}

/* =============================================================================
   Utility: a button mesh that presses toward its pivot locator and springs
   back smoothly. Frame-rate independent via THREE.MathUtils.damp.
   ============================================================================= */
class PressableButton {
  constructor(mesh, pivotLocator, { pressFraction = 0.35, smoothing = 14 } = {}) {
    this.mesh = mesh;
    this.restPosition = mesh.position.clone();
    this.smoothing = smoothing;

    const toPivot = pivotLocator.position.clone().sub(mesh.position);
    this.travelDistance = toPivot.length() * pressFraction;
    this.direction = toPivot.normalize();

    this.pressAmount = 0;
    this.targetPress = 0;
  }

  press() { this.targetPress = 1; }
  release() { this.targetPress = 0; }

  update(delta) {
    this.pressAmount = THREE.MathUtils.damp(this.pressAmount, this.targetPress, this.smoothing, delta);
    this.mesh.position.copy(this.restPosition).addScaledVector(this.direction, this.travelDistance * this.pressAmount);
  }
}

/* =============================================================================
   Utility: point power travel - lerps a mesh between two locators and ramps
   its scale up in the back half of the journey. Locator-driven: reads the
   start/end positions directly from the scene rather than hardcoding them.
   ============================================================================= */
class LocatorTravel {
  constructor(mesh, startLocator, endLocator, { riseTime, scaleAtEnd, scaleRampStart }) {
    this.mesh = mesh;
    this.startPos = startLocator.position.clone();
    this.endPos = endLocator.position.clone();
    this.baseScale = mesh.scale.clone();
    this.riseTime = riseTime;
    this.scaleAtEnd = scaleAtEnd;
    this.scaleRampStart = scaleRampStart;
    this.progress = 0; // 0..1
    this._scratch = new THREE.Vector3();
  }

  /** @param {number} delta seconds @param {boolean} advancing */
  update(delta, advancing) {
    const dir = advancing ? 1 : -1;
    this.progress = THREE.MathUtils.clamp(this.progress + (dir * delta) / this.riseTime, 0, 1);

    const eased = this.progress * this.progress * (3 - 2 * this.progress); // smoothstep
    this.mesh.position.lerpVectors(this.startPos, this.endPos, eased);

    this.scaleMult = 1;
    if (this.progress > this.scaleRampStart) {
      const t = (this.progress - this.scaleRampStart) / (1 - this.scaleRampStart);
      this.scaleMult = THREE.MathUtils.lerp(1, this.scaleAtEnd, t);
    }
    this._scratch.copy(this.baseScale).multiplyScalar(this.scaleMult);
    this.mesh.scale.copy(this._scratch);

    return eased;
  }
}

/* =============================================================================
   Utility: smooth 6-DOF translation with acceleration/deceleration and a
   floor clamp. Trigger acts as a speed multiplier.
   ============================================================================= */
class MachineMovementController {
  constructor(target, config) {
    this.target = target;
    this.config = config;
    this.velocity = new THREE.Vector3();
    this._desired = new THREE.Vector3();
    this._forward = new THREE.Vector3();
  }

  /**
   * @param {number} delta
   * @param {{leftX:number, leftY:number, rightY:number, trigger:number}} input
   */
  update(delta, input) {
    const c = this.config;
    const accelMult = 1 + input.trigger * (c.maxAccelMult - 1);
    const maxSpeed = c.baseSpeed * accelMult;

    // Left stick X now turns the machine (left goes left, right goes right)
    // rather than strafing - forward/back and up/down are unaffected.
    if (Math.abs(input.leftX) > c.deadzone) {
      this.target.rotation.y -= input.leftX * c.turnSpeed * delta;
    }

    this._forward.set(0, 0, -1).applyQuaternion(this.target.quaternion);

    this._desired.set(0, 0, 0);
    if (Math.abs(input.leftY) > c.deadzone) this._desired.addScaledVector(this._forward, -input.leftY);
    if (Math.abs(input.rightY) > c.deadzone) this._desired.y += -input.rightY;

    const hasInput = this._desired.lengthSq() > 0.0001;
    if (hasInput) this._desired.normalize().multiplyScalar(maxSpeed);

    const sharpness = hasInput ? c.accelSharpness : c.decelSharpness;
    const t = 1 - Math.exp(-sharpness * delta);
    this.velocity.lerp(this._desired, t);

    this.target.position.addScaledVector(this.velocity, delta);

    if (this.target.position.y < CONFIG.floorY) {
      this.target.position.y = CONFIG.floorY;
      if (this.velocity.y < 0) this.velocity.y = 0;
    }
  }
}

/* =============================================================================
   Utility: reads Quest controller gamepad state into a clean per-hand shape.
   ============================================================================= */
class XRInputReader {
  constructor(renderer) {
    this.renderer = renderer;
    this.left = { stickX: 0, stickY: 0, trigger: 0 };
    this.right = { stickX: 0, stickY: 0, trigger: 0 };
  }

  poll() {
    const session = this.renderer.xr.getSession();
    if (!session) return;

    for (const source of session.inputSources) {
      if (!source.gamepad) continue;
      const gp = source.gamepad;
      const stickX = gp.axes.length >= 4 ? gp.axes[2] : (gp.axes[0] || 0);
      const stickY = gp.axes.length >= 4 ? gp.axes[3] : (gp.axes[1] || 0);
      const trigger = gp.buttons[0] ? gp.buttons[0].value : 0;

      const hand = source.handedness === 'left' ? this.left : (source.handedness === 'right' ? this.right : null);
      if (hand) { hand.stickX = stickX; hand.stickY = stickY; hand.trigger = trigger; }
    }
  }
}

/* =============================================================================
   Utility: a small in-scene text panel attached to a controller grip. The 2D
   HTML overlay is invisible once actually inside a VR session, so anything
   the user needs to read while in VR has to be real 3D geometry like this.
   ============================================================================= */
class ControllerLabel {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 320;
    this.canvas.height = 220;
    this.ctx = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);

    const geo = new THREE.PlaneGeometry(0.11, 0.076);
    const mat = new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, depthTest: false, side: THREE.DoubleSide });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.renderOrder = 999;
  }

  setLines(lines) {
    const ctx = this.ctx;
    const { width, height } = this.canvas;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = 'rgba(10, 14, 24, 0.85)';
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = '#66ccff';
    ctx.lineWidth = 4;
    ctx.strokeRect(2, 2, width - 4, height - 4);
    ctx.fillStyle = '#eaf6ff';
    ctx.font = 'bold 22px system-ui, sans-serif';
    lines.forEach((line, i) => ctx.fillText(line, 14, 34 + i * 30));
    this.texture.needsUpdate = true;
  }
}

const LEFT_LABEL_LINES = ['LEFT CONTROLLER', 'Stick X: turn machine', 'Stick Y: forward/back', 'Trigger: accelerate', 'X: board  Y: exit', 'Grip: fire gun'];
const RIGHT_LABEL_LINES = ['RIGHT CONTROLLER', 'Stick Y: up/down', 'Trigger: accelerate', 'Point + trigger:', 'press power button', 'Grip: fire gun'];

/* =============================================================================
   Utility: a single procedural quad-copter drone enemy. No external assets -
   built entirely from primitives (octahedron body + four spinning rotor
   arms). Runs its own small state machine:
     spawning -> orbiting -> diving -> retreating -> orbiting -> ... -> despawning
   Orbits a point above/around the machine's current WORLD position (recomputed
   every frame by the caller, so it stays correct even while the machine is
   being flown around), then periodically dives at it and reports a hit back
   to the caller once it gets within attackRadius.
   ============================================================================= */
class Drone {
  constructor(config) {
    this.group = new THREE.Group();

    const bodyMat = new THREE.MeshStandardMaterial({
      color: config.color, emissive: config.color, emissiveIntensity: 0.7,
      roughness: 0.35, metalness: 0.4,
    });
    this.group.add(new THREE.Mesh(new THREE.OctahedronGeometry(config.bodyRadius, 0), bodyMat));

    const rotorMat = new THREE.MeshBasicMaterial({ color: 0x1a1a1a });
    this.rotors = [];
    for (const [dx, dz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const arm = new THREE.Group();
      arm.position.set(dx * config.armLength * 0.5, 0, dz * config.armLength * 0.5);
      arm.add(new THREE.Mesh(new THREE.BoxGeometry(config.armLength * 0.7, 0.008, 0.02), rotorMat));
      this.group.add(arm);
      this.rotors.push(arm);
    }
    // Shadow casting deliberately skipped here for performance - three
    // small, fast-orbiting drones add real render cost for a shadow
    // contribution nobody would notice.

    this.state = 'spawning';
    this._initialized = false;
    this.orbitAngle = Math.random() * Math.PI * 2;
    this.orbitRadius = 0;
    this.orbitHeight = 0;
    this.orbitAngularSpeed = 0;
    this.diveTimer = 0;
    this.health = config.maxHealth;
    this._flashTimer = 0;
    this._bodyMat = bodyMat;

    this._target = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this.group.scale.setScalar(0.001);
  }

  /** @returns {boolean} true if this hit destroyed the drone */
  takeHit() {
    this.health -= 1;
    this._flashTimer = 0.15;
    if (this.health <= 0) {
      this.state = 'exploding';
      return true;
    }
    return false;
  }

  _pickOrbitParams(config) {
    this.orbitRadius = THREE.MathUtils.lerp(config.orbitRadiusRange[0], config.orbitRadiusRange[1], Math.random());
    this.orbitHeight = THREE.MathUtils.lerp(config.orbitHeightRange[0], config.orbitHeightRange[1], Math.random());
    this.orbitAngularSpeed = config.orbitSpeed * (0.7 + Math.random() * 0.6) * (Math.random() < 0.5 ? 1 : -1);
    this.diveTimer = THREE.MathUtils.lerp(config.diveCooldownRange[0], config.diveCooldownRange[1], Math.random());
  }

  _orbitPoint(machineWorldPos) {
    const x = machineWorldPos.x + Math.cos(this.orbitAngle) * this.orbitRadius;
    const z = machineWorldPos.z + Math.sin(this.orbitAngle) * this.orbitRadius;
    const y = machineWorldPos.y + this.orbitHeight;
    return this._target.set(x, y, z);
  }

  /** @returns {{attacked: boolean}} */
  update(delta, machineWorldPos, config) {
    let attacked = false;

    switch (this.state) {
      case 'spawning': {
        if (!this._initialized) { this._pickOrbitParams(config); this._initialized = true; }
        this.orbitAngle += this.orbitAngularSpeed * delta;
        this.group.position.copy(this._orbitPoint(machineWorldPos));
        this.group.lookAt(machineWorldPos);
        const s = THREE.MathUtils.damp(this.group.scale.x, 1, config.spawnFadeSharpness, delta);
        this.group.scale.setScalar(s);
        if (s > 0.97) { this.group.scale.setScalar(1); this.state = 'orbiting'; }
        break;
      }

      case 'orbiting': {
        this.orbitAngle += this.orbitAngularSpeed * delta;
        this.group.position.copy(this._orbitPoint(machineWorldPos));
        this.group.lookAt(machineWorldPos);
        this.diveTimer -= delta;
        if (this.diveTimer <= 0) this.state = 'diving';
        break;
      }

      case 'diving': {
        this._dir.copy(machineWorldPos).sub(this.group.position);
        const dist = this._dir.length();
        if (dist < config.attackRadius) {
          attacked = true;
          this.state = 'retreating';
        } else {
          this._dir.normalize();
          this.group.position.addScaledVector(this._dir, config.diveSpeed * delta);
          this.group.lookAt(machineWorldPos);
        }
        break;
      }

      case 'retreating': {
        const desired = this._orbitPoint(machineWorldPos);
        this._dir.copy(desired).sub(this.group.position);
        const dist = this._dir.length();
        if (dist < 0.3) {
          this._pickOrbitParams(config);
          this.state = 'orbiting';
        } else {
          this._dir.normalize();
          this.group.position.addScaledVector(this._dir, config.retreatSpeed * delta);
          this.group.lookAt(machineWorldPos);
        }
        break;
      }

      case 'despawning': {
        const s = THREE.MathUtils.damp(this.group.scale.x, 0, config.spawnFadeSharpness, delta);
        this.group.scale.setScalar(s);
        break;
      }

      case 'exploding':
      case 'dead': {
        // Visual/physical presence is handled entirely by the caller's
        // particle burst - just stay put and invisible.
        this.group.visible = false;
        break;
      }
    }

    if (this._flashTimer > 0) {
      this._flashTimer -= delta;
      this._bodyMat.emissiveIntensity = this._flashTimer > 0 ? 2.5 : 0.7;
    }

    for (const arm of this.rotors) arm.rotation.y += config.rotorSpeed * delta;
    return { attacked };
  }
}

/* =============================================================================
   Utility: manages a pool of Drones - spawns them in when the machine
   powers on, fades them out (rather than popping) when it powers off, and
   reports whether any drone landed a hit this frame.
   ============================================================================= */
class DroneSwarm {
  constructor(scene, config, { explosionConfig, sfx, onDroneExplode } = {}) {
    this.scene = scene;
    this.config = config;
    this.explosionConfig = explosionConfig;
    this.sfx = sfx;
    this.onDroneExplode = onDroneExplode; // called with world position, for camera-shake etc.
    this.drones = [];
    this.active = false;
    this._respawnTimer = 0;
    this._machinePos = new THREE.Vector3();
    this._worldPos = new THREE.Vector3();
  }

  setActive(active) {
    if (active === this.active) return;
    this.active = active;
    if (active) {
      for (let i = 0; i < this.config.count; i++) this._spawnDrone();
    } else {
      for (const d of this.drones) if (d.state !== 'exploding' && d.state !== 'dead') d.state = 'despawning';
    }
  }

  _spawnDrone() {
    const d = new Drone(this.config);
    this.scene.add(d.group);
    this.drones.push(d);
  }

  /** Finds the nearest live drone within hitRadius of a world point and damages it. */
  registerHitNear(worldPoint) {
    let best = null;
    let bestDist = this.config.hitRadius;
    for (const d of this.drones) {
      if (d.state === 'exploding' || d.state === 'dead' || d.state === 'despawning') continue;
      const dist = d.group.position.distanceTo(worldPoint);
      if (dist < bestDist) { best = d; bestDist = dist; }
    }
    if (!best) return false;
    const destroyed = best.takeHit();
    if (destroyed) {
      best.group.getWorldPosition(this._worldPos);
      // ParticleBurst adds itself to the scene in its constructor; the
      // caller (TimeMachineApp) owns updating/discarding it each frame.
      const burst = new ParticleBurst(this.scene, {
        position: this._worldPos.clone(),
        color: this.config.color,
        count: this.explosionConfig.droneParticleCount,
        speed: this.explosionConfig.droneSpeed,
        duration: this.explosionConfig.droneDuration,
        size: this.explosionConfig.particleSize,
      });
      if (this.onDroneExplode) this.onDroneExplode(this._worldPos, burst);
      if (this.sfx) this.sfx.droneExplosion(best.group);
    }
    return true;
  }

  /** @returns {{attacked: boolean}} */
  update(delta, machineWrapper) {
    if (this.drones.length === 0) return { attacked: false };
    machineWrapper.getWorldPosition(this._machinePos);

    let attacked = false;
    for (const d of this.drones) {
      if (d.state === 'dead') continue;
      if (d.state === 'exploding') { d.state = 'dead'; continue; }
      if (d.update(delta, this._machinePos, this.config).attacked) attacked = true;
    }

    const removable = this.drones.filter((d) =>
      d.state === 'dead' || (!this.active && d.group.scale.x < 0.02));
    if (removable.length) {
      for (const d of removable) this.scene.remove(d.group);
      this.drones = this.drones.filter((d) => !removable.includes(d));
    }

    // Keep the swarm topped up while the machine is powered on - destroyed
    // drones respawn after a short delay rather than staying gone forever.
    if (this.active) {
      const alive = this.drones.filter((d) => d.state !== 'dead' && d.state !== 'exploding').length;
      if (alive < this.config.count) {
        this._respawnTimer -= delta;
        if (this._respawnTimer <= 0) {
          this._spawnDrone();
          this._respawnTimer = THREE.MathUtils.lerp(
            this.config.respawnDelayRange[0], this.config.respawnDelayRange[1], Math.random()
          );
        }
      }
    }

    return { attacked };
  }
}

/* =============================================================================
   Main application.
   ============================================================================= */
class TimeMachineApp {
  constructor() {
    this.clock = new THREE.Clock();
    this.isPoweredOn = false;
    this.powerAnim = 0;
    this.machineReady = false;
    this.machineHealth = CONFIG.machine.maxHealth;
    this.machineDestroyed = false;
    this.machineExploding = false;
    this.particleBursts = [];

    this._initScene();
    this._initXR();
    this._loadModel();

    window.addEventListener('resize', () => this._onResize());
    this.renderer.setAnimationLoop((t, frame) => this._tick(t, frame));
  }

  _initScene() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x556080);
    this.scene.fog = new THREE.Fog(0x556080, 10, 30);

    this.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.05, 100);
    this.camera.position.set(0, 1.6, 2.2);

    // Positional-audio listener - powers every SFX.* sound (gun shots,
    // explosions, the power-on hum), all synthesized on the fly so no
    // external audio assets are needed.
    this.audioListener = new THREE.AudioListener();
    this.camera.add(this.audioListener);
    this.sfx = new SFX(this.audioListener);

    this.playerRig = new THREE.Group();
    this.playerRig.add(this.camera);
    this.playerRig.position.set(0, 0, 2.2);
    this.scene.add(this.playerRig);
    this.standingRigPosition = this.playerRig.position.clone();
    this.isSeated = false;

    this._shakeVec = new THREE.Vector3();
    this._shakeTime = 0;
    this._shakeDuration = 0;
    this._shakeMagnitude = 0;
    this._attackFlashCooldown = 0;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    // Cap the pixel ratio a little below the platform max - a big win for
    // frame time on standalone headsets, barely noticeable visually.
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.xr.enabled = true;
    this.renderer.xr.setReferenceSpaceType('local-floor');
    document.body.appendChild(this.renderer.domElement);
    document.body.appendChild(VRButton.createButton(this.renderer));

    this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbit.target.set(0, 1.1, -CONFIG.startDistance);
    this.orbit.enableDamping = true;

    this._setupLighting();
    this._setupRoom();

    // The wrapper we actually move/turn - keeps our control logic decoupled
    // from the model's own baked root transform (rotation/scale), so the two
    // never fight each other.
    this.machineWrapper = new THREE.Group();
    this.machineWrapper.position.set(0, 0, -CONFIG.startDistance);
    this.scene.add(this.machineWrapper);
    this.movement = new MachineMovementController(this.machineWrapper, CONFIG.movement);
    this.droneSwarm = new DroneSwarm(this.scene, CONFIG.drones, {
      explosionConfig: CONFIG.explosion,
      sfx: this.sfx,
      onDroneExplode: (worldPos, burst) => {
        this.particleBursts.push(burst);
        this.triggerShake(0.03, 0.2);
      },
    });
    this.projectiles = new ProjectilePool(this.scene, CONFIG.gun);
    this.guns = [];
  }

  _setupLighting() {
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x30354a, 1.3));
    const dir = new THREE.DirectionalLight(0xffffff, 2.0);
    dir.position.set(3, 6, 2);
    dir.castShadow = true;
    dir.shadow.mapSize.set(1024, 1024);
    Object.assign(dir.shadow.camera, { near: 0.5, far: 20, left: -5, right: 5, top: 5, bottom: -5 });
    this.scene.add(dir);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.4));
  }

  _setupRoom() {
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(10, 48),
      new THREE.MeshStandardMaterial({ color: 0x3a4258, roughness: 0.9, metalness: 0.05 })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.scene.add(floor);
    this.scene.add(new THREE.GridHelper(20, 40, 0x8fa4d8, 0x5a6690));
  }

  _initXR() {
    this.inputReader = new XRInputReader(this.renderer);
    const controllerModelFactory = new XRControllerModelFactory();
    const rayGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]);
    const rayMat = new THREE.LineBasicMaterial({ color: 0x66ccff });

    this.raycaster = new THREE.Raycaster();
    this._tempMatrix = new THREE.Matrix4();

    const build = (index) => {
      const controller = this.renderer.xr.getController(index);
      controller.addEventListener('selectstart', () => this._onSelectStart(controller));
      controller.addEventListener('selectend', () => this._onSelectEnd());
      const line = new THREE.Line(rayGeo, rayMat);
      line.scale.z = 2;
      controller.add(line);
      this.playerRig.add(controller);

      const grip = this.renderer.xr.getControllerGrip(index);
      grip.add(controllerModelFactory.createControllerModel(grip));
      this.playerRig.add(grip);

      const gun = new Gun(grip, CONFIG.gun);
      this.guns.push(gun);
      controller.addEventListener('squeezestart', () => { gun.firing = true; });
      controller.addEventListener('squeezeend', () => { gun.firing = false; });

      // Handedness isn't known until the session reports it, so the label
      // text is filled in once 'connected' fires.
      const label = new ControllerLabel();
      label.mesh.position.set(0, 0.06, -0.02);
      label.mesh.rotation.x = -Math.PI / 4;
      grip.add(label.mesh);
      controller.addEventListener('connected', (event) => {
        const hand = event.data.handedness;
        label.setLines(hand === 'left' ? LEFT_LABEL_LINES : RIGHT_LABEL_LINES);
      });

      return controller;
    };
    this.controller1 = build(0);
    this.controller2 = build(1);
  }

  async _loadModel() {
    const loader = new GLTFLoader();
    setStatus('loading model...');
    try {
      const gltf = await loader.loadAsync(CONFIG.modelUrl, (evt) => {
        if (evt.lengthComputable) {
          setStatus(`loading model... ${Math.round((evt.loaded / evt.total) * 100)}%`);
        }
      });
      this._onModelLoaded(gltf);
    } catch (err) {
      console.error('Failed to load', CONFIG.modelUrl, err);
      setStatus('FAILED TO LOAD ' + CONFIG.modelUrl + ' - check it is next to index.html and you are using a local server', true);
    }
  }

  _onModelLoaded(gltf) {
    // The file's own root already carries the correct rotation - trusted
    // as-is. Its baked scale (0.01), combined with the raw coordinate
    // magnitudes in this file, produces a centimeter-scale machine (e.g.
    // the point-power travel distance comes out to ~1.9cm) - so we apply
    // ONE corrective uniform scale at the wrapper level to reach a sensible
    // real-world size, without touching the file's own transform, names,
    // or relative positions in any way.
    this.machine = gltf.scene;
    this.machineWrapper.add(this.machine);

    const box = new THREE.Box3().setFromObject(this.machine);
    const size = new THREE.Vector3();
    box.getSize(size);
    const largestDim = Math.max(size.x, size.y, size.z);
    if (largestDim > 0 && largestDim < CONFIG.minSensibleSize) {
      const correction = CONFIG.targetSize / largestDim;
      this.machine.scale.multiplyScalar(correction);
      console.log(`TimeMachine: model measured ${largestDim.toFixed(3)}m across - applied a ${correction.toFixed(1)}x correction to reach ~${CONFIG.targetSize}m.`);
    }

    const byName = (name) => this.machine.getObjectByName(name);

    // --- collect every named part we need, by exact name from the file ---
    const parts = {
      controlGroup: byName('timemachine_control_group'),
      buttonMesh: byName('button_mesh'),
      buttonPivot: byName('button_pivot_locator'),
      leftLeverMesh: byName('left_lever_mesh'),
      leftLeverPivot: byName('left_lever_pivot_locator'),
      rightLeverMesh: byName('right_lever_mesh'),
      rightLeverPivot: byName('right_lever_pivot_locator'),
      ringMesh: byName('timemachine_base_ring'),
      ringLocator: byName('timemachine_ring_locator'),
      pointPowerMesh: byName('pointpower_mesh'),
      startPointPower: byName('start_pointpower_position'),
      endPointPower: byName('end_pointpower_position'),
      teleportAnchor: byName('teleport_anchor'),
      controlBox: byName('control_box'),
    };

    const missing = Object.entries(parts).filter(([, v]) => !v).map(([k]) => k);
    if (missing.length) {
      console.warn('TimeMachine: could not find these named parts in the GLB:', missing);
    }
    this.parts = parts;

    this._setupButton(parts);
    this._setupLevers(parts);
    this._setupPointPower(parts);
    this._setupSidePanel(parts);
    this._setupShadows(this.machine);

    this.machineReady = true;
    setStatus('ready - point at the button and pull the trigger to power on');
  }

  _setupShadows(root) {
    root.traverse((child) => {
      if (child.isMesh) { child.castShadow = true; child.receiveShadow = true; }
    });
  }

  _setupButton(parts) {
    if (!parts.buttonMesh || !parts.buttonPivot) return;
    this.button = new PressableButton(parts.buttonMesh, parts.buttonPivot, CONFIG.button);
  }

  _setupLevers(parts) {
    const { axis, maxAngle } = CONFIG.lever;
    if (parts.leftLeverMesh && parts.leftLeverPivot) {
      this.leftLever = new PivotedLever(parts.leftLeverMesh, parts.leftLeverPivot, axis, maxAngle);
    }
    if (parts.rightLeverMesh && parts.rightLeverPivot) {
      this.rightLever = new PivotedLever(parts.rightLeverMesh, parts.rightLeverPivot, axis, maxAngle);
    }
  }

  _setupPointPower(parts) {
    if (!parts.pointPowerMesh || !parts.startPointPower || !parts.endPointPower) return;
    this.pointPowerTravel = new LocatorTravel(
      parts.pointPowerMesh, parts.startPointPower, parts.endPointPower, CONFIG.pointPowerTravel
    );

    // Parented to machineWrapper (NOT to pointpower_mesh itself) and its
    // world position/scale are synced explicitly every frame in
    // _updateMachineAnimations. pointpower_mesh carries its own
    // non-uniform authored scale (it's an squashed disc, not a uniform
    // node), so a child implicitly parented under it doesn't track its
    // travel reliably - explicit world-position syncing sidesteps that
    // entirely and guarantees the ring visually follows the mesh.
    this.pointPowerGlow = new GlowArc(CONFIG.pointPowerEffect);
    this.machineWrapper.add(this.pointPowerGlow.pivot);
    this._pointPowerWorldPos = new THREE.Vector3();
  }

  _setupSidePanel(parts) {
    if (!parts.controlBox) return;
    const material = this._findMaterialByName(parts.controlBox, 'side_panel_display');
    if (!material) return;

    const uniforms = {
      uTime: { value: 0 },
      uIntensity: { value: 0 },
      uColor: { value: new THREE.Color(CONFIG.sidePanel.color) },
      uSweepSpeed: { value: CONFIG.sidePanel.sweepSpeed },
    };
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uIntensity = uniforms.uIntensity;
      shader.uniforms.uColor = uniforms.uColor;
      shader.uniforms.uSweepSpeed = uniforms.uSweepSpeed;

      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vLocalPosPanel;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLocalPosPanel = position;');

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
           varying vec3 vLocalPosPanel;
           uniform float uTime;
           uniform float uIntensity;
           uniform vec3 uColor;
           uniform float uSweepSpeed;`
        )
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
           // Vertical sweep band plus a gentle overall pulse - both driven
           // by the mesh's own local Y, cheap (no trig beyond one sin/fract).
           float sweepPos = fract(vLocalPosPanel.y * 1.5 - uTime * uSweepSpeed);
           float band = smoothstep(0.12, 0.0, abs(sweepPos - 0.5));
           float pulse = 0.5 + 0.5 * sin(uTime * 3.0);
           totalEmissiveRadiance += uColor * (band * 0.8 + pulse * 0.2) * uIntensity;`
        );
    };
    material.emissive = new THREE.Color(0xffffff);
    material.needsUpdate = true;
    this.sidePanelUniforms = uniforms;
  }

  /** Finds a material by name among a mesh (and its children's) primitives. */
  _findMaterialByName(root, materialName) {
    let found = null;
    root.traverse((child) => {
      if (found || !child.isMesh || !child.material) return;
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      const match = mats.find((m) => m.name === materialName);
      if (match) {
        const clone = match.clone();
        if (Array.isArray(child.material)) {
          child.material = child.material.map((m) => (m === match ? clone : m));
        } else {
          child.material = clone;
        }
        found = clone;
      }
    });
    return found;
  }

  _onSelectStart(controller) {
    if (this.button) this.button.press();
    if (!this.parts?.buttonMesh) return;

    this._tempMatrix.identity().extractRotation(controller.matrixWorld);
    const origin = new THREE.Vector3().setFromMatrixPosition(controller.matrixWorld);
    const direction = new THREE.Vector3(0, 0, -1).applyMatrix4(this._tempMatrix).normalize();
    this.raycaster.set(origin, direction);

    let hit = this.raycaster.intersectObject(this.parts.buttonMesh, true).length > 0;
    if (!hit) {
      const buttonWorldPos = new THREE.Vector3();
      this.parts.buttonMesh.getWorldPosition(buttonWorldPos);
      const toButton = buttonWorldPos.clone().sub(origin);
      const t = Math.max(0, toButton.dot(direction));
      const closest = origin.clone().addScaledVector(direction, t);
      hit = closest.distanceTo(buttonWorldPos) < CONFIG.button.hitRadius;
    }
    if (hit) this._togglePower();
  }

  _onSelectEnd() {
    if (this.button) this.button.release();
  }

  _togglePower() {
    if (this.machineDestroyed) return;
    this.isPoweredOn = !this.isPoweredOn;
    if (this.isPoweredOn && this.sfx) this.sfx.powerOn();
    setStatus(this.isPoweredOn ? 'time machine powered ON' : 'time machine powered OFF');
  }

  _teleportToSeat() {
    if (!this.parts?.teleportAnchor) return;
    const seatWorld = new THREE.Vector3();
    this.parts.teleportAnchor.getWorldPosition(seatWorld);

    const camWorld = new THREE.Vector3();
    this.camera.getWorldPosition(camWorld);
    const headOffset = camWorld.clone().sub(this.playerRig.position);

    this.playerRig.position.copy(seatWorld.sub(headOffset));
    this.playerRig.rotation.y = this.machineWrapper.rotation.y + Math.PI;
    this.isSeated = true;
  }

  _standUp() {
    this.playerRig.position.copy(this.standingRigPosition);
    this.playerRig.rotation.y = 0;
    this.isSeated = false;
  }

  _pollButtons() {
    const session = this.renderer.xr.getSession();
    if (!session) return;
    for (const source of session.inputSources) {
      if (!source.gamepad || source.handedness !== 'left') continue;
      const gp = source.gamepad;
      const xPressed = gp.buttons[4] ? gp.buttons[4].pressed : false;
      if (xPressed && !this._prevXPressed) {
        if (this.isPoweredOn) this._teleportToSeat();
        else setStatus('power on the time machine before boarding');
      }
      this._prevXPressed = xPressed;

      const yPressed = gp.buttons[5] ? gp.buttons[5].pressed : false;
      if (yPressed && !this._prevYPressed) this._standUp();
      this._prevYPressed = yPressed;
    }
  }

  _tick() {
    const delta = Math.min(this.clock.getDelta(), 0.05);

    try {
      if (this.renderer.xr.isPresenting) {
        this.inputReader.poll();
        this._pollButtons();
        this._updateMovementAndLevers(delta);
        this._updateGuns(delta);
      } else {
        this.orbit.update();
      }

      if (this.machineReady) this._updateMachineAnimations(delta);
      this._updateParticleBursts(delta);
      this._applyCameraShake(delta);

      this.renderer.render(this.scene, this.camera);
    } catch (err) {
      setStatus('RENDER LOOP ERROR: ' + err.message, true);
      console.error(err);
      this.renderer.setAnimationLoop(null);
    }
  }

  _updateMovementAndLevers(delta) {
    const { left, right } = this.inputReader;

    this.movement.update(delta, {
      leftX: left.stickX, leftY: left.stickY, rightY: right.stickY,
      trigger: Math.max(left.trigger, right.trigger),
    });

    if (this.leftLever) this.leftLever.setInput(-left.stickY);
    if (this.rightLever) this.rightLever.setInput(-right.stickY);

    if (this.isSeated) {
      this._teleportToSeat(); // keeps the seated view glued to the seat (and correctly facing) as the machine moves/turns
    }
  }

  _updateMachineAnimations(delta) {
    const target = this.isPoweredOn ? 1 : 0;
    this.powerAnim = THREE.MathUtils.damp(this.powerAnim, target, CONFIG.powerFadeSharpness, delta);

    if (this.button) this.button.update(delta);

    if (this.pointPowerTravel) {
      this.pointPowerTravel.update(delta, this.isPoweredOn);
      if (this.pointPowerGlow) {
        // Explicit world-position sync, run every frame: read where
        // pointpower_mesh actually is right now and place the ring there,
        // in machineWrapper's local space (so it still rides along
        // correctly if the whole machine moves/turns). Scale mirrors the
        // same 1x -> 5x growth the mesh itself goes through.
        this.parts.pointPowerMesh.getWorldPosition(this._pointPowerWorldPos);
        this.machineWrapper.worldToLocal(this._pointPowerWorldPos);
        this.pointPowerGlow.pivot.position.copy(this._pointPowerWorldPos);
        this.pointPowerGlow.pivot.scale.setScalar(this.pointPowerTravel.scaleMult);

        // Only comes alive once pointpower_mesh has actually arrived at
        // pointpower_end_position - not as soon as power comes on.
        const hasArrived = this.pointPowerTravel.progress >= 1;
        const intensity = hasArrived ? this.powerAnim : 0;
        this.pointPowerGlow.update(delta, CONFIG.pointPowerEffect.speed, intensity);
      }
    }

    if (this.sidePanelUniforms) {
      this.sidePanelUniforms.uTime.value += delta;
      this.sidePanelUniforms.uIntensity.value = this.powerAnim;
    }

    if (this.droneSwarm && !this.machineDestroyed) {
      this.droneSwarm.setActive(this.isPoweredOn);
      const { attacked } = this.droneSwarm.update(delta, this.machineWrapper);
      this._attackFlashCooldown = Math.max(0, this._attackFlashCooldown - delta);
      if (attacked) {
        this.triggerShake(0.05, 0.35);
        this.machineHealth = Math.max(0, this.machineHealth - 1);
        if (this.machineHealth <= 0) {
          this._destroyMachine();
        } else if (this._attackFlashCooldown <= 0) {
          setStatus(`drone attack! shields rattled (${this.machineHealth} hit${this.machineHealth === 1 ? '' : 's'} left)`);
          this._attackFlashCooldown = 1.2;
        }
      }
    } else if (this.droneSwarm && this.machineDestroyed) {
      this.droneSwarm.setActive(false);
      this.droneSwarm.update(delta, this.machineWrapper);
    }
  }

  /**
   * Destroys the time machine: hides its mesh, spawns a large slow-motion
   * particle burst, and stops all drone activity. Deliberately avoids any
   * camera rotation or fast motion here - only a graceful fade - so the
   * moment doesn't trigger motion sickness in VR.
   */
  _destroyMachine() {
    if (this.machineDestroyed) return;
    this.machineDestroyed = true;
    this.machineExploding = true;
    this.isPoweredOn = false;

    const worldPos = new THREE.Vector3();
    this.machineWrapper.getWorldPosition(worldPos);
    if (this.machine) this.machine.visible = false;

    const burst = new ParticleBurst(this.scene, {
      position: worldPos,
      color: CONFIG.pointPowerEffect.color,
      count: CONFIG.explosion.machineParticleCount,
      speed: CONFIG.explosion.machineSpeed,
      duration: CONFIG.explosion.machineDuration,
      size: CONFIG.explosion.particleSize * 1.6,
      gravity: 0.15,
      timeScale: CONFIG.explosion.machineTimeScale,
    });
    this.particleBursts.push(burst);

    if (this.sfx) this.sfx.machineExplosion();
    // No camera shake for this one - a sudden jolt right as the machine
    // goes up would be exactly the kind of motion that causes discomfort.
    this._shakeTime = 0;
    this._shakeVec.set(0, 0, 0);
    setStatus('TIME MACHINE DESTROYED');
  }

  _updateGuns(delta) {
    if (!this.guns.length) return;
    const origin = new THREE.Vector3();
    const direction = new THREE.Vector3();
    for (const gun of this.guns) {
      gun.cooldown = Math.max(0, gun.cooldown - delta);
      if (gun.firing && gun.cooldown <= 0) {
        gun.cooldown = CONFIG.gun.fireCooldown;
        gun.worldMuzzle(origin, direction);
        this.projectiles.fire(origin, direction);
        if (this.sfx) this.sfx.laserShot(gun.muzzle);
      }
    }
    this.projectiles.update(delta, (pos) => this.droneSwarm && this.droneSwarm.registerHitNear(pos));
  }

  _updateParticleBursts(delta) {
    if (!this.particleBursts.length) return;
    this.particleBursts = this.particleBursts.filter((burst) => !burst.update(delta));
  }

  triggerShake(magnitude, duration) {
    this._shakeMagnitude = magnitude;
    this._shakeDuration = duration;
    this._shakeTime = duration;
  }

  _applyCameraShake(delta) {
    if (this._shakeTime > 0) {
      this._shakeTime = Math.max(0, this._shakeTime - delta);
      const mag = this._shakeMagnitude * (this._shakeTime / this._shakeDuration);
      this._shakeVec.set(
        (Math.random() * 2 - 1) * mag,
        (Math.random() * 2 - 1) * mag,
        (Math.random() * 2 - 1) * mag
      );
    } else {
      this._shakeVec.set(0, 0, 0);
    }
    // Applied to the rig, never the camera directly - in VR the headset
    // pose drives the camera's own local transform every frame, so shaking
    // the camera itself would just get overwritten. The rig is always
    // re-derived from a stable base first (standing spot, or the seat via
    // _teleportToSeat) so the shake never accumulates/drifts.
    if (!this.isSeated) this.playerRig.position.copy(this.standingRigPosition);
    this.playerRig.position.add(this._shakeVec);
  }

  _onResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }
}

/* --------------------------------- Boot / errors ------------------------------------ */

function setStatus(msg, isError) {
  const el = document.getElementById('status');
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle('error', !!isError);
}

window.addEventListener('error', (e) => {
  setStatus('JS ERROR: ' + (e.message || e.error), true);
  console.error(e.error || e.message);
});
window.addEventListener('unhandledrejection', (e) => {
  setStatus('PROMISE ERROR: ' + (e.reason?.message ?? e.reason), true);
  console.error(e.reason);
});

try {
  new TimeMachineApp();
} catch (err) {
  setStatus('INIT ERROR: ' + err.message, true);
  console.error(err);
}