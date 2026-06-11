import React, { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Check, ChevronsUpDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useLanguage } from '@/contexts/LanguageContext';
import { supabase } from '@/integrations/supabase/client';
import { getCustomerViewBasePath } from '@/lib/navigation';

interface CustomerOption {
  id: string;
  name: string | null;
}

interface CustomerSwitcherProps {
  currentCustomerId: string;
}

/** Compact customer search used in the customer-view banner to jump between
 *  customers while staying on the same portal section. */
const CustomerSwitcher: React.FC<CustomerSwitcherProps> = ({ currentCustomerId }) => {
  const { t } = useLanguage();
  const navigate = useNavigate();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [customers, setCustomers] = useState<CustomerOption[]>([]);

  useEffect(() => {
    if (!open || customers.length > 0) return;
    const fetchCustomers = async () => {
      const { data, error } = await supabase
        .from('customers_with_identity')
        .select('id, name')
        .order('name', { ascending: true });
      if (!error && data) setCustomers((data as CustomerOption[]).filter((c) => c.id));
    };
    fetchCustomers();
  }, [open, customers.length]);

  const handleSelect = (customerId: string) => {
    setOpen(false);
    if (customerId === currentCustomerId) return;
    // Keep the current section (overview/billing/tickets/...) but drop any
    // deeper detail segments — they belong to the previous customer's data.
    const currentBase = getCustomerViewBasePath(currentCustomerId);
    const section = location.pathname.slice(currentBase.length).split('/').filter(Boolean)[0] || 'overview';
    navigate(`${getCustomerViewBasePath(customerId)}/${section}`);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          role="combobox"
          aria-expanded={open}
          className="h-7 border-primary/30 bg-background/60 px-2 text-xs"
        >
          {t('Byt kund', 'Switch customer')}
          <ChevronsUpDown className="ml-1 h-3.5 w-3.5 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="end">
        <Command>
          <CommandInput placeholder={t('Sök kund...', 'Search customer...')} />
          <CommandList>
            <CommandEmpty>{t('Ingen kund hittades.', 'No customer found.')}</CommandEmpty>
            <CommandGroup>
              {customers.map((customer) => (
                <CommandItem
                  key={customer.id}
                  value={`${customer.name || ''} ${customer.id}`}
                  onSelect={() => handleSelect(customer.id)}
                >
                  <Check
                    className={`mr-2 h-4 w-4 ${customer.id === currentCustomerId ? 'opacity-100' : 'opacity-0'}`}
                  />
                  <span className="truncate">{customer.name || t('Namnlös kund', 'Unnamed customer')}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
};

export default CustomerSwitcher;
