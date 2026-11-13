// Each smoke thread is drawn as a lit tube: the triangles are a fixed grid, and the
// vertex stage places them along the puffs, so nothing is rebuilt on the CPU.
struct View {
  map: vec4f,    // device px per cell, origin x, ground y, front fade length px
  size: vec4f,   // target width, height, tube radius px, nominal puff spacing in cells
  ring: vec4u,   // threads, slots, newest release, rake threads (the rest are dye ports)
  lamp: vec4f,   // lamp x, y, height above the plate (device px), tear distance in cells
  smoke: vec4f,  // smoke colour, releases per flow-through
  wake: vec4f,   // x of the body's base in cells, rake threads drawn one in this many
}
// Dye spreads to twice its width over this many flow-throughs.
const SPREAD_FLOW_THROUGHS = 4.5;
const PORT_FADE = vec2f(3.5, 6.0);
@group(0) @binding(0) var<uniform> v: View;
@group(0) @binding(1) var<storage, read> smoke: array<vec4f>;

struct Out {
  @builtin(position) position: vec4f,
  @location(0) across: f32,
  @location(1) radius: f32,
  @location(2) light: f32,
  @location(3) normal: vec2f,
  @location(4) pixel: vec2f,
  @location(5) soft: f32,
}

fn puff(thread: u32, index: i32) -> vec4f {
  if (index < 0 || index > i32(v.ring.z)) { return vec4f(0.0); }
  let record = smoke[thread * v.ring.y + u32(index) % v.ring.y];
  // A recycled slot holds a newer puff; the one asked for has left the ring.
  if (record.w == 0.0 || record.z != f32(index)) { return vec4f(0.0); }
  return record;
}

fn screen(p: vec2f) -> vec2f { return vec2f(v.map.y + p.x * v.map.x, v.map.z - p.y * v.map.x); }

fn joined(a: vec4f, b: vec4f) -> bool {
  return a.w != 0.0 && b.w != 0.0 && distance(a.xy, b.xy) <= v.lamp.w;
}

@vertex fn vertex(@builtin(vertex_index) vertex: u32, @builtin(instance_index) thread: u32) -> Out {
  var out: Out;
  out.position = vec4f(2.0, 2.0, 2.0, 1.0);
  if (thread < v.ring.w && thread % u32(v.wake.y) != 0u) { return out; }
  let segment = i32(vertex / 6u);
  let corner = vertex % 6u;
  let newer = i32(v.ring.z) - segment;
  let a = puff(thread, newer);
  let b = puff(thread, newer - 1);
  if (!joined(a, b)) { return out; }

  let older = corner == 1u || corner == 4u || corner == 5u;
  let side = select(-1.0, 1.0, corner == 2u || corner == 3u || corner == 5u);
  let index = select(newer, newer - 1, older);
  let here = select(a, b, older);
  // Neighbours in release order give each puff one tangent, shared by both of its segments.
  let ahead = puff(thread, index + 1);
  let behind = puff(thread, index - 1);
  let front = select(here.xy, ahead.xy, joined(here, ahead));
  let back = select(here.xy, behind.xy, joined(here, behind));
  var tangent = screen(front) - screen(back);
  if (dot(tangent, tangent) < 1e-8) { tangent = screen(a.xy) - screen(b.xy); }
  tangent = normalize(tangent);
  let normal = vec2f(-tangent.y, tangent.x);

  let neighbours = f32(i32(joined(here, ahead)) + i32(joined(here, behind)));
  let spacing = distance(front, back) / max(neighbours, 1.0);
  let stretch = max(spacing / v.size.w, 0.02);
  // Dye diffuses as it ages: a puff widens with the root of its age and dims as it widens,
  // so smoke held in dead air spreads into a dim cloud instead of piling up bright.
  let flowThroughs = f32(i32(v.ring.z) - index) / v.smoke.w;
  // Smoke behind the base laps the recirculation every few flow-throughs. It is drawn
  // only for its first two laps, so the roll-up reads as an open spiral with free ends
  // rather than every closed orbit filled with old smoke; port dye there is denser than
  // the rake's smoke and keeps its width until then.
  let inWake = here.x > v.wake.x;
  let port = thread >= v.ring.w && inWake;
  let spread = select(min(sqrt(1.0 + 3.0 * flowThroughs / SPREAD_FLOW_THROUGHS), 4.0), 1.0, port);
  let lapsed = select(1.0, 1.0 - smoothstep(PORT_FADE.x, PORT_FADE.y, flowThroughs), inWake);
  // The front of a thread tapers and fades over a fixed length on screen, so a slow front,
  // where puffs bunch, reads as smoke rather than a flat stub or a spark.
  let oldest = max(i32(v.ring.z) - i32(v.ring.y) + 1, 0);
  let soft = 1.0 - 1.0 / spread;
  let tip = smoothstep(0.0, v.map.w, f32(index - oldest) * spacing * v.map.x);
  // Threads differ in weight, as smoke from a real rake does; the hash keeps each one's.
  let weight = 0.5 + 1.0 * fract(sin(f32(thread) * 12.9898) * 43758.547);
  // Stretched smoke thins and dims; a tube keeps its area as it lengthens.
  let radius = v.size.z * weight * clamp(inverseSqrt(stretch), 0.5, 1.4) * spread * mix(tip, 1.0, soft);
  // Overlapping segments keep the brightest light, not the sum (see the blend state), so
  // bunched smoke reads as one dense tube.
  let density = clamp(pow(1.0 / stretch, 0.8), 0.12, 1.0);
  // Smoke fades in over its first puffs, and dye fades in over its first cells from the
  // port, where it lingers against the body: a port is never a point of light.
  let source = puff(thread, i32(v.ring.z));
  // Behind the base the dye moves off at once, so it fades in over less than a cell and
  // the bubble starts at the base rather than a cell and a half behind it.
  let fadeIn = select(vec2f(0.3, 1.5), vec2f(0.0, 0.6), inWake);
  let travelled = select(1.0, smoothstep(fadeIn.x, fadeIn.y, distance(here.xy, source.xy)), thread >= v.ring.w && source.w != 0.0);
  // Dye that has barely left its port in a flow-through sits in a dead corner beside the
  // body; left to build there it reads as a grey block rather than smoke, so it fades out.
  // Behind the base it is circling the bubble back past its port, so it stays.
  let pace = distance(here.xy, source.xy) / max(f32(i32(v.ring.z) - index) * v.size.w, 1e-3);
  let pastBase = smoothstep(v.wake.x, v.wake.x + 3.0, here.x);
  let stalled = select(1.0, mix(smoothstep(0.02, 0.08, pace), 1.0, max(pastBase, 1.0 - smoothstep(0.5, 1.0, flowThroughs))), thread >= v.ring.w && source.w != 0.0);
  let born = smoothstep(0.0, 6.0, f32(i32(v.ring.z) - index)) * travelled * stalled;
  // Rake threads sit at different depths across the span, so each burns at its own
  // brightness; the port dye, released on the centre plane, keeps full light.
  let depth = select(0.45 + 0.55 * fract(sin(f32(thread) * 78.233) * 43758.547), 1.0, thread >= v.ring.w);
  let light = density * here.w * tip * born * lapsed * depth / (spread * spread);

  let extent = radius + 1.0;
  let pixel = screen(here.xy) + normal * side * extent;
  out.position = vec4f(pixel.x / v.size.x * 2.0 - 1.0, 1.0 - pixel.y / v.size.y * 2.0, 0.0, 1.0);
  out.across = side * extent;
  out.radius = radius;
  out.light = light;
  out.normal = normal;
  out.pixel = pixel;
  out.soft = soft;
  return out;
}

@fragment fn fragment(in: Out) -> @location(0) vec4f {
  let distanceFromAxis = abs(in.across);
  // A fresh thread is a tube with a crisp edge; diffused dye thins out toward its edge.
  let edge = distanceFromAxis / max(in.radius, 0.5);
  let coverage = mix(clamp(in.radius + 0.5 - distanceFromAxis, 0.0, 1.0), exp(-3.0 * edge * edge), in.soft);
  // The offset from the spine is the tube's surface normal, tilted toward the viewer.
  let s = clamp(in.across / max(in.radius, 0.5), -1.0, 1.0);
  let n = vec3f(in.normal * s, sqrt(max(0.0, 1.0 - s * s)));
  let toLamp = normalize(vec3f(v.lamp.xy - in.pixel, v.lamp.z));
  let diffuse = max(dot(n, toLamp), 0.0);
  // A crest narrower than about a pixel lands between pixel centres on some threads and
  // on them on others, which reads as moiré across the rake; a thin tube's crest widens.
  let shininess = clamp(in.radius * in.radius * 1.5, 4.0, 36.0);
  let sheen = pow(max(dot(n, normalize(toLamp + vec3f(0.0, 0.0, 1.0))), 0.0), shininess);
  // One lamp lights the box, so threads near it burn brighter, as on the old plates.
  let offset = (v.lamp.xy - in.pixel) / v.lamp.z;
  let near = exp(-dot(offset, offset));
  // A dark flank and a hot crest make the tube read as round rather than as a stroke.
  let lit = mix(0.05 + 0.8 * diffuse + 2.4 * sheen, 0.6, in.soft);
  let energy = in.light * lit * (0.55 + 0.9 * near) * coverage;
  return vec4f(v.smoke.rgb * energy, energy);
}
