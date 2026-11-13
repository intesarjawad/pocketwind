// The four stilts the Ahmed body stands on, measured from the nose along x and
// from the symmetry plane along y. They run from the floor (z = 0) up to the
// underside of the body.

module stilts() {
    diameter = 30;
    length = 50;
    for (x = [202, 672], side = [-1, 1])
        translate([x, side * 163.5, 0])
            cylinder(d = diameter, h = length);
}

stilts();
