import React from 'react';
import { useViewedCustomer } from '@/contexts/ViewedCustomerContext';
import EnergyModeling from '@/pages/portal/EnergyModeling';

const CustomerViewEnergyModeling: React.FC = () => {
  const { customerId } = useViewedCustomer();
  return <EnergyModeling customerId={customerId || undefined} isStaffView />;
};

export default CustomerViewEnergyModeling;
