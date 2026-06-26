import React, { useEffect, useState, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, Users, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useTableSort, sortItems } from '@/hooks/use-table-sort';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { SortableTableHead } from '@/components/ui/sortable-table-head';
import { useAuth } from '@/contexts/AuthContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { supabase } from '@/integrations/supabase/client';
import { StaffActionsMenu } from '@/components/portal/staff/StaffActionsMenu';
import { StaffFormDialog, type StaffUser } from '@/components/portal/staff/StaffFormDialog';

type SortColumn = 'full_name' | 'email' | 'phone';

const StaffUsers: React.FC = () => {
  const { user, isStaff, loading } = useAuth();
  const navigate = useNavigate();
  const { t } = useLanguage();
  const [staff, setStaff] = useState<StaffUser[]>([]);
  const [staffLoading, setStaffLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const { sortColumn, sortDirection, handleSort } = useTableSort<SortColumn>({ defaultColumn: 'full_name' });

  useEffect(() => {
    if (!loading && !user) {
      navigate('/login');
    }
    if (!loading && !isStaff) {
      navigate('/portal');
    }
  }, [user, isStaff, loading, navigate]);

  const fetchStaff = useCallback(async () => {
    if (!isStaff) return;
    setStaffLoading(true);
    try {
      const { data, error } = await supabase
        .from('staff_users')
        .select('user_id, full_name, email, phone, address, role, created_at')
        .order('full_name', { ascending: true });

      if (error) throw error;
      setStaff((data || []) as StaffUser[]);
    } catch (error) {
      console.error('Error fetching staff users:', error);
    } finally {
      setStaffLoading(false);
    }
  }, [isStaff]);

  useEffect(() => {
    if (!loading && isStaff) {
      fetchStaff();
    }
  }, [isStaff, loading, fetchStaff]);

  const filteredStaff = useMemo(() => {
    const searchLower = searchQuery.toLowerCase();
    const filtered = staff.filter((s) => (
      s.full_name?.toLowerCase().includes(searchLower) ||
      s.email?.toLowerCase().includes(searchLower) ||
      s.phone?.includes(searchQuery)
    ));
    return sortItems(filtered, sortColumn, sortDirection);
  }, [staff, searchQuery, sortColumn, sortDirection]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!isStaff) {
    return (
      <Alert>
        <AlertDescription>
          {t('Du har inte behörighet att visa denna sida.', "You don't have permission to view this page.")}
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-3xl font-medium">{t('Personal', 'Staff users')}</h1>
          <p className="text-muted-foreground mt-1">
            {t('Hantera personalkonton och inloggningar.', 'Manage staff accounts and logins.')}
          </p>
        </div>
        <Button onClick={() => setShowAdd(true)}>
          <Plus className="w-4 h-4" />
          {t('Lägg till personal', 'Add staff user')}
        </Button>
      </div>

      {/* Search */}
      <div className="max-w-md">
        <Input
          placeholder={t('Sök personal...', 'Search staff...')}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
      </div>

      {/* Staff table */}
      <Card>
        <CardContent className="pt-6">
          {staffLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-6 h-6 animate-spin text-primary" />
            </div>
          ) : filteredStaff.length === 0 ? (
            <div className="text-center py-12">
              <Users className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
              <p className="text-muted-foreground">{t('Ingen personal hittades.', 'No staff users found.')}</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <SortableTableHead column="full_name" currentColumn={sortColumn} currentDirection={sortDirection} onSort={handleSort}>
                    {t('Namn', 'Name')}
                  </SortableTableHead>
                  <SortableTableHead column="email" currentColumn={sortColumn} currentDirection={sortDirection} onSort={handleSort}>
                    {t('E-post', 'Email')}
                  </SortableTableHead>
                  <SortableTableHead column="phone" currentColumn={sortColumn} currentDirection={sortDirection} onSort={handleSort}>
                    {t('Telefon', 'Phone')}
                  </SortableTableHead>
                  <TableHead>{t('Roll', 'Role')}</TableHead>
                  <TableHead className="w-12">{t('Åtgärder', 'Actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredStaff.map((s) => (
                  <TableRow key={s.user_id}>
                    <TableCell className="font-medium">
                      {s.full_name || t('Namnlös', 'Unnamed')}
                      {s.user_id === user?.id && (
                        <span className="ml-2 text-xs text-muted-foreground">({t('du', 'you')})</span>
                      )}
                    </TableCell>
                    <TableCell>{s.email || '-'}</TableCell>
                    <TableCell>{s.phone || '-'}</TableCell>
                    <TableCell>
                      <Badge variant={s.role === 'admin' ? 'default' : 'secondary'}>
                        {s.role === 'admin' ? t('Administratör', 'Admin') : t('Personal', 'Staff')}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <StaffActionsMenu
                        staff={s}
                        currentUserId={user?.id}
                        onUpdated={fetchStaff}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <StaffFormDialog open={showAdd} onOpenChange={setShowAdd} onSaved={fetchStaff} />
    </div>
  );
};

export default StaffUsers;
