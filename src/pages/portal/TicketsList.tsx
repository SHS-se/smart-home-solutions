import React, { useEffect, useState } from 'react';
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
import PortalLayout from '@/components/portal/PortalLayout';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';

interface Ticket {
  id: string;
  title: string;
  status: string;
  created_at: string;
  last_activity_at: string;
  customer_id: string;
  customers?: { org_name: string | null };
}

const getStatusBadge = (status: string) => {
  switch (status) {
    case 'submitted':
      return <Badge className="bg-warning/30 text-warning-foreground border-0">Open</Badge>;
    case 'awaiting_response':
      return <Badge className="bg-primary/20 text-primary border-0">Awaiting response</Badge>;
    case 'awaiting_customer':
      return <Badge className="bg-accent/20 text-accent-foreground border-0">Awaiting customer</Badge>;
    case 'closed':
      return <Badge variant="secondary">Closed</Badge>;
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
};

const TicketsList: React.FC = () => {
  const { user, customerData, loading, isStaff } = useAuth();
  const navigate = useNavigate();
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [ticketsLoading, setTicketsLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');

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
          .select('*, customers(org_name)')
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

  const filteredTickets = tickets.filter((ticket) => {
    const matchesStatus = statusFilter === 'all' || ticket.status === statusFilter;
    const matchesSearch = ticket.title.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesStatus && matchesSearch;
  });

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('sv-SE');
  };

  const getTicketNumber = (id: string) => {
    // Generate a simple ticket number from UUID
    const hash = id.split('-')[0].toUpperCase();
    return `TKT-${hash.slice(0, 4)}`;
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
          <h1 className="text-3xl font-medium">Support tickets</h1>
          {!isStaff && customerData && (
            <Button asChild>
              <Link to="/portal/tickets/new">
                <Plus className="w-4 h-4 mr-2" />
                New ticket
              </Link>
            </Button>
          )}
        </div>

        {/* Filters */}
        <div className="flex flex-col sm:flex-row gap-4">
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-full sm:w-48">
              <SelectValue placeholder="Filter by status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="submitted">Open</SelectItem>
              <SelectItem value="awaiting_response">Awaiting response</SelectItem>
              <SelectItem value="awaiting_customer">Awaiting customer</SelectItem>
              <SelectItem value="closed">Closed</SelectItem>
            </SelectContent>
          </Select>
          
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="Search by title..."
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
                <p className="text-muted-foreground mb-4">No tickets found.</p>
                {!isStaff && customerData && (
                  <Button asChild variant="outline">
                    <Link to="/portal/tickets/new">Create your first ticket</Link>
                  </Button>
                )}
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-primary">Ticket ID</TableHead>
                    <TableHead className="text-primary">Title</TableHead>
                    {isStaff && <TableHead className="text-primary">Customer</TableHead>}
                    <TableHead className="text-primary">Status</TableHead>
                    <TableHead className="text-primary">Last activity</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredTickets.map((ticket) => (
                    <TableRow key={ticket.id}>
                      <TableCell>
                        <Link
                          to={`/portal/tickets/${ticket.id}`}
                          className="text-primary hover:underline font-medium"
                        >
                          {getTicketNumber(ticket.id)}
                        </Link>
                      </TableCell>
                      <TableCell className="max-w-md truncate">{ticket.title}</TableCell>
                      {isStaff && (
                        <TableCell>{ticket.customers?.org_name || 'Unknown'}</TableCell>
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
