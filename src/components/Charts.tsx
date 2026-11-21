import React, { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, CheckCircle2, Clock, AlertTriangle } from 'lucide-react';
import { formatNumericValue } from '../lib/export';

const CHART_COLORS = [
  '#1D4ED8', // Cobalt blue
  '#0284C7', // Sky blue
  '#0F766E', // Deep teal
  '#4F46E5', // Indigo
  '#D97706', // Amber
  '#059669', // Emerald
  '#475569', // Slate
  '#7C3AED', // Violet
];

interface ChartRow {
  label?: string | number | null;
  value?: string | number | null;
  [key: string]: string | number | null | undefined;
}

interface CommonChartProps {
  rows: ChartRow[];
  prefix?: string;
  suffix?: string;
  activeLabel?: string;
  onSelectLabel?: (label: string) => void;
}

function formatCompactAxis(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(Math.round(n));
}

export const BarChartVisual: React.FC<CommonChartProps> = ({
  rows,
  prefix = '',
  suffix = '',
  activeLabel,
  onSelectLabel,
}) => {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  const items = useMemo(
    () =>
      rows.map((r) => ({
        label: String(r.label ?? 'N/D'),
        value: Number(r.value ?? 0),
      })),
    [rows]
  );

  const maxVal = useMemo(() => Math.max(1, ...items.map((i) => i.value)), [items]);

  if (items.length === 0) {
    return (
      <div className="h-56 flex items-center justify-center text-xs text-slate-500 dark:text-slate-400">
        Aucune donnée correspondante pour les filtres sélectionnés.
      </div>
    );
  }

  return (
    <div className="space-y-2.5">
      {items.map((item, idx) => {
        const pct = Math.max(2, (item.value / maxVal) * 100);
        const isActive = activeLabel === item.label;
        const isDimmed = Boolean(activeLabel && !isActive);
        const isHovered = hoveredIdx === idx;

        return (
          <button
            key={`${item.label}-${idx}`}
            type="button"
            onClick={() => onSelectLabel?.(item.label)}
            onMouseEnter={() => setHoveredIdx(idx)}
            onMouseLeave={() => setHoveredIdx(null)}
            className={`w-full text-left group transition-opacity duration-150 ${
              onSelectLabel ? 'cursor-pointer' : 'cursor-default'
            } ${isDimmed ? 'opacity-45 hover:opacity-80' : 'opacity-100'}`}
          >
            <div className="flex items-center justify-between text-xs mb-1 gap-3">
              <span
                className={`truncate font-medium ${
                  isActive
                    ? 'text-blue-700 dark:text-blue-400'
                    : 'text-slate-700 dark:text-slate-200'
                }`}
                title={item.label}
              >
                {item.label}
              </span>
              <span className="font-mono tabular-nums text-slate-900 dark:text-slate-100 shrink-0 font-medium">
                {formatNumericValue(item.value, prefix, suffix)}
              </span>
            </div>
            <div className="h-2.5 w-full bg-slate-100 dark:bg-slate-800 rounded-sm overflow-hidden">
              <div
                className="h-full rounded-sm transition-all duration-200"
                style={{
                  width: `${pct}%`,
                  backgroundColor: isActive
                    ? '#1D4ED8'
                    : isHovered
                    ? '#0284C7'
                    : CHART_COLORS[idx % CHART_COLORS.length],
                }}
              />
            </div>
          </button>
        );
      })}
    </div>
  );
};

export const LineAreaChartVisual: React.FC<CommonChartProps> = ({
  rows,
  prefix = '',
  suffix = '',
}) => {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const items = useMemo(
    () =>
      rows.map((r) => ({
        label: String(r.label ?? ''),
        value: Number(r.value ?? 0),
      })),
    [rows]
  );

  if (items.length === 0) {
    return (
      <div className="h-56 flex items-center justify-center text-xs text-slate-500 dark:text-slate-400">
        Aucune série temporelle disponible pour cette sélection.
      </div>
    );
  }

  const width = 640;
  const height = 220;
  const padLeft = 48;
  const padRight = 18;
  const padTop = 18;
  const padBottom = 34;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;

  const maxVal = Math.max(1, ...items.map((d) => d.value)) * 1.08;
  const minVal = 0;

  const coords = items.map((d, i) => {
    const x = items.length === 1 ? padLeft + plotW / 2 : padLeft + (i / (items.length - 1)) * plotW;
    const y = padTop + plotH - ((d.value - minVal) / (maxVal - minVal || 1)) * plotH;
    return { x, y, ...d };
  });

  const linePath = coords.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
  const areaPath = `${linePath} L ${coords[coords.length - 1].x.toFixed(1)} ${(padTop + plotH).toFixed(1)} L ${coords[0].x.toFixed(1)} ${(padTop + plotH).toFixed(1)} Z`;

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((t) => ({
    val: minVal + t * (maxVal - minVal),
    y: padTop + plotH - t * plotH,
  }));

  const hovered = hoverIdx !== null ? coords[hoverIdx] : null;

  return (
    <div className="relative w-full">
      {hovered && (
        <div className="absolute right-2 top-0 z-10 bg-slate-900 text-white text-xs px-2.5 py-1.5 rounded-md pointer-events-none flex items-center gap-2 font-mono tabular-nums">
          <span className="text-slate-300">{hovered.label}</span>
          <span>·</span>
          <span className="font-semibold">{formatNumericValue(hovered.value, prefix, suffix)}</span>
        </div>
      )}
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-56 overflow-visible">
        <defs>
          <linearGradient id="biAreaGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#1D4ED8" stopOpacity="0.22" />
            <stop offset="100%" stopColor="#1D4ED8" stopOpacity="0.01" />
          </linearGradient>
        </defs>

        {yTicks.map((t, i) => (
          <g key={i}>
            <line
              x1={padLeft}
              y1={t.y}
              x2={width - padRight}
              y2={t.y}
              className="stroke-slate-200 dark:stroke-slate-800"
              strokeWidth="1"
            />
            <text
              x={padLeft - 8}
              y={t.y + 3}
              textAnchor="end"
              className="fill-slate-400 dark:fill-slate-500 text-[10px] font-mono tabular-nums"
            >
              {formatCompactAxis(t.val)}
            </text>
          </g>
        ))}

        <path d={areaPath} fill="url(#biAreaGrad)" />
        <path d={linePath} fill="none" stroke="#1D4ED8" strokeWidth="2.2" strokeLinejoin="round" />

        {coords.map((p, i) => {
          const showLabel = items.length <= 8 || i % Math.ceil(items.length / 6) === 0 || i === items.length - 1;
          return (
            <g key={p.label + i}>
              {showLabel && (
                <text
                  x={p.x}
                  y={height - 10}
                  textAnchor="middle"
                  className="fill-slate-500 dark:fill-slate-400 text-[10px] font-mono"
                >
                  {p.label.slice(0, 10)}
                </text>
              )}
              <circle
                cx={p.x}
                cy={p.y}
                r={hoverIdx === i ? 5 : 3}
                fill={hoverIdx === i ? '#0284C7' : '#1D4ED8'}
                className="stroke-white dark:stroke-slate-900"
                strokeWidth="1.5"
              />
              <rect
                x={p.x - plotW / Math.max(items.length * 2, 4)}
                y={padTop}
                width={plotW / Math.max(items.length, 2)}
                height={plotH}
                fill="transparent"
                onMouseEnter={() => setHoverIdx(i)}
                onMouseLeave={() => setHoverIdx(null)}
              />
            </g>
          );
        })}
      </svg>
    </div>
  );
};

export const DonutChartVisual: React.FC<CommonChartProps> = ({
  rows,
  prefix = '',
  suffix = '',
  activeLabel,
  onSelectLabel,
}) => {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  const items = useMemo(
    () =>
      rows.map((r, i) => ({
        label: String(r.label ?? 'Autre'),
        value: Math.max(0, Number(r.value ?? 0)),
        color: CHART_COLORS[i % CHART_COLORS.length],
      })),
    [rows]
  );

  const total = useMemo(() => items.reduce((s, i) => s + i.value, 0), [items]);

  if (items.length === 0 || total === 0) {
    return (
      <div className="h-56 flex items-center justify-center text-xs text-slate-500 dark:text-slate-400">
        Aucune répartition disponible.
      </div>
    );
  }

  const radius = 58;
  const strokeWidth = 22;
  const circumference = 2 * Math.PI * radius;
  let cumulative = 0;

  const focusedItem = hoveredIdx !== null ? items[hoveredIdx] : null;

  return (
    <div className="flex flex-col sm:flex-row items-center gap-5">
      <div className="relative w-40 h-40 shrink-0 flex items-center justify-center">
        <svg viewBox="0 0 160 160" className="w-40 h-40 -rotate-90">
          {items.map((item, idx) => {
            const fraction = item.value / total;
            const dashLength = fraction * circumference;
            const dashOffset = -cumulative * circumference;
            cumulative += fraction;
            const isActive = activeLabel === item.label;
            const isDimmed = Boolean(activeLabel && !isActive);

            return (
              <circle
                key={`${item.label}-${idx}`}
                cx="80"
                cy="80"
                r={radius}
                fill="none"
                stroke={item.color}
                strokeWidth={hoveredIdx === idx || isActive ? strokeWidth + 4 : strokeWidth}
                strokeDasharray={`${dashLength} ${circumference}`}
                strokeDashoffset={dashOffset}
                className={`transition-all duration-150 ${onSelectLabel ? 'cursor-pointer' : ''} ${
                  isDimmed ? 'opacity-35' : 'opacity-100'
                }`}
                onMouseEnter={() => setHoveredIdx(idx)}
                onMouseLeave={() => setHoveredIdx(null)}
                onClick={() => onSelectLabel?.(item.label)}
              />
            );
          })}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center text-center px-3 pointer-events-none">
          <span className="text-[11px] text-slate-500 dark:text-slate-400 truncate max-w-[96px]">
            {focusedItem ? focusedItem.label : 'Total'}
          </span>
          <span className="font-mono tabular-nums text-xs font-semibold text-slate-900 dark:text-white mt-0.5">
            {formatNumericValue(focusedItem ? focusedItem.value : total, prefix, suffix)}
          </span>
        </div>
      </div>

      <div className="flex-1 w-full space-y-1.5 max-h-48 overflow-y-auto pr-1">
        {items.map((item, idx) => {
          const pct = ((item.value / total) * 100).toFixed(1);
          const isActive = activeLabel === item.label;
          return (
            <button
              key={`${item.label}-leg-${idx}`}
              type="button"
              onClick={() => onSelectLabel?.(item.label)}
              onMouseEnter={() => setHoveredIdx(idx)}
              onMouseLeave={() => setHoveredIdx(null)}
              className={`w-full flex items-center justify-between text-xs py-1 px-2 rounded-md transition-colors ${
                onSelectLabel ? 'cursor-pointer hover:bg-slate-100 dark:hover:bg-slate-800' : ''
              } ${isActive ? 'bg-blue-50 dark:bg-blue-950/40' : ''}`}
            >
              <span className="flex items-center gap-2 min-w-0">
                <span className="w-2.5 h-2.5 rounded-xs shrink-0" style={{ backgroundColor: item.color }} />
                <span className="truncate text-slate-700 dark:text-slate-200">{item.label}</span>
              </span>
              <span className="font-mono tabular-nums text-slate-600 dark:text-slate-300 shrink-0 ml-2">
                {pct}%
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
};

interface DataTableVisualProps {
  rows: Record<string, string | number | null>[];
}

function renderStatusText(val: string) {
  const lower = val.toLowerCase();
  if (lower === 'payée' || lower === 'active' || lower === 'success') {
    return (
      <span className="inline-flex items-center gap-1.5 text-emerald-700 dark:text-emerald-400 font-medium">
        <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
        <span>{val}</span>
      </span>
    );
  }
  if (lower === 'en attente' || lower === 'warning') {
    return (
      <span className="inline-flex items-center gap-1.5 text-amber-700 dark:text-amber-400 font-medium">
        <Clock className="w-3.5 h-3.5 shrink-0" />
        <span>{val}</span>
      </span>
    );
  }
  if (lower === 'échue' || lower === 'error' || lower === 'blocked') {
    return (
      <span className="inline-flex items-center gap-1.5 text-red-700 dark:text-red-400 font-medium">
        <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
        <span>{val}</span>
      </span>
    );
  }
  return <span>{val}</span>;
}

export const DataTableVisual: React.FC<DataTableVisualProps> = ({ rows }) => {
  const [sortCol, setSortCol] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  const columns = useMemo(() => (rows.length > 0 ? Object.keys(rows[0]) : []), [rows]);

  const sortedRows = useMemo(() => {
    if (!sortCol) return rows;
    return [...rows].sort((a, b) => {
      const av = a[sortCol];
      const bv = b[sortCol];
      if (typeof av === 'number' && typeof bv === 'number') {
        return sortDir === 'asc' ? av - bv : bv - av;
      }
      return sortDir === 'asc'
        ? String(av ?? '').localeCompare(String(bv ?? ''), 'fr')
        : String(bv ?? '').localeCompare(String(av ?? ''), 'fr');
    });
  }, [rows, sortCol, sortDir]);

  if (rows.length === 0) {
    return (
      <div className="py-12 text-center text-xs text-slate-500 dark:text-slate-400">
        Aucune ligne retournée pour les critères de filtrage actifs.
      </div>
    );
  }

  const toggleSort = (col: string) => {
    if (sortCol === col) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortCol(col);
      setSortDir('desc');
    }
  };

  return (
    <div className="overflow-x-auto border-t border-slate-200 dark:border-slate-800">
      <table className="w-full text-left border-collapse text-xs">
        <thead>
          <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-800/40">
            {columns.map((col) => {
              const sampleVal = rows[0][col];
              const isNum = typeof sampleVal === 'number';
              return (
                <th
                  key={col}
                  className={`py-2.5 px-3 font-semibold text-slate-600 dark:text-slate-300 whitespace-nowrap ${
                    isNum ? 'text-right' : 'text-left'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => toggleSort(col)}
                    className="inline-flex items-center gap-1 hover:text-slate-900 dark:hover:text-white cursor-pointer"
                  >
                    <span>{col}</span>
                    {sortCol === col &&
                      (sortDir === 'asc' ? (
                        <ArrowUp className="w-3 h-3 text-blue-600" />
                      ) : (
                        <ArrowDown className="w-3 h-3 text-blue-600" />
                      ))}
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 dark:divide-slate-800/80">
          {sortedRows.map((row, rIdx) => (
            <tr
              key={rIdx}
              className="h-9 hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors"
            >
              {columns.map((col) => {
                const val = row[col];
                const isNum = typeof val === 'number';
                const isStatusCol = col.toUpperCase().includes('STATUT');
                return (
                  <td
                    key={col}
                    className={`py-2 px-3 whitespace-nowrap ${
                      isNum
                        ? 'text-right font-mono tabular-nums text-slate-900 dark:text-slate-100'
                        : 'text-slate-700 dark:text-slate-300'
                    }`}
                  >
                    {isNum
                      ? new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 }).format(val)
                      : isStatusCol
                      ? renderStatusText(String(val ?? ''))
                      : String(val ?? '—')}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};
