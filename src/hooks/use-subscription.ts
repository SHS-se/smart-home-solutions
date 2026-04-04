import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';

interface SubscriptionStatus {
  subscribed: boolean;
  subscription_end: string | null;
  cancel_at_period_end?: boolean;
}

interface UseSubscriptionReturn {
  isSubscribed: boolean;
  subscriptionStatus: SubscriptionStatus | null;
  loading: boolean;
  error: string | null;
  checkSubscription: () => Promise<void>;
}

export function useSubscription(): UseSubscriptionReturn {
  const { user, isStaff, loading: authLoading } = useAuth();
  const [subscriptionStatus, setSubscriptionStatus] = useState<SubscriptionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const checkSubscription = useCallback(async () => {
    if (authLoading) {
      setLoading(true);
      return;
    }

    if (!user) {
      setLoading(false);
      setSubscriptionStatus(null);
      setError(null);
      return;
    }

    // Staff always have access
    if (isStaff) {
      setSubscriptionStatus({ subscribed: true, subscription_end: null });
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const { data, error: invokeError } = await supabase.functions.invoke('check-subscription');
      if (invokeError) throw invokeError;
      setSubscriptionStatus(data);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to check subscription';
      console.error('Error checking subscription:', err);
      setError(message);
      setSubscriptionStatus(null);
    } finally {
      setLoading(false);
    }
  }, [authLoading, user, isStaff]);

  useEffect(() => {
    checkSubscription();
  }, [checkSubscription]);

  // A subscription is valid if subscribed is true (even if cancel_at_period_end is true, 
  // they still have access until the end date)
  const isSubscribed = subscriptionStatus?.subscribed ?? false;

  return {
    isSubscribed,
    subscriptionStatus,
    loading,
    error,
    checkSubscription,
  };
}
