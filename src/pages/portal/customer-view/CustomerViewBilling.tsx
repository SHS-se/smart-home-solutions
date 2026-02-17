import React from 'react';
import { useViewedCustomer } from '@/contexts/ViewedCustomerContext';
import Billing from '@/pages/portal/Billing';

const CustomerViewBilling: React.FC = () => {
  const { customerId, customerData } = useViewedCustomer();
  return <Billing customerId={customerId || undefined} isStaffView customerName={customerData?.name || undefined} />;
};

export default CustomerViewBilling;
