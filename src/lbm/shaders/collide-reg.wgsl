// Regularized BGK: relax only the projected second moment of the non-equilibrium
// part, which keeps mass and momentum exact on every lattice step.
fn collide(g: array<f32, 19>, equilibrium: array<f32, 19>, rho: f32) -> array<f32, 19> {
  let tau = relaxation_time(g, equilibrium, rho);
  let omega_plus = 1.0 / tau;
  let pi = non_equilibrium_stress(g, equilibrium);
  let trace = pi.xx + pi.yy + pi.zz;
  var post: array<f32, 19>;
  for (var i = 0u; i < 19u; i++) {
    let c = vec3f(C[i]);
    let projected =
      c.x * c.x * pi.xx + c.y * c.y * pi.yy + c.z * c.z * pi.zz +
      2.0 * (c.x * c.y * pi.xy + c.x * c.z * pi.xz + c.y * c.z * pi.yz) -
      trace / 3.0;
    post[i] = equilibrium[i] + (1.0 - omega_plus) * 4.5 * W[i] * projected;
  }
  return post;
}
