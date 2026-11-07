/**
 * The home page's 3D scene: the sealed enclave as a glass cube over a
 * perspective grid, with the challenge's gates passing through it. One
 * ray-marched WebGL2 fragment shader; no 3D library.
 */

import { useEffect, useRef } from "react";
import { usePrefersReducedMotion } from "../lib/hooks.ts";

const VERTEX = `#version 300 es
in vec2 position;
void main() { gl_Position = vec4(position, 0.0, 1.0); }`;

const FRAGMENT = `#version 300 es
precision highp float;
out vec4 color;
uniform vec2 uRes;
uniform float uTime;
uniform vec3 uBg;
uniform vec3 uAccent;
uniform vec3 uInk;
uniform float uLight;
uniform vec2 uPointer;
uniform float uCenterX;

mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }

const vec3 HALF = vec3(0.78);

vec3 local(vec3 p) {
  p.x -= uCenterX;
  p.y -= 0.07 * sin(uTime * 0.7);
  p.xz *= rot(uTime * 0.2 + uPointer.x * 0.45);
  p.yz *= rot(0.5 - uPointer.y * 0.25);
  p.xy *= rot(0.22);
  return p;
}

float box(vec3 p) {
  vec3 q = abs(local(p)) - HALF + 0.11;
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0) - 0.11;
}

vec3 normalAt(vec3 p) {
  vec2 e = vec2(0.0015, 0.0);
  return normalize(vec3(box(p + e.xyy) - box(p - e.xyy), box(p + e.yxy) - box(p - e.yxy), box(p + e.yyx) - box(p - e.yyx)));
}

float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

void main() {
  vec2 uv = (2.0 * gl_FragCoord.xy - uRes) / uRes.y;
  vec3 ro = vec3(0.0, 0.42, -4.3);
  vec3 target = vec3(uCenterX * 0.35, 0.0, 0.0);
  vec3 fw = normalize(target - ro);
  vec3 rt = normalize(cross(vec3(0.0, 1.0, 0.0), fw));
  vec3 up = cross(fw, rt);
  vec3 rd = normalize(rt * uv.x + up * uv.y + fw * 1.75);

  // Background: the theme colour with a soft accent bloom behind the cube.
  vec2 centre = vec2(uCenterX * 0.42, 0.05);
  float bloom = exp(-length(uv - centre) * (uLight > 0.5 ? 2.4 : 1.9));
  vec3 col = uBg + uAccent * bloom * (uLight > 0.5 ? 0.10 : 0.16);

  // Perspective grid on the floor, drifting toward the viewer.
  float floorY = -1.3;
  if (rd.y < 0.0) {
    float t = (floorY - ro.y) / rd.y;
    vec2 g = (ro + rd * t).xz * 1.1;
    g.y -= uTime * 0.35;
    vec2 cell = abs(fract(g - 0.5) - 0.5) / fwidth(g);
    float line = 1.0 - min(min(cell.x, cell.y), 1.0);
    float fade = exp(-t * 0.16) * smoothstep(0.0, 0.25, -rd.y);
    vec3 gridColour = uLight > 0.5 ? mix(uInk, uAccent, 0.45) : uAccent;
    col = uLight > 0.5 ? mix(col, gridColour, line * fade * 0.3) : col + gridColour * line * fade * 0.42;
  }

  // Ray-march the cube.
  float t = 0.0, hit = -1.0;
  for (int i = 0; i < 72; i++) {
    float d = box(ro + rd * t);
    if (d < 0.0012) { hit = t; break; }
    t += d;
    if (t > 9.0) break;
  }

  // The gates: three lines in the plane through the cube, a pulse sweeping along them.
  float tPlane = -ro.z / rd.z;
  vec3 pp = ro + rd * tPlane;
  float gates = 0.0;
  for (int k = 0; k < 3; k++) {
    float gy = -0.55 + float(k) * 0.55;
    float w = 0.0065 + 0.004 * float(k == 1);
    float line = smoothstep(w, 0.0, abs(pp.y - gy)) * smoothstep(3.6, 1.2, abs(pp.x - uCenterX));
    float sweep = 0.35 + 0.65 * smoothstep(0.55, 0.0, abs(fract(uTime * 0.12 + float(k) * 0.31) * 7.0 - 3.5 - (pp.x - uCenterX)));
    gates += line * sweep;
  }
  bool gatesInFront = hit < 0.0 || tPlane < hit;
  vec3 gateColour = uLight > 0.5 ? mix(uInk, uAccent, 0.65) : mix(uAccent, vec3(1.0), 0.15);

  if (hit > 0.0) {
    vec3 p = ro + rd * hit;
    vec3 n = normalAt(p);
    float fresnel = pow(1.0 - max(dot(n, -rd), 0.0), 2.6);
    vec3 q = abs(local(p));
    vec3 toFace = HALF - q;
    float lo = min(toFace.x, min(toFace.y, toFace.z));
    float hi = max(toFace.x, max(toFace.y, toFace.z));
    float mid = toFace.x + toFace.y + toFace.z - lo - hi;
    float edge = smoothstep(0.075, 0.0, mid);
    // Glass: the background seen through it, tinted, with a lit core.
    float core = exp(-length(cross(rd, vec3(uCenterX, 0.07 * sin(uTime * 0.7), 0.0) - ro)) * 3.2);
    vec3 lightDir = normalize(vec3(-0.5, 0.8, -0.6));
    float spec = pow(max(dot(reflect(rd, n), lightDir), 0.0), 40.0);
    if (uLight > 0.5) {
      // Light theme: frosted glass, with a green rim and deep-green edges
      // blended in, since adding light to near-white only washes it out.
      vec3 c = mix(col, vec3(1.0), 0.3);
      c = mix(c, uAccent, fresnel * 0.5);
      c = mix(c, uAccent * 0.82, edge * 0.85);
      c += uAccent * core * 0.22 + vec3(spec) * 0.4;
      col = c;
    } else {
      vec3 glass = mix(col, uBg * 1.6 + uAccent * 0.04, 0.6);
      col = glass + uAccent * fresnel * 0.55 + uAccent * edge * 1.25 + uAccent * core * 0.42 + vec3(spec) * 0.25;
    }
    gates *= gatesInFront ? 1.0 : 0.35;
  }
  col = uLight > 0.5 ? mix(col, gateColour, clamp(gates, 0.0, 1.0) * 0.55) : col + gateColour * gates * 0.85;

  // Vignette and a little dither against banding.
  col *= 1.0 - 0.18 * dot(uv * 0.55, uv * 0.55) * (uLight > 0.5 ? 0.4 : 1.0);
  col += (hash(gl_FragCoord.xy + uTime) - 0.5) / 255.0;
  color = vec4(col, 1.0);
}`;

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? "shader failed");
  return shader;
}

function cssRgb(name: string): [number, number, number] {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim().split(/\s+/).map(Number);
  return [(value[0] ?? 0) / 255, (value[1] ?? 0) / 255, (value[2] ?? 0) / 255];
}

export function HeroScene() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext("webgl2", { antialias: false, alpha: false, powerPreference: "low-power" });
    if (!gl) {
      canvas.dataset.fallback = "true";
      return;
    }
    let program: WebGLProgram;
    try {
      program = gl.createProgram()!;
      gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX));
      gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT));
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? "link failed");
    } catch {
      canvas.dataset.fallback = "true";
      return;
    }
    gl.useProgram(program);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, "position");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    const u = (name: string) => gl.getUniformLocation(program, name);
    const uniforms = { res: u("uRes"), time: u("uTime"), bg: u("uBg"), accent: u("uAccent"), ink: u("uInk"), light: u("uLight"), pointer: u("uPointer"), centerX: u("uCenterX") };

    const readTheme = () => {
      gl.uniform3fv(uniforms.bg, cssRgb("--scene-bg"));
      gl.uniform3fv(uniforms.accent, cssRgb("--scene-grid"));
      gl.uniform3fv(uniforms.ink, cssRgb("--scene-ink"));
      gl.uniform1f(uniforms.light, cssRgb("--scene-bg")[0] > 0.5 ? 1 : 0);
    };
    const resize = () => {
      const scale = Math.min(window.devicePixelRatio || 1, 1.5);
      canvas.width = Math.round(canvas.clientWidth * scale);
      canvas.height = Math.round(canvas.clientHeight * scale);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.uniform2f(uniforms.res, canvas.width, canvas.height);
      // The cube sits right of the headline on wide screens, behind it on narrow ones.
      gl.uniform1f(uniforms.centerX, canvas.clientWidth > 900 ? 1.55 : 0.0);
    };

    const pointer = { x: 0, y: 0, tx: 0, ty: 0 };
    const onPointer = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      pointer.tx = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.ty = ((event.clientY - rect.top) / rect.height) * 2 - 1;
    };

    let visible = true;
    let frame = 0;
    const start = performance.now();
    const draw = (now: number) => {
      pointer.x += (pointer.tx - pointer.x) * 0.05;
      pointer.y += (pointer.ty - pointer.y) * 0.05;
      gl.uniform2f(uniforms.pointer, pointer.x, pointer.y);
      gl.uniform1f(uniforms.time, reduced ? 6.0 : (now - start) / 1000);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    const loop = (now: number) => {
      draw(now);
      if (visible && !reduced && !document.hidden) frame = requestAnimationFrame(loop);
    };
    const restart = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(loop);
    };

    readTheme();
    resize();
    restart();
    const observer = new IntersectionObserver(([entry]) => {
      visible = Boolean(entry?.isIntersecting);
      if (visible) restart();
    });
    observer.observe(canvas);
    const onResize = () => {
      resize();
      draw(performance.now());
    };
    const onTheme = () => {
      readTheme();
      draw(performance.now());
    };
    const scheme = matchMedia("(prefers-color-scheme: light)");
    window.addEventListener("resize", onResize);
    window.addEventListener("pointermove", onPointer, { passive: true });
    window.addEventListener("bakeoff:theme", onTheme);
    scheme.addEventListener("change", onTheme);
    document.addEventListener("visibilitychange", restart);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", onResize);
      window.removeEventListener("pointermove", onPointer);
      window.removeEventListener("bakeoff:theme", onTheme);
      scheme.removeEventListener("change", onTheme);
      document.removeEventListener("visibilitychange", restart);
    };
  }, [reduced]);

  return <canvas ref={canvasRef} className="hero-scene" aria-hidden="true" />;
}
