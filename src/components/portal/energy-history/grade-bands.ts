import type { IndicativeEnergyGrade } from '@/lib/indicative-energy-performance';

export const GRADE_BANDS: Array<{
  grade: IndicativeEnergyGrade;
  label: string;
  className: string;
}> = [
  { grade: 'A', label: '≤50%', className: 'bg-emerald-600' },
  { grade: 'B', label: '50–75%', className: 'bg-green-500' },
  { grade: 'C', label: '75–100%', className: 'bg-lime-500' },
  { grade: 'D', label: '100–135%', className: 'bg-yellow-500' },
  { grade: 'E', label: '135–180%', className: 'bg-orange-500' },
  { grade: 'F', label: '180–235%', className: 'bg-orange-700' },
  { grade: 'G', label: '>235%', className: 'bg-red-700' },
];
