const NO_Q: u32 = 0xffffffffu;

// walls == 1 applies linear Bouzidi interpolation with the packed fraction of this link.
// A cell without fractions, or a short link whose second node is not fluid, keeps halfway
// bounce-back. The CPU reference uses the same expressions in the same order.
fn wall_value(i: u32, n: u32, position: vec3u, flag: u32) -> f32 {
  let j = opp(i);
  let reflected = load_in(j, n);
  if (p.walls == 0u) { return reflected; }
  let base = geometry[p.cells + n];
  if (base == NO_Q) { return reflected; }
  let rank = countOneBits((flag >> 3u) & ((1u << i) - 1u));
  let q = bitcast<f32>(geometry[2u * p.cells + base + rank]);
  if (q == 0.5) { return reflected; }
  if (q < 0.5) {
    let second = idx_wrapped(position, C[i]);
    if ((geometry[second] & CELL_TYPE_MASK) != FLUID) { return reflected; }
    return 2.0 * q * reflected + (1.0 - 2.0 * q) * load_in(j, second);
  }
  return (reflected + (2.0 * q - 1.0) * load_in(i, n)) / (2.0 * q);
}
