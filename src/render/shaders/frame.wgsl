struct Frame {
  view_projection: mat4x4f,
  eye: vec4f,
  body: vec4f,
  smoke: vec4f,
  line: vec4f,
}
@group(0) @binding(0) var<uniform> frame: Frame;
