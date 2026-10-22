import React from 'react';
import type { EnergySeriesId } from './series-interaction';

export interface SeriesControlProps {
  id: EnergySeriesId; name: string; value?: string; colour: string;
  right: number; width: number; y: number; anchorY?: number; note?: string | null;
  hidden: boolean; active: boolean;
  onPoint: (id: EnergySeriesId | null) => void;
  onFocusSeries: (id: EnergySeriesId | null) => void;
  onToggle: (id: EnergySeriesId) => void;
}

/** Every panel uses the same compact, keyboard-operable key. */
export default function SeriesControl({ id, name, value, colour, right, width, y, anchorY, note,
  hidden, active, onPoint, onFocusSeries, onToggle }: SeriesControlProps) {
  return <g data-series-control={id} data-room-label={id.startsWith('room:') ? id.slice(5) : undefined}
    onPointerEnter={() => onPoint(id)} onPointerLeave={() => onPoint(null)}>
    <title>{[name, value, note].filter(Boolean).join(' · ')}</title>
    {anchorY !== undefined && !hidden && <>
      <polyline points={`${right},${anchorY} ${right + 5},${anchorY} ${right + 13},${y}`}
        fill="none" stroke={colour} strokeWidth={1} strokeOpacity={0.7} />
      <circle cx={right} cy={anchorY} r={2.5} fill={colour} />
    </>}
    <foreignObject x={right + 16} y={y - 9} width={width - right - 24} height={18}>
      <button type="button" aria-label={name} aria-pressed={!hidden}
        onFocus={() => onFocusSeries(id)} onBlur={() => onFocusSeries(null)}
        onClick={() => onToggle(id)}
        className={`flex h-[18px] w-full cursor-pointer items-center gap-1.5 rounded-sm text-left text-[12px] leading-[18px] text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring ${active ? 'font-semibold' : ''} ${hidden ? 'opacity-60' : ''}`}>
        <span aria-hidden="true" className="h-0.5 w-2 shrink-0" style={{ backgroundColor: colour }} />
        <span className={`min-w-0 flex-1 truncate ${hidden ? 'line-through' : ''}`}>{name}</span>
        {value && <span className="shrink-0 font-mono text-[10px] font-normal text-muted-foreground">{value}</span>}
      </button>
    </foreignObject>
  </g>;
}
