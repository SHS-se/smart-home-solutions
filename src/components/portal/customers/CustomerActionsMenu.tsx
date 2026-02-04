import React from 'react';
import { MoreHorizontal, FlaskConical, Building2 } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { useLanguage } from '@/contexts/LanguageContext';
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/integrations/supabase/client';

interface CustomerActionsMenuProps {
  customerId: string;
  isTest: boolean;
  onUpdated: () => void;
}

export const CustomerActionsMenu: React.FC<CustomerActionsMenuProps> = ({
  customerId,
  isTest,
  onUpdated,
}) => {
  const { t } = useLanguage();
  const { toast } = useToast();

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

  return (
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
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
