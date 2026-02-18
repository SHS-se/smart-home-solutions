import React, { useState, useEffect } from 'react';
import { Zap } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import PortalLayout from '@/components/portal/PortalLayout';
import CustomerViewLayout from '@/components/portal/CustomerViewLayout';
import { useAuth } from '@/contexts/AuthContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { supabase } from '@/integrations/supabase/client';
import HouseSetupTab from '@/components/portal/energy/HouseSetupTab';
import DeviceManagerTab from '@/components/portal/energy/DeviceManagerTab';
import TariffPricingTab from '@/components/portal/energy/TariffPricingTab';
import SimulatorTab from '@/components/portal/energy/SimulatorTab';
import ROITab from '@/components/portal/energy/ROITab';
import DeviceTemplatesTab from '@/components/portal/energy/DeviceTemplatesTab';
import CalibrationTab from '@/components/portal/energy/CalibrationTab';
import HomeSelector from '@/components/portal/energy/HomeSelector';
import DeviceTypesManager from '@/components/portal/energy/DeviceTypesManager';

interface EnergyModelingProps {
  customerId?: string;
  isStaffView?: boolean;
}

const EnergyModeling: React.FC<EnergyModelingProps> = ({ customerId: propCustomerId, isStaffView = false }) => {
  const { isStaff, customerData } = useAuth();
  const { t } = useLanguage();
  
  // When viewing as staff for a specific customer, use propCustomerId
  // When viewing as customer, use customerData.id
  // When staff views the global page (no propCustomerId), show staff-only tabs
  const resolvedCustomerId = propCustomerId || customerData?.id || '';
  const showStaffOnlyTabs = isStaff && !propCustomerId;
  
  const [selectedHomeId, setSelectedHomeId] = useState<string | null>(null);
  const [homeCount, setHomeCount] = useState(0);

  // Auto-select primary home on mount
  useEffect(() => {
    if (!resolvedCustomerId || showStaffOnlyTabs) return;
    const fetchPrimary = async () => {
      const { data: customer } = await supabase
        .from('customers')
        .select('primary_home_id')
        .eq('id', resolvedCustomerId)
        .single();
      const primaryId = (customer as any)?.primary_home_id;
      if (primaryId) setSelectedHomeId(primaryId);
    };
    fetchPrimary();
  }, [resolvedCustomerId, showStaffOnlyTabs]);

  const Layout = isStaffView ? CustomerViewLayout : PortalLayout;

  return (
    <Layout>
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-primary/10">
            <Zap className="w-6 h-6 text-primary" />
          </div>
          <h1 className="text-3xl font-medium">
            {t('Energimodellering', 'Energy Modeling')}
          </h1>
        </div>

        {showStaffOnlyTabs ? (
          <Tabs defaultValue="device-types">
            <TabsList>
              <TabsTrigger value="device-types">{t('Enhetstyper', 'Device Types')}</TabsTrigger>
              <TabsTrigger value="device-manager">{t('Enhetsmallar', 'Device Templates')}</TabsTrigger>
              <TabsTrigger value="calibration">{t('Kalibrering', 'Calibration')}</TabsTrigger>
            </TabsList>
            <TabsContent value="device-types"><DeviceTypesManager /></TabsContent>
            <TabsContent value="device-manager"><DeviceTemplatesTab /></TabsContent>
            <TabsContent value="calibration"><CalibrationTab /></TabsContent>
          </Tabs>
        ) : (
          <>
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
                <TabsTrigger value="device-manager">{t('Enhetshanterare', 'Device Manager')}</TabsTrigger>
                <TabsTrigger value="simulator">{t('Simulator', 'Simulator')}</TabsTrigger>
                <TabsTrigger value="tariff">{t('Tariff & Pris', 'Tariff & Pricing')}</TabsTrigger>
              </TabsList>
              <TabsContent value="roi"><ROITab customerId={resolvedCustomerId} homeId={selectedHomeId} homeCount={homeCount} /></TabsContent>
              <TabsContent value="home-setup"><HouseSetupTab customerId={resolvedCustomerId} homeId={selectedHomeId} /></TabsContent>
              <TabsContent value="device-manager"><DeviceManagerTab customerId={resolvedCustomerId} homeId={selectedHomeId} /></TabsContent>
              <TabsContent value="simulator"><SimulatorTab customerId={resolvedCustomerId} homeId={selectedHomeId} /></TabsContent>
              <TabsContent value="tariff">{resolvedCustomerId ? <TariffPricingTab customerId={resolvedCustomerId} /> : null}</TabsContent>
            </Tabs>
          </>
        )}
      </div>
    </Layout>
  );
};

export default EnergyModeling;
