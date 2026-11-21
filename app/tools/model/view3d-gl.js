// The 3D view's drawing in WebGL2 (view3d.js, docs/tools/model-3d.md): the shaders, the
// buffers of the meshes view3d-mesh.js builds, and the matrices of the camera. It is
// written for WebGL2 directly, with no library: five small programs, one for surfaces (the
// block, the cut and the water table), one for wells (instanced cylinders), one for lines
// a few pixels wide (pathlines, outlines, the water table on the cut), one for particles,
// and nothing else. The matrix functions at the top need no WebGL and are tested in Node.
//
// Model coordinates go in (x east and y north of the grid's south-west corner, z the
// elevation, in metres); the vertex shaders take off the model's centre, turn it by the
// grid's rotation and multiply z by the vertical exaggeration. So changing the exaggeration
// or the cut changes uniforms only, and the meshes are built once for a model.

// ---- matrices (column-major, as WebGL takes them) ----

export function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
  return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
}

export function lookAt(eye, target, up) {
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const norm = (a) => { const l = Math.hypot(...a) || 1; return a.map((v) => v / l); };
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const z = norm(sub(eye, target)), x = norm(cross(up, z)), y = cross(z, x);
  return new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1]);
}

export function multiply(a, b) {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
    out[c * 4 + r] = s;
  }
  return out;
}

/** The point p (world) on a canvas of w × h px: [x, y] from the top left, or null behind the eye. */
export function project(m, p, w, h) {
  const x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12];
  const y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
  const q = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
  if (!(q > 1e-9)) return null;
  return [((x / q) * 0.5 + 0.5) * w, (0.5 - (y / q) * 0.5) * h];
}

/**
 * The camera's eye and matrices for an orbit about target (world, exaggerated):
 * azimuth (radians anticlockwise from east, the direction the eye looks from), elevation
 * (radians above the horizon) and distance. Returns { eye, view, proj, viewProj }.
 */
export function orbit({ target, azimuth, elevation, distance, fovy }, aspect, radius) {
  const ce = Math.cos(elevation);
  const eye = [target[0] + distance * ce * Math.cos(azimuth), target[1] + distance * ce * Math.sin(azimuth), target[2] + distance * Math.sin(elevation)];
  const view = lookAt(eye, target, [0, 0, 1]);
  const near = Math.max(distance - radius * 2, distance / 200), far = distance + radius * 3;
  const proj = perspective(fovy, aspect, near, far);
  return { eye, view, proj, viewProj: multiply(proj, view) };
}

// ---- shaders ----

// The transform every vertex shader shares: from model coordinates to the world the camera
// looks at.
const TO_WORLD = `
uniform mat4 u_viewProj;
uniform vec3 u_origin;
uniform float u_ve;
uniform vec2 u_rot;
vec3 toWorld(vec3 p) {
  vec3 q = p - u_origin;
  return vec3(u_rot.x * q.x - u_rot.y * q.y, u_rot.y * q.x + u_rot.x * q.y, q.z * u_ve);
}
vec3 normalToWorld(vec3 n) {
  vec3 m = vec3(u_rot.x * n.x - u_rot.y * n.y, u_rot.y * n.x + u_rot.x * n.y, n.z / u_ve);
  return normalize(m);
}`;

// Soft light: a sky above and ground below, a key light from the north-west and a little
// from the eye, so no face is black and the relief reads.
const LIGHT = `
uniform vec3 u_eye;
uniform vec3 u_key;
vec3 shade(vec3 base, vec3 n, vec3 world, float gloss) {
  vec3 v = normalize(u_eye - world);
  if (dot(n, v) < 0.0) n = -n;
  float key = max(dot(n, u_key), 0.0);
  float fill = max(dot(n, v), 0.0);
  float sky = 0.5 + 0.5 * n.z;
  vec3 c = base * (0.24 + 0.16 * sky + 0.52 * key + 0.14 * fill);
  vec3 h = normalize(u_key + v);
  c += gloss * pow(max(dot(n, h), 0.0), 60.0) * vec3(1.0);
  return c;
}`;

const SURFACE_VS = `#version 300 es
precision highp float;
${TO_WORLD}
in vec3 a_position; in vec3 a_normal; in vec2 a_grid; in float a_layer; in float a_kind; in float a_fixed; in float a_value; in float a_wt;
out vec3 v_world; out vec3 v_model; out vec3 v_normal; out vec2 v_grid; out float v_layer; out float v_kind; out float v_fixed; out float v_value; out float v_wt;
uniform float u_lift;
void main() {
  v_model = a_position;
  v_world = toWorld(a_position) + vec3(0.0, 0.0, u_lift);
  v_normal = normalToWorld(a_normal);
  v_grid = a_grid; v_layer = a_layer; v_kind = a_kind; v_fixed = a_fixed; v_value = a_value; v_wt = a_wt;
  gl_Position = u_viewProj * vec4(v_world, 1.0);
}`;

const SURFACE_FS = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2DArray;
${LIGHT}
in vec3 v_world; in vec3 v_model; in vec3 v_normal; in vec2 v_grid; in float v_layer; in float v_kind; in float v_fixed; in float v_value; in float v_wt;
uniform int u_mode;            // 0 the layers' colours; 1 the value's colour
uniform sampler2D u_layers;    // one colour per layer
uniform sampler2D u_ramp;      // the colour scale, 256 colours
uniform usampler2DArray u_codes; // what each cell is (view3d-mesh.js CODES)
uniform bool u_useCodes;
uniform vec3 u_codeColours[7];
uniform vec4 u_scale;          // lo, hi, log (1) or linear (0), 0
uniform vec4 u_contour;        // interval, base, on, line width (px)
uniform vec2 u_gridLines;      // strength of cell lines, of layer lines
uniform vec3 u_clip;           // x and y the cut keeps east and north of; on
uniform float u_alpha;
uniform float u_gloss;
uniform vec3 u_ink;
uniform int u_faces;           // 0 every face; 1 all but the faces looking up; 2 only those
out vec4 outColour;

float line(float coord, float width) {
  float w = fwidth(coord);
  float d = abs(fract(coord - 0.5) - 0.5) / max(w, 1e-6);
  // Lines fade out where cells are under about 4 px, so a fine grid does not go grey.
  float fade = clamp((1.0 / max(w, 1e-6) - 3.0) / 6.0, 0.0, 1.0);
  return (1.0 - clamp(d - width * 0.5 + 0.5, 0.0, 1.0)) * fade;
}

void main() {
  if (u_clip.z > 0.5 && v_model.x < u_clip.x && v_model.y < u_clip.y) discard;
  bool up = v_kind < 0.5 && v_normal.z > 0.0;
  if ((u_faces == 1 && up) || (u_faces == 2 && !up)) discard;
  int layer = int(v_layer + 0.5);
  vec3 base = texelFetch(u_layers, ivec2(layer, 0), 0).rgb;
  uint code = 0u;
  if (u_useCodes) {
    ivec3 size = textureSize(u_codes, 0);
    ivec2 cell;
    if (v_kind < 0.5) cell = ivec2(floor(v_grid.x), floor(v_grid.y));
    else if (abs(v_normal.x) > abs(v_normal.y)) cell = ivec2(int(v_fixed + 0.5), floor(v_grid.x));
    else cell = ivec2(floor(v_grid.x), int(v_fixed + 0.5));
    cell = clamp(cell, ivec2(0), size.xy - 1);
    code = texelFetch(u_codes, ivec3(cell, layer), 0).r;
  }
  bool valued = u_mode == 1 && v_value < 1e37 && v_model.z <= v_wt + 1e-4 * max(1.0, abs(v_wt));
  if (valued) {
    float t;
    if (u_scale.z > 0.5) t = (log(max(v_value, u_scale.x)) - log(u_scale.x)) / max(log(u_scale.y) - log(u_scale.x), 1e-9);
    else t = (v_value - u_scale.x) / max(u_scale.y - u_scale.x, 1e-30);
    base = texture(u_ramp, vec2(clamp(t, 0.0, 1.0) * (255.0 / 256.0) + 0.5 / 256.0, 0.5)).rgb;
  } else if (code > 0u && code < 6u) {
    // A boundary cell's top in its colour; its sides, which may be a whole edge of the model,
    // tinted, so the layers still read through them.
    base = mix(base, u_codeColours[code], v_kind < 0.5 ? 0.85 : 0.6);
  }
  if (code == 6u) {
    // Dry: hatched in the dry colour.
    float s = step(0.5, fract((gl_FragCoord.x + gl_FragCoord.y) / 9.0));
    base = mix(base, u_codeColours[6], 0.35 + 0.45 * s);
  }
  vec3 c = shade(base, normalize(v_normal), v_world, valued ? u_gloss : 0.0);
  float ink = 0.0;
  if (v_kind < 0.5) ink = max(line(v_grid.x, 1.0), line(v_grid.y, 1.0)) * u_gridLines.x;
  else ink = max(line(v_grid.x, 1.0) * u_gridLines.x, line(v_grid.y, 1.4) * u_gridLines.y);
  if (valued && u_contour.z > 0.5) {
    float k = (v_value - u_contour.y) / u_contour.x;
    float w = fwidth(k);
    float d = abs(fract(k - 0.5) - 0.5) / max(w, 1e-6);
    // Every fifth contour is drawn heavier, as on a topographic map.
    float major = abs(mod(floor(k + 0.5), 5.0)) < 0.5 ? 1.6 : 1.0;
    float l = 1.0 - clamp(d - u_contour.w * major * 0.5 + 0.5, 0.0, 1.0);
    // Not where the value is flat: a constant head exactly on a level is no line.
    l *= clamp(1.6 - w * 3.0, 0.0, 1.0) * smoothstep(0.0004, 0.0015, w);
    ink = max(ink, l * 0.75);
  }
  c = mix(c, u_ink, ink);
  float alpha = u_alpha;
  if (u_faces == 2) {
    // A clear land surface is a faint film with its grid lines, and its boundary cells stay
    // nearly solid, so a river still reads over the water table under it.
    alpha = code > 0u && code < 6u ? 0.85 : mix(u_alpha, 0.75, ink);
  }
  outColour = vec4(c, alpha);
}`;

const ROD_VS = `#version 300 es
precision highp float;
${TO_WORLD}
in vec3 a_unit; in vec3 a_unitNormal;
in vec3 a_at;      // x, y, radius (m)
in vec4 a_z;       // bottom and top z (m), and the lift of each in exaggerated metres
in vec4 a_colour;
out vec3 v_world; out vec3 v_normal; out vec4 v_colour;
void main() {
  vec3 p = vec3(a_at.xy + a_unit.xy * a_at.z, mix(a_z.x, a_z.y, a_unit.z));
  v_world = toWorld(p) + vec3(0.0, 0.0, mix(a_z.z, a_z.w, a_unit.z));
  v_normal = normalize(vec3(u_rot.x * a_unitNormal.x - u_rot.y * a_unitNormal.y, u_rot.y * a_unitNormal.x + u_rot.x * a_unitNormal.y, a_unitNormal.z));
  v_colour = a_colour;
  gl_Position = u_viewProj * vec4(v_world, 1.0);
}`;

const ROD_FS = `#version 300 es
precision highp float;
${LIGHT}
in vec3 v_world; in vec3 v_normal; in vec4 v_colour;
uniform float u_alpha;
out vec4 outColour;
void main() { outColour = vec4(shade(v_colour.rgb, normalize(v_normal), v_world, 0.25), v_colour.a * u_alpha); }`;

const LINE_VS = `#version 300 es
precision highp float;
${TO_WORLD}
in vec2 a_corner;        // which end (0 or 1), which side (-1 or 1)
in vec4 a_p0; in vec4 a_p1; // the ends, each with its value (travel time, or anything below 0)
uniform vec2 u_viewport; // px
uniform float u_width;   // px
uniform float u_lift;    // exaggerated metres
uniform float u_bias;    // pulls the line towards the eye in depth
out float v_side; out float v_value;
void main() {
  vec4 c0 = u_viewProj * vec4(toWorld(a_p0.xyz) + vec3(0.0, 0.0, u_lift), 1.0);
  vec4 c1 = u_viewProj * vec4(toWorld(a_p1.xyz) + vec3(0.0, 0.0, u_lift), 1.0);
  vec2 s0 = c0.xy / max(c0.w, 1e-6) * u_viewport * 0.5, s1 = c1.xy / max(c1.w, 1e-6) * u_viewport * 0.5;
  vec2 d = s1 - s0;
  d = length(d) > 1e-6 ? normalize(d) : vec2(1.0, 0.0);
  vec2 n = vec2(-d.y, d.x);
  vec4 c = mix(c0, c1, a_corner.x);
  vec2 off = (n * a_corner.y + d * (a_corner.x * 2.0 - 1.0) * 0.5) * u_width * 0.5;
  c.xy += off / (u_viewport * 0.5) * c.w;
  c.z -= u_bias * c.w;
  v_side = a_corner.y;
  v_value = mix(a_p0.w, a_p1.w, a_corner.x);
  gl_Position = c;
}`;

const LINE_FS = `#version 300 es
precision highp float;
in float v_side; in float v_value;
uniform sampler2D u_ramp;
uniform vec3 u_range;     // lo, hi of the value on a log scale, ramp on (1)
uniform vec3 u_colour;
uniform vec3 u_halo;
uniform float u_alpha;
out vec4 outColour;
void main() {
  vec3 c = u_colour;
  if (u_range.z > 0.5) {
    float t = (log(max(v_value, u_range.x)) - log(u_range.x)) / max(log(u_range.y) - log(u_range.x), 1e-9);
    c = texture(u_ramp, vec2(clamp(t, 0.0, 1.0) * (255.0 / 256.0) + 0.5 / 256.0, 0.5)).rgb;
  }
  float e = smoothstep(0.45, 0.9, abs(v_side));
  outColour = vec4(mix(c, u_halo, e), u_alpha);
}`;

const POINT_VS = `#version 300 es
precision highp float;
${TO_WORLD}
in vec4 a_point; // x, y, z, moving (1) or stopped (0)
uniform float u_size;
out float v_moving;
void main() {
  gl_Position = u_viewProj * vec4(toWorld(a_point.xyz), 1.0);
  gl_Position.z -= 0.002 * gl_Position.w;
  gl_PointSize = a_point.w > 0.5 ? u_size : u_size * 0.7;
  v_moving = a_point.w;
}`;

const POINT_FS = `#version 300 es
precision highp float;
in float v_moving;
uniform vec3 u_colour; uniform vec3 u_halo; uniform float u_alpha;
out vec4 outColour;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r = dot(p, p);
  if (r > 1.0) discard;
  float lit = 0.75 + 0.25 * (1.0 - r) - 0.25 * p.y;
  vec3 c = r > 0.55 ? u_halo : u_colour * lit;
  outColour = vec4(c, u_alpha * (v_moving > 0.5 ? 1.0 : 0.7));
}`;

function compile(gl, vs, fs) {
  const make = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost()) throw new Error(`3D view shader: ${gl.getShaderInfoLog(s)}`);
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, make(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, make(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !gl.isContextLost()) throw new Error(`3D view program: ${gl.getProgramInfoLog(p)}`);
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS), u = {};
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(p, i), name = info.name.replace(/\[0\]$/, '');
    u[name] = gl.getUniformLocation(p, info.name);
  }
  const attrs = {};
  const na = gl.getProgramParameter(p, gl.ACTIVE_ATTRIBUTES);
  for (let i = 0; i < na; i++) { const info = gl.getActiveAttrib(p, i); attrs[info.name] = gl.getAttribLocation(p, info.name); }
  return { p, u, attrs };
}

// A unit cylinder: radius 1 about the z axis, from z 0 to 1, with its two ends closed.
function cylinder(sides = 18) {
  const pos = [], nrm = [];
  const push = (p, n) => { pos.push(...p); nrm.push(...n); };
  for (let s = 0; s < sides; s++) {
    const a0 = (s / sides) * 2 * Math.PI, a1 = ((s + 1) / sides) * 2 * Math.PI;
    const c0 = [Math.cos(a0), Math.sin(a0)], c1 = [Math.cos(a1), Math.sin(a1)];
    const n0 = [c0[0], c0[1], 0], n1 = [c1[0], c1[1], 0];
    push([...c0, 0], n0); push([...c1, 0], n1); push([...c1, 1], n1);
    push([...c0, 0], n0); push([...c1, 1], n1); push([...c0, 1], n0);
    push([0, 0, 1], [0, 0, 1]); push([...c0, 1], [0, 0, 1]); push([...c1, 1], [0, 0, 1]);
    push([0, 0, 0], [0, 0, -1]); push([...c1, 0], [0, 0, -1]); push([...c0, 0], [0, 0, -1]);
  }
  return { position: new Float32Array(pos), normal: new Float32Array(nrm), count: pos.length / 3 };
}

const hexRgb = (h) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(h).trim());
  if (!m) return [0.5, 0.5, 0.5];
  const v = parseInt(m[1], 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
};
export { hexRgb };

/**
 * The renderer on a WebGL2 context. Meshes are given with set…(), and draw(frame) draws
 * one frame: frame holds the camera's matrices and eye, the origin, rotation and
 * exaggeration, the cut, the colours and what is shown (view3d.js says what each is).
 * dispose() frees everything it made.
 */
export function renderer(gl) {
  const progs = {
    surface: compile(gl, SURFACE_VS, SURFACE_FS),
    rod: compile(gl, ROD_VS, ROD_FS),
    line: compile(gl, LINE_VS, LINE_FS),
    point: compile(gl, POINT_VS, POINT_FS),
  };
  const made = { buffers: [], vaos: [], textures: [] };
  const buffer = (data, target = gl.ARRAY_BUFFER, usage = gl.STATIC_DRAW) => {
    const b = gl.createBuffer();
    gl.bindBuffer(target, b);
    gl.bufferData(target, data, usage);
    made.buffers.push(b);
    return b;
  };
  const forget = (vao) => {
    if (!vao) return;
    gl.deleteVertexArray(vao.vao);
    for (const b of vao.buffers) gl.deleteBuffer(b);
  };

  // A surface mesh (view3d-mesh.js): each attribute it has in its own buffer; those it has
  // not are given as constants.
  const SURFACE_WIDTHS = { position: 3, normal: 3, grid: 2, layer: 1, kind: 1, fixed: 1, value: 1, wt: 1 };
  const SURFACE_CONST = { layer: 0, kind: 0, fixed: 0, value: 0, wt: 3e38 };
  function surfaceVao(mesh) {
    const { attrs } = progs.surface;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const buffers = [];
    const consts = {};
    for (const [name, w] of Object.entries(SURFACE_WIDTHS)) {
      const loc = attrs[`a_${name}`];
      if (loc === undefined) continue;
      if (mesh[name]) {
        const b = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, b);
        gl.bufferData(gl.ARRAY_BUFFER, mesh[name], gl.STATIC_DRAW);
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, w, gl.FLOAT, false, 0, 0);
        buffers.push(b);
      } else {
        gl.disableVertexAttribArray(loc);
        consts[loc] = SURFACE_CONST[name];
      }
    }
    const ib = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.index, gl.STATIC_DRAW);
    buffers.push(ib);
    gl.bindVertexArray(null);
    return { vao, buffers, count: mesh.index.length, consts };
  }

  const quad = buffer(new Float32Array([0, -1, 1, -1, 1, 1, 0, -1, 1, 1, 0, 1]));
  function lineVao(segments) {
    // segments: [x0, y0, z0, v0, x1, y1, z1, v1, ...]
    const { attrs } = progs.line;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.enableVertexAttribArray(attrs.a_corner);
    gl.vertexAttribPointer(attrs.a_corner, 2, gl.FLOAT, false, 0, 0);
    const b = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, segments, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(attrs.a_p0);
    gl.vertexAttribPointer(attrs.a_p0, 4, gl.FLOAT, false, 32, 0);
    gl.vertexAttribDivisor(attrs.a_p0, 1);
    gl.enableVertexAttribArray(attrs.a_p1);
    gl.vertexAttribPointer(attrs.a_p1, 4, gl.FLOAT, false, 32, 16);
    gl.vertexAttribDivisor(attrs.a_p1, 1);
    gl.bindVertexArray(null);
    return { vao, buffers: [b], count: segments.length / 8 };
  }

  const unit = cylinder();
  const unitPos = buffer(unit.position), unitNrm = buffer(unit.normal);
  function rodVao(instances) {
    // instances: Float32Array of [x, y, r, z0, z1, lift0, lift1, red, green, blue, alpha] each.
    const { attrs } = progs.rod;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, unitPos);
    gl.enableVertexAttribArray(attrs.a_unit);
    gl.vertexAttribPointer(attrs.a_unit, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, unitNrm);
    gl.enableVertexAttribArray(attrs.a_unitNormal);
    gl.vertexAttribPointer(attrs.a_unitNormal, 3, gl.FLOAT, false, 0, 0);
    const b = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, instances, gl.STATIC_DRAW);
    const stride = 11 * 4;
    [['a_at', 3, 0], ['a_z', 4, 3], ['a_colour', 4, 7]].forEach(([n, w, o]) => {
      gl.enableVertexAttribArray(attrs[n]);
      gl.vertexAttribPointer(attrs[n], w, gl.FLOAT, false, stride, o * 4);
      gl.vertexAttribDivisor(attrs[n], 1);
    });
    gl.bindVertexArray(null);
    return { vao, buffers: [b], count: instances.length / 11 };
  }

  let pointsVao = null, pointsBuf = null, pointsCount = 0;
  function setPoints(points) {
    const { attrs } = progs.point;
    if (!pointsVao) {
      pointsVao = gl.createVertexArray();
      gl.bindVertexArray(pointsVao);
      pointsBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, pointsBuf);
      gl.enableVertexAttribArray(attrs.a_point);
      gl.vertexAttribPointer(attrs.a_point, 4, gl.FLOAT, false, 0, 0);
      gl.bindVertexArray(null);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, pointsBuf);
    gl.bufferData(gl.ARRAY_BUFFER, points || new Float32Array(0), gl.DYNAMIC_DRAW);
    pointsCount = points ? points.length / 4 : 0;
  }

  // Textures: the colour scales (256 × 1), the layers' colours (nlay × 1) and the cells' codes.
  const texture = () => { const t = gl.createTexture(); made.textures.push(t); return t; };
  const tex = { ramp: texture(), time: texture(), layers: texture(), codes: texture() };
  function colourTexture(t, colours) {
    const data = new Uint8Array(colours.length * 4);
    colours.forEach((c, i) => data.set([Math.round(c[0] * 255), Math.round(c[1] * 255), Math.round(c[2] * 255), 255], i * 4));
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, colours.length, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }
  let codeSize = null;
  function setCodes(codes, nlay, nrow, ncol) {
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex.codes);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    const key = `${nlay}|${nrow}|${ncol}`;
    if (codeSize !== key) {
      gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.R8UI, ncol, nrow, nlay, 0, gl.RED_INTEGER, gl.UNSIGNED_BYTE, codes);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      codeSize = key;
    } else {
      gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, 0, ncol, nrow, nlay, gl.RED_INTEGER, gl.UNSIGNED_BYTE, codes);
    }
  }

  const meshes = { block: null, section: [], surface: null, rods: null, lines: {} };
  const set = {
    block(mesh) { forget(meshes.block); meshes.block = mesh ? surfaceVao(mesh) : null; },
    sections(list) { meshes.section.forEach(forget); meshes.section = list.filter((m) => m.index.length).map(surfaceVao); },
    surface(mesh) { forget(meshes.surface); meshes.surface = mesh && mesh.index.length ? surfaceVao(mesh) : null; },
    rods(instances) { forget(meshes.rods); meshes.rods = instances && instances.length ? rodVao(instances) : null; },
    lines(name, segments) { forget(meshes.lines[name]); meshes.lines[name] = segments && segments.length ? lineVao(segments) : null; },
    points: setPoints,
    codes: setCodes,
    ramp: (colours) => colourTexture(tex.ramp, colours),
    timeRamp: (colours) => colourTexture(tex.time, colours),
    layers: (colours) => colourTexture(tex.layers, colours),
  };

  function common(prog, f) {
    const { u } = prog;
    gl.useProgram(prog.p);
    gl.uniformMatrix4fv(u.u_viewProj, false, f.viewProj);
    gl.uniform3fv(u.u_origin, f.origin);
    gl.uniform1f(u.u_ve, f.ve);
    gl.uniform2f(u.u_rot, Math.cos(f.rotation), Math.sin(f.rotation));
    if (u.u_eye) gl.uniform3fv(u.u_eye, f.eye);
    if (u.u_key) gl.uniform3fv(u.u_key, f.key);
  }

  function drawSurface(vao, f, o) {
    const { u } = progs.surface;
    gl.uniform1i(u.u_mode, o.mode);
    gl.uniform1i(u.u_useCodes, o.codes ? 1 : 0);
    gl.uniform1f(u.u_alpha, o.alpha);
    gl.uniform1f(u.u_gloss, o.gloss || 0);
    gl.uniform1f(u.u_lift, o.lift || 0);
    gl.uniform1i(u.u_faces, o.faces || 0);
    gl.uniform3f(u.u_clip, f.clip[0], f.clip[1], o.clip ? 1 : 0);
    gl.uniform2f(u.u_gridLines, o.gridLines ? f.gridLines[0] : 0, o.layerLines === false ? 0 : f.gridLines[1]);
    gl.uniform4f(u.u_contour, f.contour.interval || 1, f.contour.base || 0, o.contours && f.contour.interval > 0 ? 1 : 0, f.contour.width);
    gl.bindVertexArray(vao.vao);
    for (const [loc, v] of Object.entries(vao.consts)) gl.vertexAttrib1f(Number(loc), v);
    gl.drawElements(gl.TRIANGLES, vao.count, gl.UNSIGNED_INT, 0);
  }

  function drawLines(name, f, o) {
    const m = meshes.lines[name];
    if (!m) return;
    const { u } = progs.line;
    gl.uniform2f(u.u_viewport, f.width, f.height);
    gl.uniform1f(u.u_width, o.width * f.dpr);
    gl.uniform1f(u.u_lift, o.lift || 0);
    gl.uniform1f(u.u_bias, o.bias || 0);
    gl.uniform3f(u.u_range, o.range ? o.range[0] : 1, o.range ? o.range[1] : 1, o.range ? 1 : 0);
    gl.uniform3fv(u.u_colour, o.colour);
    gl.uniform3fv(u.u_halo, o.halo || o.colour);
    gl.uniform1f(u.u_alpha, o.alpha);
    gl.bindVertexArray(m.vao);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, m.count);
  }

  /** Draws one frame. */
  function draw(f) {
    gl.viewport(0, 0, f.width, f.height);
    gl.clearColor(f.background[0], f.background[1], f.background[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    gl.depthMask(true);

    const s = progs.surface;
    common(s, f);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex.layers); gl.uniform1i(s.u.u_layers, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, tex.ramp); gl.uniform1i(s.u.u_ramp, 1);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex.codes); gl.uniform1i(s.u.u_codes, 2);
    gl.uniform3fv(s.u.u_codeColours, f.codeColours);
    gl.uniform4f(s.u.u_scale, f.scale.lo, f.scale.hi, f.scale.log ? 1 : 0, 0);
    gl.uniform3fv(s.u.u_ink, f.ink);
    // A glass block is solid but for the faces that look up (the land surface), which are
    // drawn last and faintly, over the water table under them.
    const glass = f.show.block === 'glass';
    const solid = f.show.block === 'solid' || glass, clear = f.show.block === 'clear';
    // The block's faces are pushed back a little, so the cut's faces and lines laid on them win.
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(1, 1);
    if (solid && meshes.block) drawSurface(meshes.block, f, { mode: 0, codes: true, alpha: 1, clip: true, gridLines: f.show.grid, faces: glass ? 1 : 0 });
    gl.disable(gl.POLYGON_OFFSET_FILL);
    if (f.show.block !== 'hidden') for (const m of meshes.section) drawSurface(m, f, { mode: f.show.cutValues ? 1 : 0, codes: true, alpha: 1, clip: false, gridLines: f.show.grid, contours: f.show.contours });

    // Wells, lines and particles that are in front of the block.
    const rods = () => {
      if (!meshes.rods) return;
      common(progs.rod, f);
      gl.bindVertexArray(meshes.rods.vao);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, unit.count, meshes.rods.count);
    };
    const lines = (alpha) => {
      common(progs.line, f);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex.time); gl.uniform1i(progs.line.u.u_ramp, 0);
      for (const l of f.lines) drawLines(l.name, f, { ...l, alpha: l.alpha * alpha });
    };
    const points = (alpha) => {
      if (!pointsCount) return;
      common(progs.point, f);
      const { u } = progs.point;
      gl.uniform1f(u.u_size, 7 * f.dpr);
      gl.uniform3fv(u.u_colour, f.particle);
      gl.uniform3fv(u.u_halo, f.halo);
      gl.uniform1f(u.u_alpha, alpha);
      gl.bindVertexArray(pointsVao);
      gl.drawArrays(gl.POINTS, 0, pointsCount);
    };
    gl.useProgram(progs.rod.p); gl.uniform1f(progs.rod.u.u_alpha, 1);
    if (f.show.wells) rods();
    lines(1);
    points(1);

    // The water table, see-through, over what is drawn.
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    if (f.show.surface && meshes.surface) {
      common(s, f);
      drawSurface(meshes.surface, f, { mode: 1, codes: false, alpha: f.surfaceAlpha, clip: f.show.block !== 'hidden', gridLines: false, layerLines: false, contours: f.show.contours, gloss: 0.18 });
    }
    if (glass && meshes.block) {
      common(s, f);
      gl.depthMask(false);
      // Pulled forward, so it covers a water table that lies on the land surface evenly.
      gl.enable(gl.POLYGON_OFFSET_FILL);
      gl.polygonOffset(-1, -1);
      drawSurface(meshes.block, f, { mode: 0, codes: true, alpha: 0.18, clip: true, gridLines: f.show.grid, faces: 2 });
      gl.disable(gl.POLYGON_OFFSET_FILL);
      gl.depthMask(true);
    }

    // What the solid block hides is shown faintly through it, so a well's screen or a
    // pathline under the land surface can be seen.
    if (solid) {
      gl.depthFunc(gl.GREATER);
      gl.depthMask(false);
      gl.useProgram(progs.rod.p); gl.uniform1f(progs.rod.u.u_alpha, 0.3);
      if (f.show.wells) rods();
      lines(0.3);
      points(0.35);
      gl.depthFunc(gl.LEQUAL);
      gl.depthMask(true);
    }
    // A see-through block: its faces over everything, faintly.
    if (clear && meshes.block) {
      common(s, f);
      gl.depthMask(false);
      drawSurface(meshes.block, f, { mode: 0, codes: true, alpha: 0.2, clip: true, gridLines: false });
      gl.depthMask(true);
    }
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
  }

  function dispose() {
    forget(meshes.block); meshes.section.forEach(forget); forget(meshes.surface); forget(meshes.rods);
    Object.values(meshes.lines).forEach(forget);
    if (pointsVao) { gl.deleteVertexArray(pointsVao); gl.deleteBuffer(pointsBuf); }
    made.buffers.forEach((b) => gl.deleteBuffer(b));
    made.textures.forEach((t) => gl.deleteTexture(t));
    Object.values(progs).forEach((p) => gl.deleteProgram(p.p));
  }

  return { set, draw, dispose };
}
