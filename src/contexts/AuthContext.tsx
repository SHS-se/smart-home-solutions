import React, { createContext, useContext, useEffect, useState } from 'react';
import { User, Session } from '@supabase/supabase-js';
import { supabase } from '@/integrations/supabase/client';

interface CustomerData {
  id: string;
  org_name: string | null;
  billing_email: string | null;
  phone: string | null;
  address: string | null;
  site_address: string | null;
}

interface CustomerUserData {
  customer_id: string;
  role: string;
  customer: CustomerData | null;
}

interface AuthContextType {
  user: User | null;
  session: Session | null;
  loading: boolean;
  isStaff: boolean;
  isAdmin: boolean;
  isCustomer: boolean;
  customerData: CustomerData | null;
  customerRole: string | null;
  signOut: () => Promise<void>;
  refreshUserData: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [isStaff, setIsStaff] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [customerData, setCustomerData] = useState<CustomerData | null>(null);
  const [customerRole, setCustomerRole] = useState<string | null>(null);

  const fetchUserData = async (userId: string) => {
    try {
      // Check if user is staff
      const { data: staffData } = await supabase
        .from('staff_users')
        .select('role')
        .eq('user_id', userId)
        .maybeSingle();

      if (staffData) {
        setIsStaff(true);
        setIsAdmin(staffData.role === 'admin');
        setCustomerData(null);
        setCustomerRole(null);
        return;
      }

      setIsStaff(false);
      setIsAdmin(false);

      // Check if user is a customer user
      const { data: customerUserData } = await supabase
        .from('customer_users')
        .select(`
          customer_id,
          role,
          customers (
            id,
            org_name,
            billing_email,
            phone,
            address,
            site_address
          )
        `)
        .eq('user_id', userId)
        .maybeSingle();

      if (customerUserData) {
        const customer = customerUserData.customers as unknown as CustomerData;
        setCustomerData(customer);
        setCustomerRole(customerUserData.role);
      } else {
        setCustomerData(null);
        setCustomerRole(null);
      }
    } catch (error) {
      console.error('Error fetching user data:', error);
    }
  };

  const refreshUserData = async () => {
    if (user) {
      await fetchUserData(user.id);
    }
  };

  useEffect(() => {
    // Set up auth state listener BEFORE getting session
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (event, currentSession) => {
        setSession(currentSession);
        setUser(currentSession?.user ?? null);

        if (currentSession?.user) {
          // Use setTimeout to avoid Supabase deadlock
          setTimeout(() => fetchUserData(currentSession.user.id), 0);
        } else {
          setIsStaff(false);
          setIsAdmin(false);
          setCustomerData(null);
          setCustomerRole(null);
        }
        setLoading(false);
      }
    );

    // Get initial session
    supabase.auth.getSession().then(({ data: { session: currentSession } }) => {
      setSession(currentSession);
      setUser(currentSession?.user ?? null);
      if (currentSession?.user) {
        fetchUserData(currentSession.user.id);
      }
      setLoading(false);
    });

    return () => {
      subscription.unsubscribe();
    };
  }, []);

  const signOut = async () => {
    await supabase.auth.signOut();
    setUser(null);
    setSession(null);
    setIsStaff(false);
    setIsAdmin(false);
    setCustomerData(null);
    setCustomerRole(null);
  };

  const isCustomer = !!customerData;

  return (
    <AuthContext.Provider
      value={{
        user,
        session,
        loading,
        isStaff,
        isAdmin,
        isCustomer,
        customerData,
        customerRole,
        signOut,
        refreshUserData,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
