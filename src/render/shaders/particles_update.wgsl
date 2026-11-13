struct Particle { pos: vec4f, prev: vec4f, }
struct Params {
  size: vec4u,
  seed: u32,
  steps: f32,
  padding: vec2u,
  cross_section: vec4f,
  fallback: vec4f,
}
@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read_write> particles: array<Particle>;
@group(0) @binding(2) var<storage, read> macros: array<vec4f>;
@group(0) @binding(3) var<storage, read> geometry: array<u32>;

fn hash(value: u32) -> u32 {
  var h = value;
  h = (h ^ (h >> 16u)) * 0x7feb352du;
  h = (h ^ (h >> 15u)) * 0x846ca68bu;
  return h ^ (h >> 16u);
}
fn cell_index(node: vec3u) -> u32 { return node.x + p.size.x * (node.y + p.size.y * node.z); }
fn fluid(position: vec3f) -> bool {
  if (any(position < vec3f(0.0)) || any(position >= vec3f(p.size.xyz - vec3u(1u)))) { return false; }
  return (geometry[cell_index(vec3u(floor(position + vec3f(0.5))))] & 7u) == 0u;
}
fn velocity(position: vec3f) -> vec3f {
  let point = clamp(position, vec3f(0.0), vec3f(p.size.xyz - vec3u(1u)));
  let lo = vec3u(floor(point));
  let hi = min(lo + vec3u(1u), p.size.xyz - vec3u(1u));
  let weight = fract(point);
  let x00 = mix(macros[cell_index(lo)].yzw, macros[cell_index(vec3u(hi.x, lo.y, lo.z))].yzw, weight.x);
  let x10 = mix(macros[cell_index(vec3u(lo.x, hi.y, lo.z))].yzw, macros[cell_index(vec3u(hi.x, hi.y, lo.z))].yzw, weight.x);
  let x01 = mix(macros[cell_index(vec3u(lo.x, lo.y, hi.z))].yzw, macros[cell_index(vec3u(hi.x, lo.y, hi.z))].yzw, weight.x);
  let x11 = mix(macros[cell_index(vec3u(lo.x, hi.y, hi.z))].yzw, macros[cell_index(hi)].yzw, weight.x);
  return mix(mix(x00, x10, weight.y), mix(x01, x11, weight.y), weight.z);
}
fn respawn(id: u32, generation: f32) -> Particle {
  let h = hash(id + p.seed + u32(generation) * 0x9e3779b9u);
  // Use the high 24 bits so rounding never turns the fraction into 1.0.
  let random = vec2f(f32(h >> 8u), f32(hash(h) >> 8u)) / 16777216.0;
  let yz = mix(p.cross_section.xy, p.cross_section.zw, random);
  var point = vec3f(2.0, yz);
  if (!fluid(point)) { point = vec3f(2.0, p.fallback.xy); }
  return Particle(vec4f(point, 0.0), vec4f(point, generation));
}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) invocation: vec3u, @builtin(num_workgroups) groups: vec3u) {
  let id = invocation.x + invocation.y * groups.x * 64u;
  if (id >= p.size.w) { return; }
  let old = particles[id];
  var delta = velocity(old.pos.xyz) * p.steps;
  delta /= max(1.0, length(delta));
  let point = old.pos.xyz + delta;
  let age = old.pos.w + 1.0;
  if (point.x >= f32(p.size.x - 2u) || !fluid(point) || age > 4000.0) {
    particles[id] = respawn(id, old.prev.w + 1.0);
  } else {
    particles[id] = Particle(vec4f(point, age), vec4f(old.pos.xyz, old.prev.w));
  }
}
