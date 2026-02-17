import React from 'react';
import { useViewedCustomer } from '@/contexts/ViewedCustomerContext';
import HomeProfile from '@/pages/portal/HomeProfile';

const CustomerViewHomeProfile: React.FC = () => {
  const { customerId, customerData } = useViewedCustomer();
  return <HomeProfile customerId={customerId || undefined} isStaffView customerName={customerData?.name || undefined} />;
};

export default CustomerViewHomeProfile;
