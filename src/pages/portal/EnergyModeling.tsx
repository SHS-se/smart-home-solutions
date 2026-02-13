import React from 'react';
import { Zap } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import PortalLayout from '@/components/portal/PortalLayout';
import { useAuth } from '@/contexts/AuthContext';
import { useLanguage } from '@/contexts/LanguageContext';
import HouseSetupTab from '@/components/portal/energy/HouseSetupTab';
import DeviceManagerTab from '@/components/portal/energy/DeviceManagerTab';
import TariffPricingTab from '@/components/portal/energy/TariffPricingTab';
import SimulatorTab from '@/components/portal/energy/SimulatorTab';
import ROITab from '@/components/portal/energy/ROITab';
import DeviceTemplatesTab from '@/components/portal/energy/DeviceTemplatesTab';
import CalibrationTab from '@/components/portal/energy/CalibrationTab';

const EnergyModeling: React.FC = () => {
  const { isStaff, customerData } = useAuth();
  const { t } = useLanguage();

  // For customer view, we need their customer ID
  const customerId = customerData?.id || '';

  return (
    <PortalLayout>
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-primary/10">
            <Zap className="w-6 h-6 text-primary" />
          </div>
          <h1 className="text-3xl font-medium">
            {t('Energimodellering', 'Energy Modeling')}
          </h1>
        </div>

        {isStaff ? (
          <Tabs defaultValue="device-manager">
            <TabsList>
              <TabsTrigger value="device-manager">{t('Enhetshanterare', 'Device Manager')}</TabsTrigger>
              <TabsTrigger value="device-templates">{t('Enhetsmallar', 'Device Templates')}</TabsTrigger>
              <TabsTrigger value="calibration">{t('Kalibrering', 'Calibration')}</TabsTrigger>
            </TabsList>
            <TabsContent value="device-manager">
              {customerId ? <DeviceManagerTab customerId={customerId} /> : (
                <div className="flex items-center justify-center min-h-[300px] text-muted-foreground">
                  <p>{t('Välj en kund för att hantera enheter', 'Select a customer to manage devices')}</p>
                </div>
              )}
            </TabsContent>
            <TabsContent value="device-templates"><DeviceTemplatesTab /></TabsContent>
            <TabsContent value="calibration"><CalibrationTab /></TabsContent>
          </Tabs>
        ) : (
          <Tabs defaultValue="device-manager">
            <TabsList>
              <TabsTrigger value="device-manager">{t('Enhetshanterare', 'Device Manager')}</TabsTrigger>
              <TabsTrigger value="roi">{t('Lönsamhet', 'ROI')}</TabsTrigger>
              <TabsTrigger value="simulator">{t('Simulator', 'Simulator')}</TabsTrigger>
              <TabsTrigger value="house-setup">{t('Husinställningar', 'House Setup')}</TabsTrigger>
              <TabsTrigger value="tariff">{t('Tariff & Pris', 'Tariff & Pricing')}</TabsTrigger>
            </TabsList>
            <TabsContent value="device-manager"><DeviceManagerTab customerId={customerId} /></TabsContent>
            <TabsContent value="roi"><ROITab customerId={customerId} /></TabsContent>
            <TabsContent value="simulator"><SimulatorTab customerId={customerId} /></TabsContent>
            <TabsContent value="house-setup"><HouseSetupTab customerId={customerId} /></TabsContent>
            <TabsContent value="tariff"><TariffPricingTab customerId={customerId} /></TabsContent>
          </Tabs>
        )}
      </div>
    </PortalLayout>
  );
};

export default EnergyModeling;
