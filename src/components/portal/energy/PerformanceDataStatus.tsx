import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { Edit } from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useLanguage } from '@/contexts/LanguageContext';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { type ProfileKind, resolveProfile, type ProfileResolution } from '@/lib/performance-data';
import PerformanceCurveChart from './PerformanceCurveChart';
import PerformanceDataEditor from './PerformanceDataEditor';

interface DeviceProfile {
  id: string;
  device_id: string;
  profile_kind: string;
  mode: string;
  data: { points: any[] };
  source: string | null;
  notes: string | null;
  updated_at: string;
}

interface Props {
  deviceId: string;
  devices: Array<{ id: string; name: string; device_type_id: string }>;
  currentDeviceTypeId: string;
  performanceDataDeviceId: string | null;
  onPerformanceDeviceChange: (id: string | null) => void;
}

interface ProfileStatus {
  kind: ProfileKind;
  label: string;
  resolution: ProfileResolution | null;
  loading: boolean;
}

const PROFILE_KINDS: { kind: ProfileKind; labelSv: string; labelEn: string }[] = [
  { kind: 'cop_capacity_curve', labelSv: 'COP + Kapacitetskurva', labelEn: 'COP + Capacity Curve' },
  { kind: 'heating_performance_surface', labelSv: 'Värmeprestanda (yta)', labelEn: 'Heating Performance Surface' },
];

const PerformanceDataStatus: React.FC<Props> = ({
  deviceId, devices, currentDeviceTypeId, performanceDataDeviceId, onPerformanceDeviceChange,
}) => {
  const { t } = useLanguage();
  const { isStaff } = useAuth();
  const { toast } = useToast();
  const [statuses, setStatuses] = useState<ProfileStatus[]>([]);
  const [editingKind, setEditingKind] = useState<ProfileKind | null>(null);
  const [useBorrowed, setUseBorrowed] = useState(!!performanceDataDeviceId);

  const loadStatuses = useCallback(async () => {
    const results: ProfileStatus[] = [];
    for (const pk of PROFILE_KINDS) {
      const resolution = await resolveProfile(deviceId, 'heating', pk.kind);
      results.push({
        kind: pk.kind,
        label: t(pk.labelSv, pk.labelEn),
        resolution,
        loading: false,
      });
    }
    setStatuses(results);
  }, [deviceId, t]);

  useEffect(() => {
    if (deviceId) loadStatuses();
  }, [deviceId, loadStatuses]);

  useEffect(() => {
    setUseBorrowed(!!performanceDataDeviceId);
  }, [performanceDataDeviceId]);

  const handleBorrowToggle = (checked: boolean) => {
    setUseBorrowed(checked);
    if (!checked) onPerformanceDeviceChange(null);
  };

  const eligibleDevices = devices.filter(d => d.id !== deviceId && d.device_type_id === currentDeviceTypeId);

  const editingStatus = editingKind ? statuses.find(s => s.kind === editingKind) : null;
  const editingProfile = editingStatus?.resolution?.resolvedSource === 'own' ? editingStatus.resolution.profile : null;

  // Build chart data for curve preview
  const curveStatus = statuses.find(s => s.kind === 'cop_capacity_curve');
  const curveProfile = curveStatus?.resolution?.profile;
  const curveChartData = curveProfile?.data?.points
    ?.filter((p: any) => typeof p.temp_c === 'number')
    .map((p: any) => ({ temp_c: p.temp_c, cop: p.cop, capacity_kw: (p.capacity_w || 0) / 1000 }));

  // Build surface chart data – one series per indoor_temp_c
  const surfaceStatus = statuses.find(s => s.kind === 'heating_performance_surface');
  const surfaceProfile = surfaceStatus?.resolution?.profile;

  const SURFACE_COLORS = [
    'hsl(var(--primary))',
    'hsl(var(--destructive))',
    'hsl(var(--chart-3))',
    'hsl(var(--chart-4))',
    'hsl(var(--chart-5))',
    '#8884d8',
    '#82ca9d',
  ];

  const surfaceChartInfo = useMemo(() => {
    if (!surfaceProfile?.data?.points?.length) return null;
    const points = surfaceProfile.data.points as any[];
    const indoorTemps = [...new Set(points.map((p: any) => p.indoor_temp_c as number))]
      .filter(v => typeof v === 'number')
      .sort((a, b) => a - b);

    // Build merged data: each outdoor temp gets a row, each indoor temp becomes a series
    const outdoorTemps = [...new Set(points.map((p: any) => p.temp_c as number))]
      .filter(v => typeof v === 'number')
      .sort((a, b) => a - b);

    const capacityData = outdoorTemps.map(ot => {
      const row: any = { temp_c: ot };
      for (const it of indoorTemps) {
        const pt = points.find((p: any) => p.indoor_temp_c === it && p.temp_c === ot);
        row[`cap_${it}`] = pt ? (pt.capacity_w || 0) / 1000 : null;
      }
      return row;
    });

    const inputPowerData = outdoorTemps.map(ot => {
      const row: any = { temp_c: ot };
      for (const it of indoorTemps) {
        const pt = points.find((p: any) => p.indoor_temp_c === it && p.temp_c === ot);
        row[`pw_${it}`] = pt ? (pt.input_power_w || 0) / 1000 : null;
      }
      return row;
    });

    const copData = outdoorTemps.map(ot => {
      const row: any = { temp_c: ot };
      for (const it of indoorTemps) {
        const pt = points.find((p: any) => p.indoor_temp_c === it && p.temp_c === ot);
        row[`cop_${it}`] = pt && pt.input_power_w > 0 ? parseFloat((pt.capacity_w / pt.input_power_w).toFixed(2)) : null;
      }
      return row;
    });

    return { indoorTemps, capacityData, inputPowerData, copData };
  }, [surfaceProfile]);

  const handleDeleteProfile = async (profileId: string) => {
    const { error } = await supabase.from('device_profiles').delete().eq('id', profileId);
    if (error) {
      toast({ title: t('Fel', 'Error'), description: error.message, variant: 'destructive' });
    } else {
      toast({ title: t('Borttagen', 'Deleted') });
      loadStatuses();
    }
  };

  const renderSurfaceChart = (data: any[], keyPrefix: string, yLabel: string, indoorTemps: number[]) => (
    <ResponsiveContainer width="100%" height={160}>
      <LineChart data={data}>
        <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
        <XAxis dataKey="temp_c" type="number" label={{ value: '°C', position: 'insideBottom', offset: -5 }} className="text-xs" />
        <YAxis label={{ value: yLabel, angle: -90, position: 'insideLeft' }} className="text-xs" />
        <Tooltip />
        <Legend />
        {indoorTemps.map((it, i) => (
          <Line
            key={it}
            type="monotone"
            dataKey={`${keyPrefix}_${it}`}
            name={`${it}°C`}
            stroke={SURFACE_COLORS[i % SURFACE_COLORS.length]}
            strokeWidth={2}
            dot={{ r: 2 }}
            connectNulls
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );

  return (
    <>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">{t('Prestandadata', 'Performance Data')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Profile status chips */}
          <div className="space-y-2">
            {statuses.map(s => (
              <div key={s.kind} className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-xs truncate">{s.label}</span>
                  {s.resolution?.profile ? (
                    <Badge variant="outline" className="text-xs shrink-0">
                      {s.resolution.resolvedSource === 'borrowed'
                        ? `${t('Lånad', 'Borrowed')}: ${s.resolution.borrowedFromName}`
                        : s.resolution.profile.source || 'unknown'}
                    </Badge>
                  ) : (
                    <Badge variant="secondary" className="text-xs shrink-0">{t('Saknas', 'Missing')}</Badge>
                  )}
                </div>
                {isStaff && (
                  <div className="flex gap-1 shrink-0">
                    <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setEditingKind(s.kind)}>
                      <Edit className="w-3 h-3 mr-1" />{s.resolution?.profile ? t('Redigera', 'Edit') : t('Lägg till', 'Add')}
                    </Button>
                    {s.resolution?.resolvedSource === 'own' && s.resolution.profile && (
                      <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-destructive" onClick={() => handleDeleteProfile(s.resolution!.profile!.id)}>
                        ×
                      </Button>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Curve preview */}
          {curveChartData && curveChartData.length > 0 && (
            <div className="space-y-2">
              <PerformanceCurveChart
                title="COP"
                data={curveChartData.map((p: any) => ({ x: p.temp_c, y: p.cop }))}
                xLabel="°C"
                yLabel="COP"
                height={150}
                hideCard
              />
              <PerformanceCurveChart
                title={t('Kapacitet', 'Capacity')}
                data={curveChartData.map((p: any) => ({ x: p.temp_c, y: p.capacity_kw }))}
                xLabel="°C"
                yLabel="kW"
                color="hsl(var(--destructive))"
                height={150}
                hideCard
              />
              {curveProfile && (
                <div className="flex gap-4 text-xs text-muted-foreground">
                  {curveProfile.source && <span>{t('Källa', 'Source')}: {curveProfile.source}</span>}
                  <span>{t('Uppdaterad', 'Updated')}: {new Date(curveProfile.updated_at).toLocaleDateString()}</span>
                </div>
              )}
            </div>
          )}

          {/* Surface preview – separate charts with series per indoor temp */}
          {surfaceChartInfo && (
            <div className="space-y-2 border-t pt-3">
              <p className="text-xs font-medium">{t('Värmeprestanda (yta)', 'Heating Performance Surface')}</p>
              <div className="space-y-3">
                <div>
                  <p className="text-xs text-muted-foreground mb-1">{t('Kapacitet', 'Capacity')} (kW)</p>
                  {renderSurfaceChart(surfaceChartInfo.capacityData, 'cap', 'kW', surfaceChartInfo.indoorTemps)}
                </div>
                <div>
                  <p className="text-xs text-muted-foreground mb-1">{t('Ineffekt', 'Input Power')} (kW)</p>
                  {renderSurfaceChart(surfaceChartInfo.inputPowerData, 'pw', 'kW', surfaceChartInfo.indoorTemps)}
                </div>
                <div>
                  <p className="text-xs text-muted-foreground mb-1">COP</p>
                  {renderSurfaceChart(surfaceChartInfo.copData, 'cop', 'COP', surfaceChartInfo.indoorTemps)}
                </div>
              </div>
              {surfaceProfile && (
                <div className="flex gap-4 text-xs text-muted-foreground">
                  {surfaceProfile.source && <span>{t('Källa', 'Source')}: {surfaceProfile.source}</span>}
                  <span>{t('Uppdaterad', 'Updated')}: {new Date(surfaceProfile.updated_at).toLocaleDateString()}</span>
                </div>
              )}
            </div>
          )}

          {/* Borrow section – always at the bottom */}
          {isStaff && (
            <div className="border-t pt-3 space-y-2">
              <div className="flex items-center justify-between">
                <Label className="text-xs">{t('Använd data från annan enhet', 'Use data from another device')}</Label>
                <Switch checked={useBorrowed} onCheckedChange={handleBorrowToggle} />
              </div>
              {useBorrowed && (
                <>
                  <Select
                    value={performanceDataDeviceId || ''}
                    onValueChange={v => onPerformanceDeviceChange(v || null)}
                  >
                    <SelectTrigger><SelectValue placeholder={t('Välj enhet...', 'Select device...')} /></SelectTrigger>
                    <SelectContent>
                      {eligibleDevices.map(d => (
                        <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    {t('Egen data prioriteras alltid över lånad data.', 'Own data always takes precedence over borrowed data.')}
                  </p>
                </>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Editor modal */}
      {editingKind && (
        <PerformanceDataEditor
          open={!!editingKind}
          onOpenChange={open => { if (!open) setEditingKind(null); }}
          deviceId={deviceId}
          profileKind={editingKind}
          existingProfileId={editingProfile?.id || null}
          existingData={editingProfile?.data || null}
          existingSource={editingProfile?.source || null}
          existingNotes={editingProfile?.notes || null}
          onSaved={loadStatuses}
        />
      )}
    </>
  );
};

export default PerformanceDataStatus;
