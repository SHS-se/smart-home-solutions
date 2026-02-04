import React, { useState } from 'react';
import { MoreHorizontal, FlaskConical, Building2, Trash2 } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { useLanguage } from '@/contexts/LanguageContext';
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/integrations/supabase/client';

interface CustomerActionsMenuProps {
  customerId: string;
  customerName: string;
  isTest: boolean;
  onUpdated: () => void;
}

export const CustomerActionsMenu: React.FC<CustomerActionsMenuProps> = ({
  customerId,
  customerName,
  isTest,
  onUpdated,
}) => {
  const { t } = useLanguage();
  const { toast } = useToast();
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const handleToggleTest = async (e: React.MouseEvent) => {
    e.stopPropagation();
    
    try {
      const { error } = await supabase
        .from('customers')
        .update({ is_test: !isTest })
        .eq('id', customerId);

      if (error) throw error;

      toast({
        title: t('Uppdaterad', 'Updated'),
        description: isTest
          ? t('Kunden är nu live', 'Customer is now live')
          : t('Kunden är nu markerad som test', 'Customer is now marked as test'),
      });

      onUpdated();
    } catch (error) {
      console.error('Error toggling test status:', error);
      toast({
        title: t('Fel', 'Error'),
        description: t('Kunde inte uppdatera kunden', 'Could not update customer'),
        variant: 'destructive',
      });
    }
  };

  const handleDelete = async () => {
    setIsDeleting(true);
    try {
      const { error } = await supabase
        .from('customers')
        .delete()
        .eq('id', customerId);

      if (error) throw error;

      toast({
        title: t('Borttagen', 'Deleted'),
        description: t('Kunden har tagits bort', 'Customer has been deleted'),
      });

      onUpdated();
    } catch (error: any) {
      console.error('Error deleting customer:', error);
      toast({
        title: t('Fel', 'Error'),
        description: error.message || t('Kunde inte ta bort kunden', 'Could not delete customer'),
        variant: 'destructive',
      });
    } finally {
      setIsDeleting(false);
      setShowDeleteDialog(false);
    }
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
          <Button variant="ghost" size="icon" className="h-8 w-8">
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
          <DropdownMenuItem onClick={handleToggleTest}>
            {isTest ? (
              <>
                <Building2 className="mr-2 h-4 w-4" />
                {t('Markera som live', 'Mark as live')}
              </>
            ) : (
              <>
                <FlaskConical className="mr-2 h-4 w-4" />
                {t('Markera som test', 'Mark as test')}
              </>
            )}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={(e) => {
              e.stopPropagation();
              setShowDeleteDialog(true);
            }}
            className="text-destructive focus:text-destructive"
          >
            <Trash2 className="mr-2 h-4 w-4" />
            {t('Ta bort kund', 'Delete customer')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent onClick={(e) => e.stopPropagation()}>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('Ta bort kund?', 'Delete customer?')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                `Är du säker på att du vill ta bort "${customerName}"? Denna åtgärd kan inte ångras.`,
                `Are you sure you want to delete "${customerName}"? This action cannot be undone.`
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>
              {t('Avbryt', 'Cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting ? t('Tar bort...', 'Deleting...') : t('Ta bort', 'Delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};
