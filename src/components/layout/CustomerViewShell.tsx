import React from 'react';
import { Outlet } from 'react-router-dom';
import AppShell from '@/components/layout/AppShell';
import { ViewedCustomerProvider, useViewedCustomer } from '@/contexts/ViewedCustomerContext';

const CustomerViewShellInner: React.FC = () => {
  const { customerId, customerData, loading } = useViewedCustomer();

  return (
    <AppShell
      customerView={{
        customerId: customerId ?? '',
        customerName: customerData?.name ?? customerData?.contact_name ?? null,
        loading,
      }}
    >
      <Outlet />
    </AppShell>
  );
};

/** Layout route for /portal/customers/:customerId/* — staff viewing one
 *  customer's portal. Provides the viewed-customer context and renders the
 *  app shell in customer-view mode (customer nav + persistent context banner). */
const CustomerViewShell: React.FC = () => (
  <ViewedCustomerProvider>
    <CustomerViewShellInner />
  </ViewedCustomerProvider>
);

export default CustomerViewShell;
