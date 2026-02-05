import React, { useEffect, useState, useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Loader2, Plus, Search } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { SortableTableHead } from '@/components/ui/sortable-table-head';
import PortalLayout from '@/components/portal/PortalLayout';
import SubscriptionRequiredAlert from '@/components/portal/SubscriptionRequiredAlert';
import { useAuth } from '@/contexts/AuthContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { useTableSort, sortItems } from '@/hooks/use-table-sort';
import { useSubscription } from '@/hooks/use-subscription';
import { supabase } from '@/integrations/supabase/client';

interface Ticket {
  id: string;
  ticket_number: string;
  title: string;
  status: string;
  created_at: string;
  last_activity_at: string;
  customer_id: string;
  customers?: { name: string | null };
}

type SortColumn = 'ticket_number' | 'title' | 'customer' | 'status' | 'last_activity_at';

const TicketsList: React.FC = () => {
  const { user, customerData, loading, isStaff } = useAuth();
  const { isSubscribed, loading: subscriptionLoading } = useSubscription();
  const navigate = useNavigate();
  const { t } = useLanguage();
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [ticketsLoading, setTicketsLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const { sortColumn, sortDirection, handleSort } = useTableSort<SortColumn>({ 
    defaultColumn: 'last_activity_at', 
    defaultDirection: 'desc' 
  });

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
        return <Badge className="bg-accent/20 text-accent-foreground border-0">{label}</Badge>;
      case 'closed':
        return <Badge variant="secondary">{label}</Badge>;
      default:
        return <Badge variant="outline">{label}</Badge>;
    }
  };

  useEffect(() => {
    if (!loading && !user) {
      navigate('/login');
    }
  }, [user, loading, navigate]);

  useEffect(() => {
    const fetchTickets = async () => {
      if (!user) return;
      setTicketsLoading(true);

      try {
        let query = supabase
          .from('tickets')
          .select('*, customers(name)')
          .order('last_activity_at', { ascending: false });

        // Filter by customer if not staff
        if (!isStaff && customerData) {
          query = query.eq('customer_id', customerData.id);
        }

        const { data, error } = await query;

        if (error) throw error;
        setTickets(data || []);
      } catch (error) {
        console.error('Error fetching tickets:', error);
      } finally {
        setTicketsLoading(false);
      }
    };

    if (!loading) {
      fetchTickets();
    }
  }, [user, customerData, isStaff, loading]);

  const filteredTickets = useMemo(() => {
    const filtered = tickets.filter((ticket) => {
      const matchesStatus = statusFilter === 'all' || ticket.status === statusFilter;
      const query = searchQuery.toLowerCase();
      const matchesSearch = ticket.title.toLowerCase().includes(query) || 
                            ticket.ticket_number.toLowerCase().includes(query);
      return matchesStatus && matchesSearch;
    });

    // Apply sorting
    return sortItems(filtered, sortColumn as keyof Ticket, sortDirection, {
      getValue: (ticket) => {
        switch (sortColumn) {
          case 'customer':
            return ticket.customers?.name ?? '';
          case 'last_activity_at':
            return new Date(ticket.last_activity_at);
          default:
            return ticket[sortColumn as keyof Ticket] as string;
        }
      },
    });
  }, [tickets, statusFilter, searchQuery, sortColumn, sortDirection]);

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('sv-SE');
  };

  if (loading) {
    return (
      <PortalLayout>
        <div className="flex items-center justify-center min-h-[400px]">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
      </PortalLayout>
    );
  }

  return (
    <PortalLayout>
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <h1 className="text-3xl font-medium">{t('Supportärenden', 'Support tickets')}</h1>
          {!isStaff && customerData && (
            !isSubscribed || subscriptionLoading ? (
              <Button disabled>
                <Plus className="w-4 h-4 mr-2" />
                {t('Nytt ärende', 'New ticket')}
              </Button>
            ) : (
              <Button asChild>
                <Link to="/portal/tickets/new">
                  <Plus className="w-4 h-4 mr-2" />
                  {t('Nytt ärende', 'New ticket')}
                </Link>
              </Button>
            )
          )}
        </div>

        {/* Show subscription required alert for customers without subscription */}
        {!isStaff && !subscriptionLoading && !isSubscribed && (
          <SubscriptionRequiredAlert />
        )}

        {/* Filters */}
        <div className="flex flex-col sm:flex-row gap-4">
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-full sm:w-48">
              <SelectValue placeholder={t('Filtrera på status', 'Filter by status')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('Alla statusar', 'All statuses')}</SelectItem>
              <SelectItem value="submitted">{t('Öppen', 'Open')}</SelectItem>
              <SelectItem value="awaiting_response">{t('Väntar på personal', 'Awaiting staff')}</SelectItem>
              <SelectItem value="awaiting_customer">{t('Väntar på kund', 'Awaiting customer')}</SelectItem>
              <SelectItem value="closed">{t('Stängd', 'Closed')}</SelectItem>
            </SelectContent>
          </Select>
          
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder={t('Sök på ID eller rubrik...', 'Search by ID or title...')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10"
            />
          </div>
        </div>

        {/* Tickets Table */}
        <Card>
          <CardContent className="pt-6">
            {ticketsLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-6 h-6 animate-spin text-primary" />
              </div>
            ) : filteredTickets.length === 0 ? (
              <div className="text-center py-12">
                <p className="text-muted-foreground mb-4">{t('Inga ärenden hittades.', 'No tickets found.')}</p>
                {!isStaff && customerData && (
                  <Button asChild variant="outline">
                    <Link to="/portal/tickets/new">{t('Skapa ditt första ärende', 'Create your first ticket')}</Link>
                  </Button>
                )}
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <SortableTableHead column="ticket_number" currentColumn={sortColumn} currentDirection={sortDirection} onSort={handleSort}>
                      {t('Ärende-ID', 'Ticket ID')}
                    </SortableTableHead>
                    <SortableTableHead column="title" currentColumn={sortColumn} currentDirection={sortDirection} onSort={handleSort}>
                      {t('Rubrik', 'Title')}
                    </SortableTableHead>
                    {isStaff && (
                      <SortableTableHead column="customer" currentColumn={sortColumn} currentDirection={sortDirection} onSort={handleSort}>
                        {t('Kund', 'Customer')}
                      </SortableTableHead>
                    )}
                    <SortableTableHead column="status" currentColumn={sortColumn} currentDirection={sortDirection} onSort={handleSort}>
                      {t('Status', 'Status')}
                    </SortableTableHead>
                    <SortableTableHead column="last_activity_at" currentColumn={sortColumn} currentDirection={sortDirection} onSort={handleSort}>
                      {t('Senaste aktivitet', 'Last activity')}
                    </SortableTableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredTickets.map((ticket) => (
                    <TableRow 
                      key={ticket.id}
                      className="cursor-pointer"
                      onClick={() => navigate(`/portal/tickets/${ticket.ticket_number}`)}
                    >
                      <TableCell className="font-medium">{ticket.ticket_number}</TableCell>
                      <TableCell className="max-w-md truncate">{ticket.title}</TableCell>
                      {isStaff && (
                        <TableCell>{ticket.customers?.name || t('Okänd', 'Unknown')}</TableCell>
                      )}
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
    </PortalLayout>
  );
};

export default TicketsList;
