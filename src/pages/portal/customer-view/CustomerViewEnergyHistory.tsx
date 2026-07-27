import React from 'react';
import { useViewedCustomer } from '@/contexts/ViewedCustomerContext';
import EnergyHistory from '@/pages/portal/EnergyHistory';

const CustomerViewEnergyHistory: React.FC = () => {
  const { customerId } = useViewedCustomer();
  return <EnergyHistory customerId={customerId || undefined} isStaffView />;
};

export default CustomerViewEnergyHistory;
