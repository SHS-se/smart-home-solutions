import React, { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';

interface CustomerData {
  id: string;
  org_name: string | null;
  billing_email: string | null;
  phone: string | null;
  address: string | null;
  site_address: string | null;
  is_test: boolean;
}

interface ViewedCustomerContextType {
  customerId: string | null;
  customerData: CustomerData | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
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

  const fetchCustomer = useCallback(async () => {
    if (!customerId) {
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const { data, error: fetchError } = await supabase
        .from('customers')
        .select('id, org_name, billing_email, phone, address, site_address, is_test')
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
  }, [customerId]);

  useEffect(() => {
    fetchCustomer();
  }, [fetchCustomer]);

  const refetch = useCallback(() => {
    fetchCustomer();
  }, [fetchCustomer]);

  return (
    <ViewedCustomerContext.Provider value={{ customerId: customerId || null, customerData, loading, error, refetch }}>
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
