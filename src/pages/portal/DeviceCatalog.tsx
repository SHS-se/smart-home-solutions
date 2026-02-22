import React from 'react';
import { Box } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import PortalLayout from '@/components/portal/PortalLayout';
import { useAuth } from '@/contexts/AuthContext';
import { useLanguage } from '@/contexts/LanguageContext';
import DeviceCatalogTab from '@/components/portal/energy/DeviceCatalogTab';
import DeviceTypesManager from '@/components/portal/energy/DeviceTypesManager';
import CalibrationTab from '@/components/portal/energy/CalibrationTab';

const DeviceCatalog: React.FC = () => {
  const { isStaff } = useAuth();
  const { t } = useLanguage();

  return (
    <PortalLayout>
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-primary/10">
            <Box className="w-6 h-6 text-primary" />
          </div>
          <h1 className="text-3xl font-medium">
            {t('Enhetskatalog', 'Device Catalog')}
          </h1>
        </div>

        <Tabs defaultValue="devices">
          <TabsList>
            <TabsTrigger value="devices">{t('Enheter', 'Devices')}</TabsTrigger>
            {isStaff && (
              <>
                <TabsTrigger value="device-types">{t('Enhetstyper', 'Device Types')}</TabsTrigger>
                <TabsTrigger value="calibration">{t('Kalibrering', 'Calibration')}</TabsTrigger>
              </>
            )}
          </TabsList>
          <TabsContent value="devices"><DeviceCatalogTab /></TabsContent>
          {isStaff && (
            <>
              <TabsContent value="device-types"><DeviceTypesManager /></TabsContent>
              <TabsContent value="calibration"><CalibrationTab /></TabsContent>
            </>
          )}
        </Tabs>
      </div>
    </PortalLayout>
  );
};

export default DeviceCatalog;
