import { useState, useMemo, useRef, useCallback } from 'react';
import './PriceHistoryChart.css';

/**
 * catmullRomToBezier — converts an array of points into a smooth SVG cubic Bezier path.
 * Uses Catmull-Rom spline interpolation for natural, stock-chart-like curves.
 * @param {Array<{x: number, y: number}>} points
 * @param {number} tension — 0 = linear, 1 = very curved (default 0.3)
 * @returns {string} SVG path `d` attribute
 */
function catmullRomToBezier(points, tension = 0.3) {
  if (points.length < 2) return '';
  if (points.length === 2) {
    return `M${points[0].x},${points[0].y}L${points[1].x},${points[1].y}`;
  }

  let d = `M${points[0].x},${points[0].y}`;

  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(i - 1, 0)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(i + 2, points.length - 1)];

    const cp1x = p1.x + (p2.x - p0.x) * tension / 3;
    const cp1y = p1.y + (p2.y - p0.y) * tension / 3;
    const cp2x = p2.x - (p3.x - p1.x) * tension / 3;
    const cp2y = p2.y - (p3.y - p1.y) * tension / 3;

    d += `C${cp1x},${cp1y},${cp2x},${cp2y},${p2.x},${p2.y}`;
  }

  return d;
}

/**
 * formatDate — short date label for axis
 */
function formatDate(dateStr) {
  const d = new Date(dateStr);
  const month = d.toLocaleString('default', { month: 'short' });
  const day = d.getDate();
  return `${month} ${day}`;
}

function formatFullDate(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleDateString('default', { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * PriceHistoryChart — Inline SVG area chart with smooth curves, hover tooltips,
 * and a stock-tracker aesthetic.
 *
 * Props:
 *   dataPoints — array of { snapshotId, price, budgetPrice, date, nickname }
 *   height — optional chart height (default 280)
 */
export default function PriceHistoryChart({ dataPoints, height = 280 }) {
  const [hoveredIdx, setHoveredIdx] = useState(null);
  const svgRef = useRef(null);
  const tooltipRef = useRef(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });

  const width = 600;
  const padding = { top: 24, right: 16, bottom: 36, left: 56 };
  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;

  // Compute chart data
  const chartData = useMemo(() => {
    if (!dataPoints || dataPoints.length === 0) return null;

    const prices = dataPoints.map(d => d.price);
    const rawMin = Math.min(...prices);
    const rawMax = Math.max(...prices);

    // Add 10% padding to Y range for breathing room
    const range = rawMax - rawMin || rawMax * 0.1 || 10;
    const yMin = Math.max(0, rawMin - range * 0.1);
    const yMax = rawMax + range * 0.1;

    // Map data to SVG coordinates
    const points = dataPoints.map((d, i) => ({
      x: padding.left + (dataPoints.length === 1 ? chartW / 2 : (i / (dataPoints.length - 1)) * chartW),
      y: padding.top + chartH - ((d.price - yMin) / (yMax - yMin)) * chartH,
      data: d,
      index: i,
    }));

    // Y-axis grid: 4 nice labels
    const yStep = (yMax - yMin) / 4;
    const yLabels = [];
    for (let i = 0; i <= 4; i++) {
      const val = yMin + yStep * i;
      const y = padding.top + chartH - ((val - yMin) / (yMax - yMin)) * chartH;
      yLabels.push({ val, y });
    }

    // X-axis labels: up to 5, evenly distributed
    const xLabels = [];
    if (dataPoints.length === 1) {
      xLabels.push({ label: formatDate(dataPoints[0].date), x: points[0].x });
    } else {
      const count = Math.min(5, dataPoints.length);
      for (let i = 0; i < count; i++) {
        const idx = count === 1 ? 0 : Math.round(i * (dataPoints.length - 1) / (count - 1));
        xLabels.push({ label: formatDate(dataPoints[idx].date), x: points[idx].x });
      }
    }

    // Min/Max markers
    let minIdx = 0, maxIdx = 0;
    for (let i = 1; i < prices.length; i++) {
      if (prices[i] < prices[minIdx]) minIdx = i;
      if (prices[i] > prices[maxIdx]) maxIdx = i;
    }

    // Trend: compare first vs last
    const firstPrice = prices[0];
    const lastPrice = prices[prices.length - 1];
    const trend = lastPrice > firstPrice ? 'up' : lastPrice < firstPrice ? 'down' : 'neutral';

    // Line path (smooth Catmull-Rom spline)
    const linePath = catmullRomToBezier(points);

    // Area path (fill under the curve)
    const areaPath = dataPoints.length === 1
      ? '' // No area for single point
      : `${linePath}L${points[points.length - 1].x},${padding.top + chartH}L${points[0].x},${padding.top + chartH}Z`;

    return { points, yLabels, xLabels, linePath, areaPath, minIdx, maxIdx, trend, yMin, yMax };
  }, [dataPoints, chartW, chartH, padding.left, padding.top]);

  const handleMouseMove = useCallback((e, idx) => {
    if (!svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    setTooltipPos({ x, y });
    setHoveredIdx(idx);
  }, []);

  const handleMouseLeave = useCallback(() => {
    setHoveredIdx(null);
  }, []);

  if (!dataPoints || dataPoints.length === 0) {
    return (
      <div className="price-chart-empty">
        <div className="price-chart-empty-icon">📊</div>
        <div className="price-chart-empty-text">No price data yet</div>
        <div className="price-chart-empty-hint">Click &ldquo;Check Prices&rdquo; on a deck to start tracking price history</div>
      </div>
    );
  }

  if (dataPoints.length === 1) {
    const pt = dataPoints[0];
    return (
      <div className="price-chart-single">
        <div className="price-chart-single-value">${pt.price.toFixed(2)}</div>
        <div className="price-chart-single-date">{formatFullDate(pt.date)}</div>
        {pt.nickname && <div className="price-chart-single-nick">{pt.nickname}</div>}
        <div className="price-chart-empty-hint">More data points will build a price trend chart</div>
      </div>
    );
  }

  const { points, yLabels, xLabels, linePath, areaPath, minIdx, maxIdx, trend } = chartData;
  const trendClass = `price-chart--${trend}`;

  // Calculate stroke dasharray for animation
  const pathLength = 2000; // approximate, will be overridden by CSS

  return (
    <div className={`price-chart ${trendClass}`}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${width} ${height}`}
        className="price-chart-svg"
        onMouseLeave={handleMouseLeave}
      >
        <defs>
          <linearGradient id="priceAreaGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" className="price-chart-gradient-start" />
            <stop offset="100%" className="price-chart-gradient-end" />
          </linearGradient>
          <linearGradient id="priceLineGradient" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" className="price-chart-line-start" />
            <stop offset="100%" className="price-chart-line-end" />
          </linearGradient>
        </defs>

        {/* Grid lines */}
        {yLabels.map((label, i) => (
          <g key={i}>
            <line
              x1={padding.left}
              y1={label.y}
              x2={padding.left + chartW}
              y2={label.y}
              className="price-chart-grid"
            />
            <text
              x={padding.left - 8}
              y={label.y + 4}
              className="price-chart-y-label"
            >
              ${label.val.toFixed(0)}
            </text>
          </g>
        ))}

        {/* X-axis labels */}
        {xLabels.map((label, i) => (
          <text
            key={i}
            x={label.x}
            y={height - 8}
            className="price-chart-x-label"
          >
            {label.label}
          </text>
        ))}

        {/* Area fill */}
        <path d={areaPath} className="price-chart-area" />

        {/* Line */}
        <path
          d={linePath}
          className="price-chart-line"
          strokeDasharray={pathLength}
          strokeDashoffset={pathLength}
          style={{ '--path-length': pathLength }}
        />

        {/* Data point dots */}
        {points.map((pt, i) => (
          <g key={i}>
            {/* Invisible hit area for hover */}
            <circle
              cx={pt.x}
              cy={pt.y}
              r={14}
              fill="transparent"
              style={{ cursor: 'pointer' }}
              onMouseMove={(e) => handleMouseMove(e, i)}
              onMouseEnter={(e) => handleMouseMove(e, i)}
            />
            {/* Visible dot */}
            <circle
              cx={pt.x}
              cy={pt.y}
              r={hoveredIdx === i ? 5 : (i === minIdx || i === maxIdx ? 4 : 3)}
              className={`price-chart-dot${hoveredIdx === i ? ' price-chart-dot--active' : ''}${i === minIdx ? ' price-chart-dot--min' : ''}${i === maxIdx ? ' price-chart-dot--max' : ''}`}
              style={{ pointerEvents: 'none' }}
            />
          </g>
        ))}

        {/* Min/Max labels */}
        {minIdx !== maxIdx && (
          <>
            <text
              x={points[minIdx].x}
              y={points[minIdx].y + 16}
              className="price-chart-extrema-label price-chart-extrema--min"
            >
              ${dataPoints[minIdx].price.toFixed(0)}
            </text>
            <text
              x={points[maxIdx].x}
              y={points[maxIdx].y - 10}
              className="price-chart-extrema-label price-chart-extrema--max"
            >
              ${dataPoints[maxIdx].price.toFixed(0)}
            </text>
          </>
        )}

        {/* Hover crosshair */}
        {hoveredIdx !== null && (
          <line
            x1={points[hoveredIdx].x}
            y1={padding.top}
            x2={points[hoveredIdx].x}
            y2={padding.top + chartH}
            className="price-chart-crosshair"
          />
        )}
      </svg>

      {/* Tooltip */}
      {hoveredIdx !== null && (
        <div
          ref={tooltipRef}
          className="price-chart-tooltip"
          style={{
            left: tooltipPos.x,
            top: tooltipPos.y,
            transform: `translate(${tooltipPos.x > width * 0.65 ? '-110%' : '10%'}, -120%)`,
          }}
        >
          <div className="price-chart-tooltip-price">${dataPoints[hoveredIdx].price.toFixed(2)}</div>
          {dataPoints[hoveredIdx].budgetPrice != null && Math.abs(dataPoints[hoveredIdx].budgetPrice - dataPoints[hoveredIdx].price) >= 0.01 && (
            <div className="price-chart-tooltip-budget">Budget: ${dataPoints[hoveredIdx].budgetPrice.toFixed(2)}</div>
          )}
          <div className="price-chart-tooltip-date">{formatFullDate(dataPoints[hoveredIdx].date)}</div>
          {dataPoints[hoveredIdx].nickname && (
            <div className="price-chart-tooltip-nick">{dataPoints[hoveredIdx].nickname}</div>
          )}
          {hoveredIdx > 0 && (
            <div className={`price-chart-tooltip-delta${dataPoints[hoveredIdx].price >= dataPoints[hoveredIdx - 1].price ? ' price-chart-tooltip-delta--up' : ' price-chart-tooltip-delta--down'}`}>
              {dataPoints[hoveredIdx].price >= dataPoints[hoveredIdx - 1].price ? '+' : ''}
              ${(dataPoints[hoveredIdx].price - dataPoints[hoveredIdx - 1].price).toFixed(2)} from prev
            </div>
          )}
        </div>
      )}
    </div>
  );
}
