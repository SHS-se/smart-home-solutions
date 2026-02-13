import React from 'react';
import { Zap } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import CustomerViewLayout from '@/components/portal/CustomerViewLayout';
import { useLanguage } from '@/contexts/LanguageContext';

const PlaceholderTab = ({ name }: { name: string }) => (
  <div className="flex items-center justify-center min-h-[300px] text-muted-foreground">
    <p>{name} – coming soon</p>
  </div>
);

const CustomerViewEnergyModeling: React.FC = () => {
  const { t } = useLanguage();

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

        <Tabs defaultValue="roi">
          <TabsList>
            <TabsTrigger value="roi">{t('Lönsamhet', 'ROI')}</TabsTrigger>
            <TabsTrigger value="simulator">{t('Simulator', 'Simulator')}</TabsTrigger>
            <TabsTrigger value="house-setup">{t('Husinställningar', 'House Setup')}</TabsTrigger>
            <TabsTrigger value="device-manager">{t('Enhetshanterare', 'Device Manager')}</TabsTrigger>
            <TabsTrigger value="tariff">{t('Tariff & Pris', 'Tariff & Pricing')}</TabsTrigger>
          </TabsList>
          <TabsContent value="roi"><PlaceholderTab name="ROI" /></TabsContent>
          <TabsContent value="simulator"><PlaceholderTab name="Simulator" /></TabsContent>
          <TabsContent value="house-setup"><PlaceholderTab name="House Setup" /></TabsContent>
          <TabsContent value="device-manager"><PlaceholderTab name="Device Manager" /></TabsContent>
          <TabsContent value="tariff"><PlaceholderTab name="Tariff & Pricing" /></TabsContent>
        </Tabs>
      </div>
    </CustomerViewLayout>
  );
};

export default CustomerViewEnergyModeling;
