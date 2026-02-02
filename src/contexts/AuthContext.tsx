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

interface AuthContextType {
  user: User | null;
  session: Session | null;
  loading: boolean;
  isStaff: boolean;
  isAdmin: boolean;
  isCustomer: boolean;
  customerData: CustomerData | null;
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

  const fetchUserData = async (userId: string, userEmail?: string) => {
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
        return;
      }

      setIsStaff(false);
      setIsAdmin(false);

      // Check if user is already linked to a customer
      let { data: customer } = await supabase
        .from('customers')
        .select('id, org_name, billing_email, phone, address, site_address')
        .eq('user_id', userId)
        .maybeSingle();

      // If not linked, try to auto-link by email
      if (!customer && userEmail) {
        const { data: unlinkedCustomer } = await supabase
          .from('customers')
          .select('id, org_name, billing_email, phone, address, site_address')
          .eq('billing_email', userEmail)
          .is('user_id', null)
          .maybeSingle();

        if (unlinkedCustomer) {
          // Link the customer to this user
          const { error: linkError } = await supabase
            .from('customers')
            .update({ user_id: userId })
            .eq('id', unlinkedCustomer.id);

          if (!linkError) {
            customer = unlinkedCustomer;
            console.log('Auto-linked customer by email:', unlinkedCustomer.id);
          }
        }
      }

      if (customer) {
        setCustomerData(customer);
      } else {
        setCustomerData(null);
      }
    } catch (error) {
      console.error('Error fetching user data:', error);
    }
  };

  const refreshUserData = async () => {
    if (user) {
      await fetchUserData(user.id, user.email);
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
          setTimeout(() => fetchUserData(currentSession.user.id, currentSession.user.email), 0);
        } else {
          setIsStaff(false);
          setIsAdmin(false);
          setCustomerData(null);
        }
        setLoading(false);
      }
    );

    // Get initial session
    supabase.auth.getSession().then(({ data: { session: currentSession } }) => {
      setSession(currentSession);
      setUser(currentSession?.user ?? null);
      if (currentSession?.user) {
        fetchUserData(currentSession.user.id, currentSession.user.email);
      }
      setLoading(false);
    });

    return () => {
      subscription.unsubscribe();
    };
  }, []);

  const signOut = async () => {
    // Clean up cached quote PDFs before signing out
    if (session?.access_token) {
      try {
        await supabase.functions.invoke('cleanup-quote-pdfs');
      } catch (error) {
        console.error('Failed to cleanup quote PDFs:', error);
        // Don't block logout if cleanup fails
      }
    }
    
    await supabase.auth.signOut();
    setUser(null);
    setSession(null);
    setIsStaff(false);
    setIsAdmin(false);
    setCustomerData(null);
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
