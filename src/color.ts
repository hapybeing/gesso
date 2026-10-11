export type RGB = [number, number, number];
export interface HSV { h: number; s: number; v: number; }

export function hsvToRgb({ h, s, v }: HSV): RGB {
  const f = (n: number) => { const k = (n + h * 6) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return [f(5), f(3), f(1)];
}
export function rgbToHsv([r, g, b]: RGB): HSV {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) {
    if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
    h /= 6; if (h < 0) h += 1;
  }
  return { h, s: mx ? d / mx : 0, v: mx };
}
export const toHex = (c: RGB) => '#' + c.map((x) => Math.round(Math.max(0, Math.min(1, x)) * 255).toString(16).padStart(2, '0')).join('');
export function fromHex(s: string): RGB | null {
  const m = s.trim().replace('#', '').match(/^([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as RGB;
}
