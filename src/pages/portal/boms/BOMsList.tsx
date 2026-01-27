import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useLanguage } from '@/contexts/LanguageContext';
import PortalLayout from '@/components/portal/PortalLayout';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Plus, FileText, Trash2 } from 'lucide-react';
import { toast } from '@/hooks/use-toast';
import { format } from 'date-fns';
import { sv } from 'date-fns/locale';

interface BOM {
  id: string;
  project_name: string;
  version: number;
  customer_id: string | null;
  created_at: string;
  customer?: { org_name: string | null };
}

const BOMsList: React.FC = () => {
  const { t } = useLanguage();
  const { isStaff, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [formData, setFormData] = useState({ project_name: '', customer_id: '' });

  // Fetch BOMs
  const { data: boms = [], isLoading } = useQuery({
    queryKey: ['boms'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('boms')
        .select('*, customers(org_name)')
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data.map(bom => ({
        ...bom,
        customer: (bom as any).customers,
      })) as BOM[];
    },
    enabled: isStaff,
  });

  // Fetch customers
  const { data: customers = [] } = useQuery({
    queryKey: ['customers'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('customers')
        .select('id, org_name')
        .order('org_name');
      if (error) throw error;
      return data;
    },
    enabled: isStaff,
  });

  // Create BOM mutation
  const createMutation = useMutation({
    mutationFn: async (data: { project_name: string; customer_id: string }) => {
      const { data: newBom, error } = await supabase
        .from('boms')
        .insert({ 
          project_name: data.project_name, 
          customer_id: data.customer_id || null 
        })
        .select()
        .single();
      if (error) throw error;
      return newBom;
    },
    onSuccess: (bom) => {
      queryClient.invalidateQueries({ queryKey: ['boms'] });
      setIsDialogOpen(false);
      setFormData({ project_name: '', customer_id: '' });
      navigate(`/portal/boms/${bom.id}`);
    },
    onError: () => {
      toast({ title: t('Kunde inte skapa BOM', 'Failed to create BOM'), variant: 'destructive' });
    },
  });

  // Delete BOM mutation
  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('boms').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['boms'] });
      toast({ title: t('BOM raderad', 'BOM deleted') });
    },
  });

  // Redirect if not staff
  if (!authLoading && !isStaff) {
    navigate('/portal');
    return null;
  }

  return (
    <PortalLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-foreground">BOMs</h1>
            <p className="text-muted-foreground">
              {t('Hantera materialkostnadsberäkningar', 'Manage bill of materials')}
            </p>
          </div>
          <Button onClick={() => setIsDialogOpen(true)}>
            <Plus className="h-4 w-4 mr-2" />
            {t('Skapa ny BOM', 'Create new BOM')}
          </Button>
        </div>

        {/* BOMs Table */}
        <div className="bg-card border border-border rounded-lg overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-muted-foreground text-xs uppercase">{t('Projekt', 'Project')}</TableHead>
                <TableHead className="text-muted-foreground text-xs uppercase">{t('Kund', 'Customer')}</TableHead>
                <TableHead className="text-muted-foreground text-xs uppercase">{t('Version', 'Version')}</TableHead>
                <TableHead className="text-muted-foreground text-xs uppercase">{t('Skapad', 'Created')}</TableHead>
                <TableHead className="text-muted-foreground text-xs uppercase text-right">{t('Åtgärder', 'Actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center py-8 text-muted-foreground">
                    {t('Laddar...', 'Loading...')}
                  </TableCell>
                </TableRow>
              ) : boms.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center py-8 text-muted-foreground">
                    {t('Inga BOMs skapade ännu', 'No BOMs created yet')}
                  </TableCell>
                </TableRow>
              ) : (
                boms.map(bom => (
                  <TableRow key={bom.id}>
                    <TableCell>
                      <Link 
                        to={`/portal/boms/${bom.id}`}
                        className="font-medium hover:text-primary"
                      >
                        {bom.project_name}
                      </Link>
                    </TableCell>
                    <TableCell>
                      {bom.customer?.org_name || <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary">v{bom.version}</Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {format(new Date(bom.created_at), 'PP', { locale: sv })}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        <Button variant="ghost" size="icon" asChild>
                          <Link to={`/portal/boms/${bom.id}`}>
                            <FileText className="h-4 w-4" />
                          </Link>
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => {
                            if (confirm(t('Radera denna BOM?', 'Delete this BOM?'))) {
                              deleteMutation.mutate(bom.id);
                            }
                          }}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* Create BOM Dialog */}
      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('Skapa ny BOM', 'Create new BOM')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="project_name">{t('Projektnamn', 'Project name')} *</Label>
              <Input
                id="project_name"
                value={formData.project_name}
                onChange={(e) => setFormData(prev => ({ ...prev, project_name: e.target.value }))}
                placeholder={t('ex. Villa Täby - Smart Home Installation', 'e.g. Villa Täby - Smart Home Installation')}
              />
            </div>
            <div className="space-y-2">
              <Label>{t('Kund', 'Customer')}</Label>
              <Select 
                value={formData.customer_id || "none"} 
                onValueChange={(value) => setFormData(prev => ({ ...prev, customer_id: value === "none" ? "" : value }))}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t('Välj kund (valfritt)', 'Select customer (optional)')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t('Ingen kund', 'No customer')}</SelectItem>
                  {customers.map(c => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.org_name || t('Okänd kund', 'Unknown customer')}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsDialogOpen(false)}>
              {t('Avbryt', 'Cancel')}
            </Button>
            <Button 
              onClick={() => createMutation.mutate(formData)} 
              disabled={!formData.project_name.trim() || createMutation.isPending}
            >
              {createMutation.isPending ? t('Skapar...', 'Creating...') : t('Skapa BOM', 'Create BOM')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PortalLayout>
  );
};

export default BOMsList;
