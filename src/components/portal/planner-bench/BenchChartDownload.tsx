// The bench's counterpart of the live plan's replay download: the data behind
// the chart as it is shown, for the period shown, as one file
// (src/lib/planner-bench/chart-export.ts). It sits where the replay button
// does, at the end of the chart's score section.

import React from 'react';
import { FileJson } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useLanguage } from '@/contexts/LanguageContext';
import { downloadJson } from '@/lib/download-json';
import { benchChartExport, benchChartFilename, type BenchChartExportInput } from '@/lib/planner-bench/chart-export';

const BenchChartDownload: React.FC<{ input: BenchChartExportInput }> = ({ input }) => {
  const { t } = useLanguage();
  const shown = input.plans[input.shown];
  return (
    <Button
      id="bench-chart-download" type="button" variant="outline" size="sm" disabled={!shown}
      title={t(`Det diagrammet visar för ${input.period.label}: varje kvart för båda planerarna, med poäng och regler.`,
        `What the chart shows for ${input.period.label}: every quarter of both planners, with points and rules.`)}
      onClick={() => shown && downloadJson(benchChartFilename(input.scenario.name, shown.name, input.period.label), benchChartExport(input))}
    >
      <FileJson className="mr-1.5 h-4 w-4" />
      {t('Ladda ned diagramdata (JSON)', 'Download chart data (JSON)')}
    </Button>
  );
};

export default BenchChartDownload;
