import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Loader2, ArrowLeft, MessageSquare } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import CustomerViewLayout from '@/components/portal/CustomerViewLayout';
import { useAuth } from '@/contexts/AuthContext';
import { useViewedCustomer } from '@/contexts/ViewedCustomerContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { supabase } from '@/integrations/supabase/client';

interface Ticket {
  id: string;
  ticket_number: string;
  title: string;
  status: string;
  created_at: string;
  last_activity_at: string;
}

const CustomerViewTickets: React.FC = () => {
  const { user, isStaff, loading: authLoading } = useAuth();
  const { customerId, customerData, loading: customerLoading, error } = useViewedCustomer();
  const navigate = useNavigate();
  const { t } = useLanguage();

  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [ticketsLoading, setTicketsLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    if (!authLoading && !user) {
      navigate('/login');
    }
    if (!authLoading && !isStaff) {
      navigate('/portal');
    }
  }, [user, isStaff, authLoading, navigate]);

  useEffect(() => {
    const fetchTickets = async () => {
      if (!customerId) return;
      setTicketsLoading(true);

      try {
        const { data, error: fetchError } = await supabase
          .from('tickets')
          .select('id, ticket_number, title, status, created_at, last_activity_at')
          .eq('customer_id', customerId)
          .order('last_activity_at', { ascending: false });

        if (fetchError) throw fetchError;
        setTickets(data || []);
      } catch (err) {
        console.error('Error fetching tickets:', err);
      } finally {
        setTicketsLoading(false);
      }
    };

    if (!customerLoading && customerId) {
      fetchTickets();
    }
  }, [customerId, customerLoading]);

  const getStatusBadge = (status: string) => {
    const statusLabels: Record<string, string> = {
      submitted: t('Öppen', 'Open'),
      awaiting_response: t('Väntar på personal', 'Awaiting staff'),
      awaiting_customer: t('Väntar på kund', 'Awaiting customer'),
      closed: t('Stängd', 'Closed'),
    };
    const label = statusLabels[status] || status;

    switch (status) {
      case 'submitted':
        return <Badge className="bg-warning/30 text-warning-foreground border-0">{label}</Badge>;
      case 'awaiting_response':
        return <Badge className="bg-primary/20 text-primary border-0">{label}</Badge>;
      case 'awaiting_customer':
        return <Badge className="bg-secondary text-secondary-foreground border-0">{label}</Badge>;
      case 'closed':
        return <Badge className="bg-muted text-muted-foreground border-0">{label}</Badge>;
      default:
        return <Badge variant="secondary">{label}</Badge>;
    }
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('sv-SE', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  const filteredTickets = tickets.filter((ticket) => {
    const matchesStatus = statusFilter === 'all' || ticket.status === statusFilter;
    const query = searchQuery.toLowerCase();
    const matchesSearch = ticket.title.toLowerCase().includes(query) ||
      ticket.ticket_number.toLowerCase().includes(query);
    return matchesStatus && matchesSearch;
  });

  if (authLoading || customerLoading) {
    return (
      <CustomerViewLayout>
        <div className="flex items-center justify-center min-h-[400px]">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
      </CustomerViewLayout>
    );
  }

  if (error || !customerData) {
    return (
      <CustomerViewLayout>
        <Alert variant="destructive">
          <AlertDescription>
            {error || t('Kunde inte hitta kunden.', 'Customer not found.')}
          </AlertDescription>
        </Alert>
      </CustomerViewLayout>
    );
  }

  return (
    <CustomerViewLayout>
      <div className="space-y-6">
        {/* Back link */}
        <Link 
          to="/portal/customers"
          className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="w-4 h-4 mr-2" />
          {t('Tillbaka till kunder', 'Back to customers')}
        </Link>

        <div>
          <h1 className="text-3xl font-medium">{t('Ärenden', 'Tickets')}</h1>
          <p className="text-muted-foreground">
            {customerData.org_name || t('Namnlös kund', 'Unnamed customer')}
          </p>
        </div>

        {/* Filters */}
        <div className="flex flex-col sm:flex-row gap-4">
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder={t('Alla statusar', 'All statuses')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('Alla statusar', 'All statuses')}</SelectItem>
              <SelectItem value="submitted">{t('Öppen', 'Open')}</SelectItem>
              <SelectItem value="awaiting_response">{t('Väntar på personal', 'Awaiting staff')}</SelectItem>
              <SelectItem value="awaiting_customer">{t('Väntar på kund', 'Awaiting customer')}</SelectItem>
              <SelectItem value="closed">{t('Stängd', 'Closed')}</SelectItem>
            </SelectContent>
          </Select>
          <div className="flex-1">
            <Input
              placeholder={t('Sök på ID eller rubrik...', 'Search by ID or title...')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
        </div>

        <Card>
          <CardContent className="pt-6">
            {ticketsLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-6 h-6 animate-spin text-primary" />
              </div>
            ) : filteredTickets.length === 0 ? (
              <div className="text-center py-12">
                <MessageSquare className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
                <p className="text-muted-foreground">{t('Inga ärenden hittades.', 'No tickets found.')}</p>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-primary">{t('Ärende-ID', 'Ticket ID')}</TableHead>
                    <TableHead className="text-primary">{t('Rubrik', 'Title')}</TableHead>
                    <TableHead className="text-primary">{t('Status', 'Status')}</TableHead>
                    <TableHead className="text-primary">{t('Senaste aktivitet', 'Last activity')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredTickets.map((ticket) => (
                    <TableRow 
                      key={ticket.id}
                      className="cursor-pointer"
                      onClick={() => navigate(`/portal/customers/${customerId}/tickets/${ticket.id}`)}
                    >
                      <TableCell className="font-medium">{ticket.ticket_number}</TableCell>
                      <TableCell>{ticket.title}</TableCell>
                      <TableCell>{getStatusBadge(ticket.status)}</TableCell>
                      <TableCell>{formatDate(ticket.last_activity_at)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </CustomerViewLayout>
  );
};

export default CustomerViewTickets;
