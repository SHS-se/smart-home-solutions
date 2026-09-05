import React, { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Zap } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAuth } from '@/contexts/AuthContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { supabase } from '@/integrations/supabase/client';
import PlanWorkspace, { type PlanSection } from '@/components/portal/energy/PlanWorkspace';
import ROITab from '@/components/portal/energy/ROITab';
import HomeSelector from '@/components/portal/energy/HomeSelector';
import ComfortSchedulesTab from '@/components/portal/energy/ComfortSchedulesTab';
import PlanWorkbenchTab from '@/components/portal/energy/PlanWorkbenchTab';
import HomeTimeZoneProvider from '@/components/portal/energy/HomeTimeZoneContext';

interface EnergyModelingProps {
  customerId?: string;
  isStaffView?: boolean;
}

type EnergyTab = 'roi' | 'comfort' | 'workbench' | PlanSection;

const ENERGY_TABS = new Set<EnergyTab>([
  'roi', 'plan', 'devices', 'comfort', 'thermal', 'economics', 'workbench',
]);

/**
 * The open tab lives in the URL rather than in component state, so a refresh
 * returns to the tab being read instead of to ROI — and so a link to a chart
 * is a link to that chart. An unknown value falls back rather than throwing:
 * tabs have been removed before, and an old bookmark should still open.
 */
function isEnergyTab(value: string | null): value is EnergyTab {
  return value !== null && ENERGY_TABS.has(value as EnergyTab);
}

/**
 * The old device-day simulator, house setup, home devices and tariff tabs were
 * removed on 2026-08-13 (ENERGY_OPTIMISATION_ARCHITECTURE.md §1.3.4/§1.3.5).
 * They were built on `model_runs` and `tariff_instances`, which nothing in the
 * planner path reads. Home profile answers are edited at /portal/home-profile
 * and the live tariff at Settings → Energy Tariff.
 *
 * The live power schedule belongs to Plan. Measured performance and what it
 * cost belong to History (ENERGY_OPTIMISATION_ARCHITECTURE.md §1.3.7); the two
 * charts shared the Plan tab until 2026-08-13 and were competing for it. Device
 * classification has its own workspace because it changes how future plans are
 * built.
 */
const EnergyModeling: React.FC<EnergyModelingProps> = ({ customerId: propCustomerId, isStaffView = false }) => {
  const { isStaff, customerData } = useAuth();
  const { t } = useLanguage();

  const resolvedCustomerId = propCustomerId || customerData?.id || '';
  const showStaffGlobal = isStaff && !propCustomerId;

  const [selectedHomeId, setSelectedHomeId] = useState<string | null>(null);
  const [homeCount, setHomeCount] = useState(0);
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedTab = searchParams.get('tab');
  const tab: EnergyTab = isEnergyTab(requestedTab) ? requestedTab : 'roi';
  const setTab = (next: EnergyTab) => {
    const nextParams = new URLSearchParams(searchParams);
    nextParams.set('tab', next);
    // Replace, so the browser's back button leaves the page rather than
    // walking back through every tab that was looked at.
    setSearchParams(nextParams, { replace: true });
  };

  useEffect(() => {
    if (!resolvedCustomerId || showStaffGlobal) return;
    const fetchPrimary = async () => {
      const { data: customer } = await supabase
        .from('customers')
        .select('primary_home_id')
        .eq('id', resolvedCustomerId)
        .single();
      const primaryId = (customer as { primary_home_id?: string })?.primary_home_id;
      if (primaryId) setSelectedHomeId(primaryId);
    };
    fetchPrimary();
  }, [resolvedCustomerId, showStaffGlobal]);

  const title = t('Energioptimering', 'Energy Optimisation');

  if (showStaffGlobal) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-primary/10">
            <Zap className="w-6 h-6 text-primary" />
          </div>
          <h1 className="text-3xl font-medium">{title}</h1>
        </div>
        <div className="flex items-center justify-center min-h-[300px] text-muted-foreground">
          <p>{t('Välj en kund för att se energioptimering.', 'Select a customer to view energy optimisation.')}</p>
        </div>
      </div>
    );
  }

  const tabs: Array<{ key: EnergyTab; label: string }> = [
    { key: 'roi', label: t('Lönsamhet', 'ROI') },
    { key: 'plan', label: t('Plan', 'Plan') },
    { key: 'devices', label: t('Enheter', 'Devices') },
    { key: 'comfort', label: t('Komfort', 'Comfort') },
    { key: 'thermal', label: t('Termik', 'Thermal') },
    { key: 'economics', label: t('Ekonomi', 'Economics') },
    { key: 'workbench', label: t('Bygg plan', 'Build a plan') },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="p-2 rounded-lg bg-primary/10">
          <Zap className="w-6 h-6 text-primary" />
        </div>
        <h1 className="text-3xl font-medium">{title}</h1>
      </div>

      {resolvedCustomerId && (
        <HomeSelector
          customerId={resolvedCustomerId}
          selectedHomeId={selectedHomeId}
          onHomeChange={setSelectedHomeId}
          onHomeCountChange={setHomeCount}
        />
      )}

      <Tabs value={tab} onValueChange={value => setTab(value as EnergyTab)}>
        <TabsList className="h-auto w-full justify-start overflow-x-auto">
          {tabs.map(item => (
            <TabsTrigger key={item.key} value={item.key}>{item.label}</TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {/*
        Rendered outside TabsContent on purpose. One PlanWorkspace instance stays
        mounted across the plan sections, so switching tabs changes a prop
        instead of remounting and refetching a 72-hour plan each time.
      */}
      {/*
        Every tab below prints times from the same plan, so they share one
        source for the home's timezone rather than each resolving it — and a
        tab that forgot to would quietly fall back to the reader's own clock.
      */}
      <HomeTimeZoneProvider customerId={resolvedCustomerId} homeId={selectedHomeId}>
        {tab === 'roi' ? (
          <ROITab customerId={resolvedCustomerId} homeId={selectedHomeId} homeCount={homeCount} />
        ) : tab === 'comfort' ? (
          <ComfortSchedulesTab customerId={resolvedCustomerId} homeId={selectedHomeId} />
        ) : tab === 'workbench' ? (
          <PlanWorkbenchTab homeId={selectedHomeId} />
        ) : (
          <PlanWorkspace
            section={tab}
            customerId={resolvedCustomerId}
            homeId={selectedHomeId}
            accountPath={isStaffView ? `/portal/customers/${resolvedCustomerId}/account` : '/portal/account'}
          />
        )}
      </HomeTimeZoneProvider>
    </div>
  );
};

export default EnergyModeling;
