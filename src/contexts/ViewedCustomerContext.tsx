import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';

interface CustomerData {
  id: string;
  org_name: string | null;
  billing_email: string | null;
  phone: string | null;
  address: string | null;
  site_address: string | null;
}

interface ViewedCustomerContextType {
  customerId: string | null;
  customerData: CustomerData | null;
  loading: boolean;
  error: string | null;
}

const ViewedCustomerContext = createContext<ViewedCustomerContextType | undefined>(undefined);

interface ViewedCustomerProviderProps {
  children: ReactNode;
}

export const ViewedCustomerProvider: React.FC<ViewedCustomerProviderProps> = ({ children }) => {
  const { customerId } = useParams<{ customerId: string }>();
  const [customerData, setCustomerData] = useState<CustomerData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchCustomer = async () => {
      if (!customerId) {
        setLoading(false);
        return;
      }

      setLoading(true);
      setError(null);

      try {
        const { data, error: fetchError } = await supabase
          .from('customers')
          .select('id, org_name, billing_email, phone, address, site_address')
          .eq('id', customerId)
          .single();

        if (fetchError) throw fetchError;
        setCustomerData(data);
      } catch (err: any) {
        console.error('Error fetching customer:', err);
        setError(err.message || 'Failed to fetch customer');
        setCustomerData(null);
      } finally {
        setLoading(false);
      }
    };

    fetchCustomer();
  }, [customerId]);

  return (
    <ViewedCustomerContext.Provider value={{ customerId: customerId || null, customerData, loading, error }}>
      {children}
    </ViewedCustomerContext.Provider>
  );
};

export const useViewedCustomer = (): ViewedCustomerContextType => {
  const context = useContext(ViewedCustomerContext);
  if (context === undefined) {
    throw new Error('useViewedCustomer must be used within a ViewedCustomerProvider');
  }
  return context;
};
