// Draws a scene's squares with WebGL2: one instanced draw call, the animation computed on the GPU
// from each square's from, to and timing, so a frame costs one uniform and one draw.
import { STRIDE } from "./scene";

const VERTEX = `#version 300 es
layout(location = 0) in vec4 a_from;
layout(location = 1) in vec4 a_to;
layout(location = 2) in vec4 a_time;
layout(location = 3) in vec2 a_alpha;
uniform float u_now;
uniform float u_cell;
uniform vec2 u_origin;
uniform vec2 u_size;
uniform float u_dpr;
uniform float u_radius;
uniform vec4 u_ease[2];
uniform vec3 u_colors[13];
// 0 draws every square; 1 draws only the marks: lit squares narrower than u_mark, ringed.
uniform float u_pass;
uniform float u_mark;
out vec2 v_local;
out vec2 v_half;
out float v_radius;
out float v_ring;
out vec4 v_color;

float bez(float a, float b, float t) {
  float u = 1.0 - t;
  return 3.0 * u * u * t * a + 3.0 * u * t * t * b + t * t * t;
}
// The same Newton steps as ease() in scene.ts.
float ease(vec4 c, float x) {
  if (x <= 0.0) return 0.0;
  if (x >= 1.0) return 1.0;
  float t = x;
  for (int i = 0; i < 8; i++) {
    float u = 1.0 - t;
    float slope = 3.0 * u * u * c.x + 6.0 * u * t * (c.z - c.x) + 3.0 * t * t * (1.0 - c.z);
    if (abs(slope) < 1e-6) break;
    t = clamp(t - (bez(c.x, c.z, t) - x) / slope, 0.0, 1.0);
  }
  return bez(c.y, c.w, t);
}

void main() {
  float p = a_time.y > 0.0 ? clamp((u_now - a_time.x) / a_time.y, 0.0, 1.0) : 1.0;
  float e = ease(u_ease[int(a_time.z)], p);
  vec4 r = mix(a_from, a_to, e);
  float alpha = clamp(mix(a_alpha.x, a_alpha.y, min(1.0, p * 1.6)), 0.0, 1.0);
  vec2 lo = u_origin + r.xy * u_cell;
  vec2 hi = lo + r.zw * u_cell;
  // A rectangle at rest sits on whole device pixels, so its edges and gaps are sharp.
  if (p >= 1.0) {
    lo = floor(lo + 0.5);
    hi = floor(hi + 0.5);
  }
  // A one-pixel seam on each side wide enough to spare it; thinner ones meet their neighbour.
  float px = max(1.0, floor(u_dpr + 0.5));
  hi -= min(floor((hi - lo) / 4.0), vec2(px));
  v_ring = 0.0;
  if (u_pass > 0.5) {
    // A small lit square drawn again at least u_mark wide, centred, in a ring of its own, so one
    // transaction among thousands dimmed can be found.
    if (a_alpha.y < 0.999 || min(hi.x - lo.x, hi.y - lo.y) >= u_mark) {
      gl_Position = vec4(2.0, 2.0, 0.0, 1.0);
      return;
    }
    v_ring = px * 1.5;
    vec2 c = (lo + hi) * 0.5;
    vec2 ext = max(hi - lo, vec2(u_mark)) * 0.5 + v_ring;
    lo = floor(c - ext + 0.5);
    hi = floor(c + ext + 0.5);
  }
  vec2 corner = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1));
  v_half = max((hi - lo) * 0.5, vec2(0.0));
  v_local = (corner - 0.5) * (hi - lo);
  v_radius = min(u_radius, min(v_half.x, v_half.y) * 0.5);
  v_color = vec4(u_colors[int(a_time.w)], alpha);
  gl_Position = vec4(mix(lo, hi, corner) / u_size * vec2(2.0, -2.0) + vec2(-1.0, 1.0), 0.0, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision mediump float;
in vec2 v_local;
in vec2 v_half;
in float v_radius;
in float v_ring;
in vec4 v_color;
uniform vec3 u_ring;
out vec4 o;
void main() {
  vec2 q = abs(v_local) - v_half + v_radius;
  float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - v_radius;
  float a = clamp(0.5 - d, 0.0, 1.0) * v_color.a;
  vec3 rgb = v_ring > 0.0 ? mix(v_color.rgb, u_ring, clamp(d + v_ring + 0.5, 0.0, 1.0)) : v_color.rgb;
  o = vec4(rgb * a, a);
}`;

/** Where and how big the grid is drawn, in device pixels. */
export interface View {
  /** Canvas size. */
  width: number;
  height: number;
  /** Top left of the grid's first cell. */
  originX: number;
  originY: number;
  /** One cell. */
  cell: number;
  dpr: number;
  /** Corner radius of a square. */
  radius: number;
  /** Lit squares narrower than this are drawn again this wide, ringed; 0 draws no marks. */
  mark: number;
}

/** The squares' RGB colors (the fee bands, then the coinbase), the two easing curves, the ring's color. */
export interface Paint {
  colors: Float32Array;
  ease: Float32Array;
  ring: Float32Array;
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  return shader;
}

/** The GPU side. Everything here is lost with the context and built again by {@link init}. */
export class Renderer {
  readonly gl: WebGL2RenderingContext;
  private program: WebGLProgram | null = null;
  private buffer: WebGLBuffer | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private count = 0;
  private readonly uniforms = new Map<string, WebGLUniformLocation | null>();

  private constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
  }

  /** A renderer on this canvas, or null when the browser has no WebGL2 or it fails to start. */
  static create(canvas: HTMLCanvasElement): Renderer | null {
    const gl = canvas.getContext("webgl2", {
      alpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: true,
      powerPreference: "low-power",
    });
    if (!gl) return null;
    const r = new Renderer(gl);
    return r.init() ? r : null;
  }

  /** Builds the program and buffers; again after a lost context is restored. */
  init(): boolean {
    const { gl } = this;
    const vs = compile(gl, gl.VERTEX_SHADER, VERTEX);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT);
    const program = gl.createProgram();
    if (!vs || !fs) return false;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    // A lost context also fails here, which is not an error: the restore builds it again.
    if (gl.getProgramParameter(program, gl.LINK_STATUS) !== true) return false;
    this.program = program;
    this.uniforms.clear();
    const vao = gl.createVertexArray();
    const buffer = gl.createBuffer();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    for (let i = 0; i < 4; i++) {
      gl.enableVertexAttribArray(i);
      gl.vertexAttribPointer(i, i < 3 ? 4 : 2, gl.FLOAT, false, STRIDE * 4, i * 16);
      gl.vertexAttribDivisor(i, 1);
    }
    gl.bindVertexArray(null);
    this.vao = vao;
    this.buffer = buffer;
    this.count = 0;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    return true;
  }

  /** Replaces every square's record. */
  upload(data: Float32Array): void {
    const { gl } = this;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    this.count = data.length / STRIDE;
  }

  private at(name: string): WebGLUniformLocation | null {
    if (!this.uniforms.has(name) && this.program) {
      this.uniforms.set(name, this.gl.getUniformLocation(this.program, name));
    }
    return this.uniforms.get(name) ?? null;
  }

  /** One frame at `now`, ms after the scene's epoch. */
  draw(now: number, view: View, paint: Paint): void {
    const { gl } = this;
    if (!this.program) return;
    gl.viewport(0, 0, view.width, view.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (this.count === 0) return;
    gl.useProgram(this.program);
    gl.uniform1f(this.at("u_now"), now);
    gl.uniform1f(this.at("u_cell"), view.cell);
    gl.uniform2f(this.at("u_origin"), view.originX, view.originY);
    gl.uniform2f(this.at("u_size"), view.width, view.height);
    gl.uniform1f(this.at("u_dpr"), view.dpr);
    gl.uniform1f(this.at("u_radius"), view.radius);
    gl.uniform4fv(this.at("u_ease"), paint.ease);
    gl.uniform3fv(this.at("u_colors"), paint.colors);
    gl.uniform3fv(this.at("u_ring"), paint.ring);
    gl.uniform1f(this.at("u_mark"), view.mark);
    gl.uniform1f(this.at("u_pass"), 0);
    gl.bindVertexArray(this.vao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.count);
    if (view.mark > 0) {
      gl.uniform1f(this.at("u_pass"), 1);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.count);
    }
    gl.bindVertexArray(null);
  }
}

/** A CSS color as RGB from 0 to 1: `#rgb`, `#rrggbb` or `rgb()`, as the tokens and browsers write them. */
export function parseColor(css: string): [number, number, number] | undefined {
  const s = css.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(s)?.[1];
  if (hex !== undefined) {
    const full = hex.length === 3 ? hex.replaceAll(/./g, "$&$&") : hex;
    return [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16) / 255) as [
      number,
      number,
      number,
    ];
  }
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(s);
  if (rgb) return [Number(rgb[1]) / 255, Number(rgb[2]) / 255, Number(rgb[3]) / 255];
  return undefined;
}

/** A CSS `cubic-bezier(…)` as its four numbers. */
export function parseBezier(css: string): [number, number, number, number] | undefined {
  const m = /cubic-bezier\(([^)]*)\)/.exec(css);
  const n = m?.[1]?.split(",").map(Number);
  return n?.length === 4 && n.every((v) => Number.isFinite(v))
    ? [n[0] ?? 0, n[1] ?? 0, n[2] ?? 1, n[3] ?? 1]
    : undefined;
}
