import React from 'react';
import { Zap } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import PortalLayout from '@/components/portal/PortalLayout';
import { useAuth } from '@/contexts/AuthContext';
import { useLanguage } from '@/contexts/LanguageContext';

// Placeholder tab components – will be implemented in Phase 3
const PlaceholderTab = ({ name }: { name: string }) => (
  <div className="flex items-center justify-center min-h-[300px] text-muted-foreground">
    <p>{name} – coming soon</p>
  </div>
);

const EnergyModeling: React.FC = () => {
  const { isStaff } = useAuth();
  const { t } = useLanguage();

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
            <TabsContent value="device-manager"><PlaceholderTab name="Device Manager" /></TabsContent>
            <TabsContent value="device-templates"><PlaceholderTab name="Device Templates" /></TabsContent>
            <TabsContent value="calibration"><PlaceholderTab name="Calibration" /></TabsContent>
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
            <TabsContent value="device-manager"><PlaceholderTab name="Device Manager" /></TabsContent>
            <TabsContent value="roi"><PlaceholderTab name="ROI" /></TabsContent>
            <TabsContent value="simulator"><PlaceholderTab name="Simulator" /></TabsContent>
            <TabsContent value="house-setup"><PlaceholderTab name="House Setup" /></TabsContent>
            <TabsContent value="tariff"><PlaceholderTab name="Tariff & Pricing" /></TabsContent>
          </Tabs>
        )}
      </div>
    </PortalLayout>
  );
};

export default EnergyModeling;
