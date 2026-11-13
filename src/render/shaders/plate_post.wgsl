// Halation, the body card and the plate's ground, composed into the canvas.
struct Post {
  size: vec4f,    // target width, height, ground y, grain seed
  lamp: vec4f,    // lamp x, y, reach, bloom strength
  ground: vec4f,  // ground colour, top fade height
  smoke: vec4f,
  card: vec4f,
}
@group(0) @binding(0) var<uniform> p: Post;
@group(0) @binding(1) var source: texture_2d<f32>;
@group(0) @binding(2) var linear: sampler;
@group(1) @binding(0) var light: texture_2d<f32>;
@group(1) @binding(1) var mask: texture_2d<f32>;

@vertex fn vertex(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let corner = vec2f(f32((index << 1u) & 2u), f32(index & 2u));
  return vec4f(corner * 2.0 - 1.0, 0.0, 1.0);
}

// Nine linear taps cover seventeen texels of a Gaussian with sigma near four.
const OFFSETS = array<f32, 3>(1.3846153846, 3.2307692308, 5.0769230769);
const WEIGHTS = array<f32, 3>(0.3162162162, 0.0702702703, 0.0094594595);
const CENTRE = 0.2270270270;

// Halation spreads light, not hot spots: a pixel can feed it no more than a lit crest does.
fn tap(uv: vec2f) -> vec4f { return min(textureSampleLevel(source, linear, uv, 0.0), vec4f(1.5)); }

fn blur(uv: vec2f, axis: vec2f) -> vec4f {
  var sum = tap(uv) * CENTRE;
  for (var i = 0u; i < 3u; i++) {
    let offset = axis * OFFSETS[i];
    sum += tap(uv + offset) * WEIGHTS[i];
    sum += tap(uv - offset) * WEIGHTS[i];
  }
  return sum;
}

@fragment fn blurX(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let size = vec2f(textureDimensions(source));
  // Reading the full-size light at half resolution, two source texels per step.
  return blur(position.xy * 2.0 / size, vec2f(2.0 / size.x, 0.0));
}

@fragment fn blurY(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let size = vec2f(textureDimensions(source));
  return blur(position.xy / size, vec2f(0.0, 1.0 / size.y));
}

fn hash(q: vec2f) -> f32 {
  let h = dot(q, vec2f(127.1, 311.7)) + p.size.w;
  return fract(sin(h) * 43758.5453);
}

fn parts(pixel: vec2f) -> vec2f {
  let limit = vec2i(textureDimensions(mask)) - vec2i(1);
  return textureLoad(mask, clamp(vec2i(pixel), vec2i(0), limit), 0).rg;
}

fn coverage(pixel: vec2f) -> f32 { return parts(pixel).r; }

@fragment fn compose(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let pixel = position.xy;
  let uv = pixel / p.size.xy;
  let toLamp = p.lamp.xy - pixel;
  let falloff = exp(-dot(toLamp, toLamp) / (p.lamp.z * p.lamp.z));
  var colour = p.ground.rgb + vec3f(0.075, 0.071, 0.064) * falloff;

  // Below the ground line is the tunnel floor, the box edge in the old photographs.
  let below = pixel.y > p.size.z + 0.5;
  if (below) { colour = p.ground.rgb * 1.6 + vec3f(0.01) * falloff; }
  let rule = 1.0 - smoothstep(0.0, 1.2, abs(pixel.y - p.size.z));

  let body = coverage(pixel);
  let d = 1.5;
  let gradient = vec2f(
    coverage(pixel + vec2f(d, 0.0)) - coverage(pixel - vec2f(d, 0.0)),
    coverage(pixel + vec2f(0.0, d)) - coverage(pixel - vec2f(0.0, d)),
  );
  let edge = clamp(length(gradient), 0.0, 1.0);
  let outward = -gradient / max(length(gradient), 1e-4);
  let facing = max(dot(outward, normalize(toLamp)), 0.0);
  let height = clamp((p.size.z - pixel.y) / (0.25 * p.size.y), 0.0, 1.0);
  let card = p.card.rgb * (0.45 + 0.55 * height) * (0.6 + 0.4 * falloff);
  // Stilts stand behind the plane of smoke: a dimmer card that the threads cross, with a
  // faint rim so they read as stilts wherever the smoke in front of them is thin.
  let stilt = parts(pixel).g * (1.0 - body);
  let stiltEdge = clamp(length(vec2f(
    parts(pixel + vec2f(d, 0.0)).g - parts(pixel - vec2f(d, 0.0)).g,
    parts(pixel + vec2f(0.0, d)).g - parts(pixel - vec2f(0.0, d)).g,
  )), 0.0, 1.0) * (1.0 - body) * (1.0 - rule);
  colour = mix(colour, card * 0.55, stilt);
  colour = mix(colour, card, body);

  // Threads pressed against the body crowd into a few pixels; dimming them there keeps
  // the boundary layer a soft line rather than a row of specks.
  let w = 4.0;
  let wall = max(
    max(coverage(pixel + vec2f(0.0, w)), coverage(pixel - vec2f(0.0, w))),
    max(coverage(pixel + vec2f(w, 0.0)), coverage(pixel - vec2f(w, 0.0))),
  );
  // Smoke trapped in a corner eddy retraces the same few pixels; near a wall the light is
  // capped, so it cannot burn into a speck.
  let r = 9.0;
  let near = max(
    max(coverage(pixel + vec2f(0.0, r)), coverage(pixel - vec2f(0.0, r))),
    max(coverage(pixel + vec2f(r, 0.0)), coverage(pixel - vec2f(r, 0.0))),
  );
  // Over a convex crest the threads squeeze together and step over the cells of the wall;
  // a wider, gentler cap keeps them from fusing into a bright burr along it. It reaches
  // only above and below the body, so the dye leaving the base is not dimmed there.
  let q = 20.0;
  let crowded = max(coverage(pixel + vec2f(0.0, q)), coverage(pixel - vec2f(0.0, q)));
  let raw = textureLoad(light, vec2i(pixel), 0).rgb * (1.0 - body) * (1.0 - 0.6 * wall);
  let threads = min(raw, vec3f(min(mix(6.0, 0.6, max(near, wall)), mix(6.0, 0.3, crowded))));
  let glow = textureSampleLevel(source, linear, uv, 0.0).rgb * p.lamp.w * (1.0 - 0.7 * crowded);
  colour += vec3f(1.0) - exp(-(threads + glow) * 1.35);
  // The card's rim catches the lamp only faintly, so a curved body has no bright outline.
  colour += p.smoke.rgb * edge * (0.08 + 0.3 * facing);
  colour += p.smoke.rgb * stiltEdge * 0.1;
  colour += p.smoke.rgb * rule * 0.22 * select(1.0, 0.0, body > 0.5);

  colour = mix(p.ground.rgb, colour, clamp(pixel.y / p.ground.w, 0.0, 1.0));
  let grain = (hash(floor(pixel)) - 0.5) * 0.045;
  return vec4f(max(colour + grain, vec3f(0.0)), 1.0);
}
