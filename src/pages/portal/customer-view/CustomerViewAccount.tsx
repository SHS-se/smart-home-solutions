import React from 'react';
import { useViewedCustomer } from '@/contexts/ViewedCustomerContext';
import Account from '@/pages/portal/Account';

const CustomerViewAccount: React.FC = () => {
  const { customerId, customerData } = useViewedCustomer();
  return <Account customerId={customerId || undefined} isStaffView customerData={customerData} />;
};

export default CustomerViewAccount;
