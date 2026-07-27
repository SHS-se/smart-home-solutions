import React, { useState, useEffect } from 'react';
import { Zap } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAuth } from '@/contexts/AuthContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { supabase } from '@/integrations/supabase/client';
import HouseSetupTab from '@/components/portal/energy/HouseSetupTab';
import HomeDevicesTab from '@/components/portal/energy/HomeDevicesTab';
import TariffPricingTab from '@/components/portal/energy/TariffPricingTab';
import SimulatorTab from '@/components/portal/energy/SimulatorTab';
import ROITab from '@/components/portal/energy/ROITab';
import HomeSelector from '@/components/portal/energy/HomeSelector';

interface EnergyModelingProps {
  customerId?: string;
  isStaffView?: boolean;
}

const EnergyModeling: React.FC<EnergyModelingProps> = ({ customerId: propCustomerId, isStaffView = false }) => {
  const { isStaff, customerData } = useAuth();
  const { t } = useLanguage();
  
  const resolvedCustomerId = propCustomerId || customerData?.id || '';
  const showStaffGlobal = isStaff && !propCustomerId;
  
  const [selectedHomeId, setSelectedHomeId] = useState<string | null>(null);
  const [homeCount, setHomeCount] = useState(0);

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


  if (showStaffGlobal) {
    return (
      <>
        <div className="space-y-6">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-primary/10">
              <Zap className="w-6 h-6 text-primary" />
            </div>
            <h1 className="text-3xl font-medium">
              {t('Energimodellering', 'Energy Modeling')}
            </h1>
          </div>
          <div className="flex items-center justify-center min-h-[300px] text-muted-foreground">
            <p>{t('Välj en kund för att se energimodellering. Enhetskatalogen finns nu under "Enhetskatalog".', 'Select a customer to view energy modeling. The device catalog is now under "Device Catalog".')}</p>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-primary/10">
            <Zap className="w-6 h-6 text-primary" />
          </div>
          <h1 className="text-3xl font-medium">
            {t('Energimodellering', 'Energy Modeling')}
          </h1>
        </div>

        {resolvedCustomerId && (
          <HomeSelector
            customerId={resolvedCustomerId}
            selectedHomeId={selectedHomeId}
            onHomeChange={setSelectedHomeId}
            onHomeCountChange={setHomeCount}
          />
        )}
        <Tabs defaultValue="roi">
          <TabsList>
            <TabsTrigger value="roi">{t('Lönsamhet', 'ROI')}</TabsTrigger>
            <TabsTrigger value="home-setup">{t('Heminställningar', 'Home Setup')}</TabsTrigger>
            <TabsTrigger value="home-devices">{t('Hemenheter', 'Home Devices')}</TabsTrigger>
            <TabsTrigger value="simulator">{t('Simulator', 'Simulator')}</TabsTrigger>
            <TabsTrigger value="tariff">{t('Tariff & Pris', 'Tariff & Pricing')}</TabsTrigger>
          </TabsList>
          <TabsContent value="roi"><ROITab customerId={resolvedCustomerId} homeId={selectedHomeId} homeCount={homeCount} /></TabsContent>
          <TabsContent value="home-setup"><HouseSetupTab customerId={resolvedCustomerId} homeId={selectedHomeId} /></TabsContent>
          <TabsContent value="home-devices"><HomeDevicesTab customerId={resolvedCustomerId} homeId={selectedHomeId} /></TabsContent>
          <TabsContent value="simulator"><SimulatorTab customerId={resolvedCustomerId} homeId={selectedHomeId} homeCount={homeCount} /></TabsContent>
          <TabsContent value="tariff">{resolvedCustomerId ? <TariffPricingTab customerId={resolvedCustomerId} /> : null}</TabsContent>
        </Tabs>
      </div>
    </>
  );
};

export default EnergyModeling;
