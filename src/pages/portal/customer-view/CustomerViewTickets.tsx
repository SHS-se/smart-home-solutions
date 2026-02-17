import React from 'react';
import { useViewedCustomer } from '@/contexts/ViewedCustomerContext';
import TicketsList from '@/pages/portal/TicketsList';

const CustomerViewTickets: React.FC = () => {
  const { customerId, customerData } = useViewedCustomer();
  return <TicketsList customerId={customerId || undefined} isStaffView customerName={customerData?.name || undefined} />;
};

export default CustomerViewTickets;
