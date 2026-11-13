// Smoke puffs on the body's centre plane, carried by the solver's own velocity.
// Each thread is a ring of puffs in release order; record = (x, z, release index, density).
struct Smoke {
  size: vec4u,  // nx, ny, nz, plane y
  ring: vec4u,  // threads, slots, newest release, releasing this frame
  rake: vec4f,  // x, lowest z, highest z, solver steps this frame
}
@group(0) @binding(0) var<uniform> s: Smoke;
@group(0) @binding(1) var<storage, read_write> smoke: array<vec4f>;
@group(0) @binding(2) var<storage, read> macros: array<vec4f>;
@group(0) @binding(3) var<storage, read> geometry: array<u32>;
// The last threads are dye ports on the body: x, z per port, or -1 where there is none.
@group(0) @binding(4) var<storage, read> ports: array<vec2f>;

fn cell(x: u32, z: u32) -> u32 { return x + s.size.x * (s.size.w + s.size.y * z); }

fn solid(p: vec2f) -> bool {
  if (p.x < 0.0 || p.y < 0.0 || p.x > f32(s.size.x - 1u) || p.y > f32(s.size.z - 1u)) { return true; }
  let node = vec2u(floor(p + vec2f(0.5)));
  return (geometry[cell(node.x, node.y)] & 7u) != 0u;
}

fn velocity(p: vec2f) -> vec2f {
  let q = clamp(p, vec2f(0.0), vec2f(f32(s.size.x - 2u), f32(s.size.z - 2u)));
  let lo = vec2u(floor(q));
  let f = q - vec2f(lo);
  let a = macros[cell(lo.x, lo.y)].yw;
  let b = macros[cell(lo.x + 1u, lo.y)].yw;
  let c = macros[cell(lo.x, lo.y + 1u)].yw;
  let d = macros[cell(lo.x + 1u, lo.y + 1u)].yw;
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

// One RK2 step of a puff (x, z, density). Smoke cannot enter a wall: a blocked step keeps
// only its slide along the wall, and some of the puff settles there each time, so smoke
// never piles up. Smoke that can move nowhere leaves the thread at (-1, -1).
fn carry(puff: vec3f, h: f32, settle: f32) -> vec3f {
  let first = velocity(puff.xy);
  var step = h * velocity(puff.xy + 0.5 * h * first);
  step /= max(1.0, length(step));
  var next = puff.xy + step;
  var density = puff.z;
  if (solid(next)) {
    density *= settle;
    if (!solid(vec2f(next.x, puff.y))) {
      next.y = puff.y;
    } else if (!solid(vec2f(puff.x, next.y))) {
      next.x = puff.x;
    } else {
      next = vec2f(-1.0);
    }
  }
  return vec3f(next, density);
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) invocation: vec3u, @builtin(num_workgroups) groups: vec3u) {
  let id = invocation.x + invocation.y * groups.x * 64u;
  if (id >= s.ring.x * s.ring.y) { return; }
  let thread = id / s.ring.y;
  if (s.ring.w == 1u && id % s.ring.y == s.ring.z % s.ring.y) {
    let rake = s.ring.x - arrayLength(&ports);
    if (thread < rake) {
      let height = mix(s.rake.y, s.rake.z, f32(thread) / f32(max(rake, 2u) - 1u));
      smoke[id] = vec4f(s.rake.x, height, f32(s.ring.z), 1.0);
    } else {
      let port = ports[thread - rake];
      smoke[id] = vec4f(port, f32(s.ring.z), select(0.0, 1.0, port.x >= 0.0));
    }
    return;
  }
  let puff = smoke[id];
  if (puff.w == 0.0) { return; }
  // A frame can hold many solver steps; sub-steps of at most half a cell keep the smoke
  // with the flow however many there are.
  let h = s.rake.w;
  let count = u32(clamp(ceil(2.0 * h * length(velocity(puff.xy))), 1.0, 16.0));
  let settle = pow(0.85, 1.0 / f32(count));
  var state = vec3f(puff.xy, puff.w);
  for (var i = 0u; i < count && state.x >= 0.0; i++) {
    state = carry(state, h / f32(count), settle);
  }
  let alive = all(state == state) && state.x >= 0.0 && state.x < f32(s.size.x - 2u) && state.z > 0.02;
  smoke[id] = vec4f(state.xy, puff.z, select(0.0, state.z, alive));
}
