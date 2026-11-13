const C = array<vec3i, 19>(
  vec3i(0, 0, 0),
  vec3i(1, 0, 0), vec3i(-1, 0, 0),
  vec3i(0, 1, 0), vec3i(0, -1, 0),
  vec3i(0, 0, 1), vec3i(0, 0, -1),
  vec3i(1, 1, 0), vec3i(-1, -1, 0),
  vec3i(1, 0, 1), vec3i(-1, 0, -1),
  vec3i(0, 1, 1), vec3i(0, -1, -1),
  vec3i(1, -1, 0), vec3i(-1, 1, 0),
  vec3i(1, 0, -1), vec3i(-1, 0, 1),
  vec3i(0, 1, -1), vec3i(0, -1, 1),
);

const W = array<f32, 19>(
  1.0 / 3.0,
  1.0 / 18.0, 1.0 / 18.0, 1.0 / 18.0,
  1.0 / 18.0, 1.0 / 18.0, 1.0 / 18.0,
  1.0 / 36.0, 1.0 / 36.0, 1.0 / 36.0,
  1.0 / 36.0, 1.0 / 36.0, 1.0 / 36.0,
  1.0 / 36.0, 1.0 / 36.0, 1.0 / 36.0,
  1.0 / 36.0, 1.0 / 36.0, 1.0 / 36.0,
);

const FLUID: u32 = 0u;
const SOLID: u32 = 1u;
const SUPPORT: u32 = 2u;
const FLOOR: u32 = 3u;
const EQ: u32 = 4u;
const CELL_TYPE_MASK: u32 = 7u;

// Twelve scalars occupy 48 bytes. cs_term is 18 * sqrt(2) * Cs * Cs.
// walls is 0 for halfway bounce-back; nu is in lattice units.
struct Params {
  nx: u32,
  ny: u32,
  nz: u32,
  cells: u32,
  u_in: f32,
  nu: f32,
  cs_term: f32,
  lambda: f32,
  les: u32,
  walls: u32,
  write_macro: u32,
  step: u32,
}

@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read> in_a: array<pop>;
@group(0) @binding(2) var<storage, read> in_b: array<pop>;
@group(0) @binding(3) var<storage, read> in_c: array<pop>;
@group(0) @binding(4) var<storage, read_write> out_a: array<pop>;
@group(0) @binding(5) var<storage, read_write> out_b: array<pop>;
@group(0) @binding(6) var<storage, read_write> out_c: array<pop>;
@group(0) @binding(7) var<storage, read> geometry: array<u32>;
@group(0) @binding(8) var<storage, read_write> macros: array<vec4f>;

fn idx(x: u32, y: u32, z: u32) -> u32 {
  return x + p.nx * (y + p.ny * z);
}

// EQ inlet/outlet layers keep fluid pulls inside x. y and z are periodic;
// FLOOR and EQ layers intercept z pulls when the floor is enabled.
fn idx_wrapped(position: vec3u, offset: vec3i) -> u32 {
  let size = vec3i(i32(p.nx), i32(p.ny), i32(p.nz));
  let source = (vec3i(position) + offset + size) % size;
  return idx(u32(source.x), u32(source.y), u32(source.z));
}

fn opp(i: u32) -> u32 {
  if (i == 0u) { return 0u; }
  if ((i & 1u) == 1u) { return i + 1u; }
  return i - 1u;
}

fn is_wall(kind: u32) -> bool {
  return kind == SOLID || kind == SUPPORT || kind == FLOOR;
}

fn has_wall(flag: u32, i: u32) -> bool {
  return (flag & (1u << (3u + i))) != 0u;
}

fn geq(i: u32, rho_delta: f32, velocity: vec3f) -> f32 {
  let cu = dot(vec3f(C[i]), velocity);
  return W[i] * (rho_delta + (1.0 + rho_delta) *
    (3.0 * cu + 4.5 * cu * cu - 1.5 * dot(velocity, velocity)));
}

struct Stress {
  xx: f32,
  yy: f32,
  zz: f32,
  xy: f32,
  xz: f32,
  yz: f32,
}

// Stored populations are deviations from W, so the stress uses g - geq.
fn non_equilibrium_stress(g: array<f32, 19>, equilibrium: array<f32, 19>) -> Stress {
  var stress = Stress(0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
  for (var i = 0u; i < 19u; i++) {
    let c = vec3f(C[i]);
    let neq = g[i] - equilibrium[i];
    stress.xx += c.x * c.x * neq;
    stress.yy += c.y * c.y * neq;
    stress.zz += c.z * c.z * neq;
    stress.xy += c.x * c.y * neq;
    stress.xz += c.x * c.z * neq;
    stress.yz += c.y * c.z * neq;
  }
  return stress;
}

fn relaxation_time(g: array<f32, 19>, equilibrium: array<f32, 19>, rho: f32) -> f32 {
  let tau0 = 3.0 * p.nu + 0.5;
  if (p.les == 0u) { return tau0; }
  let pi = non_equilibrium_stress(g, equilibrium);
  let q = pi.xx * pi.xx + pi.yy * pi.yy + pi.zz * pi.zz +
    2.0 * (pi.xy * pi.xy + pi.xz * pi.xz + pi.yz * pi.yz);
  return 0.5 * (tau0 + sqrt(tau0 * tau0 + p.cs_term * sqrt(q) / rho));
}

fn load_in(i: u32, n: u32) -> f32 {
  switch (i / 7u) {
    case 0u: { return f32(in_a[i * p.cells + n]) / POP_SCALE; }
    default: {
      if (i < 13u) { return f32(in_b[(i - 7u) * p.cells + n]) / POP_SCALE; }
      return f32(in_c[(i - 13u) * p.cells + n]) / POP_SCALE;
    }
  }
}

fn store_out(i: u32, n: u32, value: f32) {
  let stored = encode_population(value * POP_SCALE, i, n);
  switch (i / 7u) {
    case 0u: { out_a[i * p.cells + n] = stored; }
    default: {
      if (i < 13u) { out_b[(i - 7u) * p.cells + n] = stored; }
      else { out_c[(i - 13u) * p.cells + n] = stored; }
    }
  }
}

fn store_equilibrium(n: u32, rho_delta: f32, velocity: vec3f) {
  for (var i = 0u; i < 19u; i++) {
    store_out(i, n, geq(i, rho_delta, velocity));
  }
  if (p.write_macro == 1u) { macros[n] = vec4f(1.0 + rho_delta, velocity); }
}
