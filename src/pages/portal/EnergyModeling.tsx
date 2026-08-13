import React, { useState, useEffect } from 'react';
import { Zap } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAuth } from '@/contexts/AuthContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { supabase } from '@/integrations/supabase/client';
import PlanWorkspace, { type PlanSection } from '@/components/portal/energy/PlanWorkspace';
import ROITab from '@/components/portal/energy/ROITab';
import HomeSelector from '@/components/portal/energy/HomeSelector';

interface EnergyModelingProps {
  customerId?: string;
  isStaffView?: boolean;
}

type EnergyTab = 'roi' | PlanSection;

/**
 * The old device-day simulator, house setup, home devices and tariff tabs were
 * removed on 2026-08-13 (ENERGY_OPTIMISATION_ARCHITECTURE.md §1.3.4/§1.3.5).
 * They were built on `model_runs` and `tariff_instances`, which nothing in the
 * planner path reads. Home profile answers are edited at /portal/home-profile
 * and the live tariff at Settings → Energy Tariff.
 *
 * The live power schedule belongs to Plan. Device classification has its own
 * workspace because it changes how future plans are built.
 */
const EnergyModeling: React.FC<EnergyModelingProps> = ({ customerId: propCustomerId, isStaffView = false }) => {
  const { isStaff, customerData } = useAuth();
  const { t } = useLanguage();

  const resolvedCustomerId = propCustomerId || customerData?.id || '';
  const showStaffGlobal = isStaff && !propCustomerId;

  const [selectedHomeId, setSelectedHomeId] = useState<string | null>(null);
  const [homeCount, setHomeCount] = useState(0);
  const [tab, setTab] = useState<EnergyTab>('roi');

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
    { key: 'thermal', label: t('Termik', 'Thermal') },
    { key: 'economics', label: t('Ekonomi', 'Economics') },
    { key: 'storage', label: t('Lagring', 'Storage') },
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
        <TabsList>
          {tabs.map(item => (
            <TabsTrigger key={item.key} value={item.key}>{item.label}</TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {/*
        Rendered outside TabsContent on purpose. One PlanWorkspace instance stays
        mounted across the five plan sections, so switching tabs changes a prop
        instead of remounting and refetching a 72-hour plan each time.
      */}
      {tab === 'roi' ? (
        <ROITab customerId={resolvedCustomerId} homeId={selectedHomeId} homeCount={homeCount} />
      ) : (
        <PlanWorkspace
          section={tab}
          customerId={resolvedCustomerId}
          homeId={selectedHomeId}
          accountPath={isStaffView ? `/portal/customers/${resolvedCustomerId}/account` : '/portal/account'}
        />
      )}
    </div>
  );
};

export default EnergyModeling;
