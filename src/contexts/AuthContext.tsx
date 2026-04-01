import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { User, Session } from '@supabase/supabase-js';
import { supabase } from '@/integrations/supabase/client';

interface CustomerData {
  id: string;
  contact_id: string | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  name: string | null;
  billing_email: string | null;
  phone: string | null;
  site_street: string | null;
  site_postcode: string | null;
  site_city: string | null;
  billing_street: string | null;
  billing_postcode: string | null;
  billing_city: string | null;
  billing_same_as_site: boolean;
  is_test: boolean;
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
  const isMountedRef = useRef(true);
  const userDataRequestIdRef = useRef(0);

  const applyResolvedUserData = (resolved: {
    isStaff: boolean;
    isAdmin: boolean;
    customerData: CustomerData | null;
  }) => {
    if (!isMountedRef.current) return;
    setIsStaff(resolved.isStaff);
    setIsAdmin(resolved.isAdmin);
    setCustomerData(resolved.customerData);
  };

  const clearResolvedUserData = () => {
    applyResolvedUserData({ isStaff: false, isAdmin: false, customerData: null });
  };

  const fetchUserData = async (userId: string, userEmail?: string, requestId?: number) => {
    const activeRequestId = requestId ?? userDataRequestIdRef.current;
    let resolvedState: {
      isStaff: boolean;
      isAdmin: boolean;
      customerData: CustomerData | null;
    } = {
      isStaff: false,
      isAdmin: false,
      customerData: null,
    };

    try {
      // Check if user is staff
      const { data: staffData } = await supabase
        .from('staff_users')
        .select('role')
        .eq('user_id', userId)
        .maybeSingle();

      if (staffData) {
        resolvedState = {
          isStaff: true,
          isAdmin: staffData.role === 'admin',
          customerData: null,
        };
      } else {
        // Check if user is already linked to a customer
        let { data: customer } = await supabase
          .from('customers_with_identity')
          .select('id, contact_id, contact_name, contact_email, contact_phone, name, billing_email, phone, site_street, site_postcode, site_city, billing_street, billing_postcode, billing_city, billing_same_as_site, is_test')
          .eq('user_id', userId)
          .maybeSingle();

        // If not linked, try to auto-link by email
        if (!customer && userEmail) {
          const { data: unlinkedCustomer } = await supabase
            .from('customers_with_identity')
            .select('id, contact_id, contact_name, contact_email, contact_phone, name, billing_email, phone, site_street, site_postcode, site_city, billing_street, billing_postcode, billing_city, billing_same_as_site, is_test')
            .eq('contact_email', userEmail)
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

        resolvedState = {
          isStaff: false,
          isAdmin: false,
          customerData: customer ?? null,
        };
      }
    } catch (error) {
      console.error('Error fetching user data:', error);
    }

    if (!isMountedRef.current || activeRequestId !== userDataRequestIdRef.current) {
      return;
    }
    applyResolvedUserData(resolvedState);
  };

  const refreshUserData = async () => {
    if (user) {
      const requestId = ++userDataRequestIdRef.current;
      await fetchUserData(user.id, user.email, requestId);
    }
  };

  useEffect(() => {
    isMountedRef.current = true;

    const hydrateSession = async (currentSession: Session | null) => {
      const requestId = ++userDataRequestIdRef.current;
      setSession(currentSession);
      setUser(currentSession?.user ?? null);

      if (!currentSession?.user) {
        clearResolvedUserData();
        if (isMountedRef.current && requestId === userDataRequestIdRef.current) {
          setLoading(false);
        }
        return;
      }

      if (isMountedRef.current) {
        setLoading(true);
      }

      await fetchUserData(currentSession.user.id, currentSession.user.email, requestId);

      if (isMountedRef.current && requestId === userDataRequestIdRef.current) {
        setLoading(false);
      }
    };

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (_event, currentSession) => {
        // Defer out of the callback to avoid nested Supabase calls during auth event handling.
        setTimeout(() => {
          void hydrateSession(currentSession);
        }, 0);
      }
    );

    return () => {
      isMountedRef.current = false;
      userDataRequestIdRef.current += 1;
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
