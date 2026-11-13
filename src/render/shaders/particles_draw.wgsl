struct Particle { pos: vec4f, prev: vec4f, }
@group(0) @binding(1) var<storage, read> particles: array<Particle>;
@vertex fn vertex(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let particle = particles[index / 2u];
  let point = select(particle.prev.xyz, particle.pos.xyz, (index & 1u) == 1u);
  return frame.view_projection * vec4f(point, 1.0);
}
@fragment fn fragment() -> @location(0) vec4f { return frame.smoke; }
