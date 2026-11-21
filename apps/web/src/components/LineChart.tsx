"use client";

import { useRef, useState } from "react";

export interface Point {
  x: number; // unix seconds
  y: number;
  label: string; // tooltip line under the value
}

/**
 * One series over time: a 2px line, 8px markers, a recessive grid, a crosshair and tooltip on
 * hover. The page title names the series, so there is no legend.
 */
export function LineChart({ points, format, height = 220, ariaLabel }: { points: Point[]; format: (y: number) => string; height?: number; ariaLabel: string }) {
  const ref = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number>();
  if (points.length < 2) return <div className="card empty">Not enough history to draw yet.</div>;

  const W = 720, H = height, L = 64, R = 16, T = 16, B = 28;
  const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const pad = (Math.max(...ys) - Math.min(...ys)) * 0.15 || Math.abs(ys[0]) * 0.001 || 1;
  const y0 = Math.min(...ys) - pad, y1 = Math.max(...ys) + pad;
  const sx = (x: number) => L + ((x - x0) / (x1 - x0 || 1)) * (W - L - R);
  const sy = (y: number) => T + (1 - (y - y0) / (y1 - y0)) * (H - T - B);
  const path = points.map((p, i) => `${i ? "L" : "M"}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join("");
  const ticks = [0, 0.5, 1].map((f) => y0 + f * (y1 - y0));
  const dates = [x0, (x0 + x1) / 2, x1];
  const fmtDate = (s: number) => new Date(s * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

  const onMove = (e: React.PointerEvent) => {
    const svg = ref.current;
    if (!svg) return;
    const box = svg.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * W;
    let best = 0;
    for (let i = 1; i < points.length; i++) if (Math.abs(sx(points[i].x) - px) < Math.abs(sx(points[best].x) - px)) best = i;
    setHover(best);
  };
  const h = hover !== undefined ? points[hover] : undefined;

  return (
    <div className="chart">
      <svg ref={ref} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={ariaLabel} onPointerMove={onMove} onPointerLeave={() => setHover(undefined)}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={L} x2={W - R} y1={sy(t)} y2={sy(t)} stroke="var(--border)" strokeWidth={1} />
            <text x={L - 8} y={sy(t) + 4} textAnchor="end" className="chart-axis">{format(t)}</text>
          </g>
        ))}
        {dates.map((d, i) => (
          <text key={i} x={sx(d)} y={H - 8} textAnchor={i === 0 ? "start" : i === 2 ? "end" : "middle"} className="chart-axis">{fmtDate(d)}</text>
        ))}
        <path d={path} fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinejoin="round" />
        {points.map((p, i) => (
          <circle key={i} cx={sx(p.x)} cy={sy(p.y)} r={4} fill="var(--accent)" stroke="var(--surface)" strokeWidth={2} />
        ))}
        {h && (
          <g pointerEvents="none">
            <line x1={sx(h.x)} x2={sx(h.x)} y1={T} y2={H - B} stroke="var(--muted)" strokeDasharray="3 3" />
            <circle cx={sx(h.x)} cy={sy(h.y)} r={6} fill="var(--accent)" stroke="var(--surface)" strokeWidth={2} />
          </g>
        )}
      </svg>
      {h && (
        <div
          className="chart-tip"
          style={{
            left: `${(sx(h.x) / W) * 100}%`,
            top: `${(sy(h.y) / H) * 100}%`,
            // keep the tooltip inside the chart near either edge
            transform: `translate(${sx(h.x) > W * 0.7 ? "calc(-100% - 10px)" : sx(h.x) < W * 0.3 ? "10px" : "-50%"}, calc(-100% - 12px))`,
          }}
        >
          <strong>{format(h.y)}</strong>
          <div>{h.label}</div>
          <div className="faint">{new Date(h.x * 1000).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</div>
        </div>
      )}
    </div>
  );
}
