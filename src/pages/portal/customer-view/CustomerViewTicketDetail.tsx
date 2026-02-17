import React from 'react';
import { useParams } from 'react-router-dom';
import TicketDetail from '@/pages/portal/TicketDetail';

const CustomerViewTicketDetail: React.FC = () => {
  const { customerId } = useParams<{ customerId: string }>();
  return <TicketDetail customerId={customerId} isStaffView />;
};

export default CustomerViewTicketDetail;
