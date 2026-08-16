import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CandlestickSeries,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import type { ChartLevel, ChartPayload, ChartZone } from "../api";

/**
 * Candles are drawn by lightweight-charts; Smart Money geometry is drawn on an
 * SVG layer positioned over the canvas. The chart owns the coordinate system,
 * so the overlay re-projects every zone and level whenever the visible range,
 * the price scale or the container size changes.
 */

export type LayerId =
  | "structure"
  | "bos"
  | "choch"
  | "liquidity"
  | "sweeps"
  | "fvg"
  | "orderBlocks"
  | "supplyDemand"
  | "trade";

export const LAYERS: { id: LayerId; label: string; color: string }[] = [
  { id: "structure", label: "Structure (HH/HL/LH/LL)", color: "#685cf6" },
  { id: "bos", label: "Break of structure", color: "#0da8c4" },
  { id: "choch", label: "Change of character", color: "#c37a14" },
  { id: "liquidity", label: "Liquidity (BSL/SSL)", color: "#8e98ac" },
  { id: "sweeps", label: "Liquidity sweeps", color: "#db4e6d" },
  { id: "fvg", label: "Fair value gaps", color: "#0da8c4" },
  { id: "orderBlocks", label: "Order blocks", color: "#685cf6" },
  { id: "supplyDemand", label: "Supply / demand", color: "#159b69" },
  { id: "trade", label: "Entry / SL / TP", color: "#159b69" },
];

const DEFAULT_LAYERS: Record<LayerId, boolean> = {
  structure: true,
  bos: true,
  choch: true,
  liquidity: true,
  sweeps: true,
  fvg: false,
  orderBlocks: true,
  supplyDemand: false,
  trade: true,
};

interface Box {
  key: string;
  x1: number;
  x2: number;
  y1: number;
  y2: number;
  color: string;
  label: string;
  faded: boolean;
}

interface Line {
  key: string;
  y: number;
  x1: number;
  x2: number;
  color: string;
  label: string;
  dashed: boolean;
}

interface Marker {
  key: string;
  x: number;
  y: number;
  color: string;
  label: string;
}

function secondsOf(ms: number): UTCTimestamp {
  return Math.floor(ms / 1000) as UTCTimestamp;
}

export function SmcChart({
  data,
  loading,
  timeframe,
  timeframes,
  onTimeframeChange,
}: {
  data: ChartPayload | null;
  loading: boolean;
  timeframe: string;
  timeframes: string[];
  onTimeframeChange: (tf: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const [layers, setLayers] = useState<Record<LayerId, boolean>>(DEFAULT_LAYERS);
  const [geometry, setGeometry] = useState<{ boxes: Box[]; lines: Line[]; markers: Marker[] }>({
    boxes: [], lines: [], markers: [],
  });
  const [size, setSize] = useState({ width: 0, height: 380 });

  // ---- chart lifecycle -------------------------------------------------
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const chart = createChart(container, {
      height: 380,
      layout: { background: { color: "transparent" }, textColor: "#778197", fontSize: 10 },
      grid: { vertLines: { color: "#eef0f6" }, horzLines: { color: "#eef0f6" } },
      rightPriceScale: { borderColor: "#e8ebf2" },
      timeScale: { borderColor: "#e8ebf2", timeVisible: true, secondsVisible: false },
      crosshair: { mode: 0 },
      handleScale: { axisPressedMouseMove: true },
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: "#159b69",
      downColor: "#db4e6d",
      borderUpColor: "#159b69",
      borderDownColor: "#db4e6d",
      wickUpColor: "#159b69",
      wickDownColor: "#db4e6d",
    });
    chartRef.current = chart;
    seriesRef.current = series;

    const resize = () => {
      const width = container.clientWidth;
      chart.applyOptions({ width });
      setSize({ width, height: 380 });
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    return () => {
      observer.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  // ---- candles ---------------------------------------------------------
  useEffect(() => {
    const series = seriesRef.current;
    if (!series || !data?.candles?.length) return;
    series.setData(
      data.candles.map((c) => ({
        time: secondsOf(c.timestamp),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      })),
    );
    chartRef.current?.timeScale().fitContent();
  }, [data]);

  // ---- overlay projection ---------------------------------------------
  const project = useCallback(() => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    if (!chart || !series || !data?.candles?.length) {
      setGeometry({ boxes: [], lines: [], markers: [] });
      return;
    }
    const timeScale = chart.timeScale();
    const width = size.width;
    const x = (ms: number) => timeScale.timeToCoordinate(secondsOf(ms));
    const y = (price: number) => series.priceToCoordinate(price);
    const firstMs = data.candles[0].timestamp;

    const boxes: Box[] = [];
    const lines: Line[] = [];
    const markers: Marker[] = [];

    const zoneLayer = (
      zones: ChartZone[] | undefined,
      layer: LayerId,
      color: string,
      label: string,
    ) => {
      if (!layers[layer] || !zones) return;
      for (const zone of zones) {
        const top = y(zone.top);
        const bottom = y(zone.bottom);
        const left = x(Math.max(zone.createdAt, firstMs));
        if (top === null || bottom === null || left === null) continue;
        boxes.push({
          key: `${layer}-${zone.id}`,
          x1: left,
          // Zones extend to the right edge: they stay live until mitigated.
          x2: width,
          y1: Math.min(top, bottom),
          y2: Math.max(top, bottom),
          color,
          label: `${label}${zone.status ? ` · ${zone.status}` : ""}`,
          faded: Boolean(zone.mitigated) || zone.status === "MITIGATED",
        });
      }
    };

    const levelLayer = (
      levels: ChartLevel[] | undefined,
      layer: LayerId,
      color: string,
      label: string,
      dashed: boolean,
    ) => {
      if (!layers[layer] || !levels) return;
      for (const level of levels) {
        const price = level.level ?? level.price;
        if (price === undefined) continue;
        const yy = y(price);
        if (yy === null) continue;
        const startMs = level.timestamp ?? firstMs;
        const left = x(Math.max(startMs, firstMs)) ?? 0;
        lines.push({
          key: `${layer}-${level.id ?? `${startMs}-${price}`}`,
          y: yy,
          x1: Math.max(0, left),
          x2: width,
          color,
          label: `${label}${level.type ? ` ${level.type}` : ""}${level.status === "SWEPT" ? " · swept" : ""}`,
          dashed,
        });
        if (layer === "sweeps" || layer === "choch" || layer === "bos") {
          const mx = x(startMs);
          if (mx !== null) {
            markers.push({ key: `m-${layer}-${startMs}-${price}`, x: mx, y: yy, color, label });
          }
        }
      }
    };

    zoneLayer(data.orderBlocks, "orderBlocks", "#685cf6", "Order block");
    zoneLayer(data.fvgs, "fvg", "#0da8c4", "FVG");
    zoneLayer(data.supplyDemand, "supplyDemand", "#159b69", "Supply/demand");
    levelLayer(data.liquidityZones, "liquidity", "#8e98ac", "Liquidity", true);
    levelLayer(data.sweeps, "sweeps", "#db4e6d", "Sweep", false);
    levelLayer(data.bos, "bos", "#0da8c4", "BOS", false);
    levelLayer(data.choch, "choch", "#c37a14", "CHoCH", false);

    // Structure swing points.
    if (layers.structure && data.structure?.swings) {
      for (const swing of data.structure.swings) {
        const sx = x(swing.timestamp);
        const sy = y(swing.price);
        if (sx === null || sy === null) continue;
        markers.push({ key: `sw-${swing.timestamp}-${swing.price}`, x: sx, y: sy, color: "#685cf6", label: swing.type });
      }
    }

    // Live trade levels for open positions on this market.
    if (layers.trade && data.positions?.length) {
      for (const position of data.positions) {
        const entryY = y(position.entry);
        const slY = y(position.stopLoss);
        if (entryY !== null) {
          lines.push({ key: `entry-${position.setupId}`, y: entryY, x1: 0, x2: width, color: "#182033", label: "Entry", dashed: false });
        }
        if (slY !== null) {
          lines.push({ key: `sl-${position.setupId}`, y: slY, x1: 0, x2: width, color: "#db4e6d", label: "Stop loss", dashed: true });
        }
        position.takeProfits?.forEach((tp, i) => {
          const tpY = y(tp);
          if (tpY !== null) {
            lines.push({ key: `tp-${position.setupId}-${i}`, y: tpY, x1: 0, x2: width, color: "#159b69", label: `TP${i + 1}`, dashed: true });
          }
        });
      }
    }

    setGeometry({ boxes, lines, markers });
  }, [data, layers, size.width]);

  useEffect(() => {
    project();
    const chart = chartRef.current;
    if (!chart) return;
    const timeScale = chart.timeScale();
    timeScale.subscribeVisibleLogicalRangeChange(project);
    return () => timeScale.unsubscribeVisibleLogicalRangeChange(project);
  }, [project]);

  const activeCount = useMemo(() => Object.values(layers).filter(Boolean).length, [layers]);

  return (
    <div className="smc-chart">
      <div className="chart-toolbar">
        <div className="tf-switch" role="group" aria-label="Chart timeframe">
          {timeframes.map((tf) => (
            <button
              key={tf}
              className={tf === timeframe ? "selected" : ""}
              onClick={() => onTimeframeChange(tf)}
            >
              {tf}
            </button>
          ))}
        </div>
        <span className="chart-meta">
          {data?.available === false
            ? data.reason
            : loading
              ? "Loading candles…"
              : `${data?.candles?.length ?? 0} candles · ${activeCount} layers`}
        </span>
      </div>

      <div className="chart-stage">
        <div ref={containerRef} className="chart-canvas" />
        <svg
          className="chart-overlay"
          width={size.width}
          height={size.height}
          aria-hidden="true"
        >
          {geometry.boxes.map((box) => (
            <g key={box.key} opacity={box.faded ? 0.28 : 0.75}>
              <rect
                x={box.x1}
                y={box.y1}
                width={Math.max(2, box.x2 - box.x1)}
                height={Math.max(1.5, box.y2 - box.y1)}
                fill={box.color}
                fillOpacity={0.12}
                stroke={box.color}
                strokeOpacity={0.5}
                strokeWidth={1}
              />
              <text x={box.x1 + 4} y={box.y1 + 11} fill={box.color} fontSize={9}>
                {box.label}
              </text>
            </g>
          ))}
          {geometry.lines.map((line) => (
            <g key={line.key}>
              <line
                x1={line.x1}
                x2={line.x2}
                y1={line.y}
                y2={line.y}
                stroke={line.color}
                strokeWidth={1}
                strokeDasharray={line.dashed ? "4 3" : undefined}
                opacity={0.85}
              />
              <text x={Math.max(4, line.x1 + 4)} y={line.y - 3} fill={line.color} fontSize={9}>
                {line.label}
              </text>
            </g>
          ))}
          {geometry.markers.map((marker) => (
            <circle
              key={marker.key}
              cx={marker.x}
              cy={marker.y}
              r={3}
              fill="#fff"
              stroke={marker.color}
              strokeWidth={1.5}
            />
          ))}
        </svg>
      </div>

      <div className="layer-toggles">
        {LAYERS.map((layer) => (
          <label key={layer.id} className={layers[layer.id] ? "on" : ""}>
            <input
              type="checkbox"
              checked={layers[layer.id]}
              onChange={(e) => setLayers({ ...layers, [layer.id]: e.target.checked })}
            />
            <i style={{ background: layer.color }} />
            {layer.label}
          </label>
        ))}
      </div>
    </div>
  );
}
