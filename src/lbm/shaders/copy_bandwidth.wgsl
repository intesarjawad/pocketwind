@group(0) @binding(0) var<storage, read> input_data: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> output_data: array<vec4f>;

@compute @workgroup_size(256)
fn main(
  @builtin(global_invocation_id) gid: vec3u,
  @builtin(num_workgroups) workgroups: vec3u,
) {
  let index = gid.x + gid.y * workgroups.x * 256u;
  if (index >= arrayLength(&input_data)) { return; }
  output_data[index] = input_data[index];
}
