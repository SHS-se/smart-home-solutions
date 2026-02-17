import React from 'react';
import { useViewedCustomer } from '@/contexts/ViewedCustomerContext';
import Offers from '@/pages/portal/Offers';

const CustomerViewOffers: React.FC = () => {
  const { customerId, customerData } = useViewedCustomer();
  return <Offers customerId={customerId || undefined} isStaffView customerName={customerData?.name || undefined} />;
};

export default CustomerViewOffers;
