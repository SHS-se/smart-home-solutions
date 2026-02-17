import React, { useState, useEffect } from 'react';
import { Zap } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import CustomerViewLayout from '@/components/portal/CustomerViewLayout';
import { useLanguage } from '@/contexts/LanguageContext';
import { useViewedCustomer } from '@/contexts/ViewedCustomerContext';
import { supabase } from '@/integrations/supabase/client';
import HouseSetupTab from '@/components/portal/energy/HouseSetupTab';
import DeviceManagerTab from '@/components/portal/energy/DeviceManagerTab';
import TariffPricingTab from '@/components/portal/energy/TariffPricingTab';
import SimulatorTab from '@/components/portal/energy/SimulatorTab';
import ROITab from '@/components/portal/energy/ROITab';
import HomeSelector from '@/components/portal/energy/HomeSelector';

const CustomerViewEnergyModeling: React.FC = () => {
  const { t } = useLanguage();
  const { customerId } = useViewedCustomer();
  const [selectedHomeId, setSelectedHomeId] = useState<string | null>(null);
  const [homeCount, setHomeCount] = useState(0);

  // Auto-select primary home on mount
  useEffect(() => {
    if (!customerId) return;
    const fetchPrimary = async () => {
      const { data: customer } = await supabase
        .from('customers')
        .select('primary_home_id')
        .eq('id', customerId)
        .single();
      const primaryId = (customer as any)?.primary_home_id;
      if (primaryId) setSelectedHomeId(primaryId);
    };
    fetchPrimary();
  }, [customerId]);

  return (
    <CustomerViewLayout>
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-primary/10">
            <Zap className="w-6 h-6 text-primary" />
          </div>
          <h1 className="text-3xl font-medium">
            {t('Energimodellering', 'Energy Modeling')}
          </h1>
        </div>

        {customerId && (
          <HomeSelector
            customerId={customerId}
            selectedHomeId={selectedHomeId}
            onHomeChange={setSelectedHomeId}
            onHomeCountChange={setHomeCount}
          />
        )}

        <Tabs defaultValue="roi">
          <TabsList>
            <TabsTrigger value="roi">{t('Lönsamhet', 'ROI')}</TabsTrigger>
            <TabsTrigger value="home-setup">{t('Heminställningar', 'Home Setup')}</TabsTrigger>
            <TabsTrigger value="device-manager">{t('Enhetshanterare', 'Device Manager')}</TabsTrigger>
            <TabsTrigger value="simulator">{t('Simulator', 'Simulator')}</TabsTrigger>
            <TabsTrigger value="tariff">{t('Tariff & Pris', 'Tariff & Pricing')}</TabsTrigger>
          </TabsList>
          <TabsContent value="roi">{customerId ? <ROITab customerId={customerId} homeId={selectedHomeId} homeCount={homeCount} /> : null}</TabsContent>
          <TabsContent value="home-setup">{customerId ? <HouseSetupTab customerId={customerId} homeId={selectedHomeId} /> : null}</TabsContent>
          <TabsContent value="device-manager">{customerId ? <DeviceManagerTab customerId={customerId} homeId={selectedHomeId} /> : null}</TabsContent>
          <TabsContent value="simulator">{customerId ? <SimulatorTab customerId={customerId} homeId={selectedHomeId} /> : null}</TabsContent>
          <TabsContent value="tariff">{customerId ? <TariffPricingTab customerId={customerId} /> : null}</TabsContent>
        </Tabs>
      </div>
    </CustomerViewLayout>
  );
};

export default CustomerViewEnergyModeling;
