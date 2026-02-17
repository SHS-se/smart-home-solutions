import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Home, ArrowLeft } from 'lucide-react';
import CustomerViewLayout from '@/components/portal/CustomerViewLayout';
import HomeProfileForm from '@/components/portal/home-profile/HomeProfileForm';
import HomeSelector from '@/components/portal/energy/HomeSelector';
import { useAuth } from '@/contexts/AuthContext';
import { useViewedCustomer } from '@/contexts/ViewedCustomerContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { supabase } from '@/integrations/supabase/client';

const CustomerViewHomeProfile: React.FC = () => {
  const { user, isStaff, loading: authLoading } = useAuth();
  const { customerId, customerData, loading: customerLoading } = useViewedCustomer();
  const navigate = useNavigate();
  const { t } = useLanguage();
  const [searchParams, setSearchParams] = useSearchParams();
  const [homeId, setHomeId] = useState<string | null>(null);
  const [homeCount, setHomeCount] = useState(0);

  useEffect(() => {
    if (!authLoading && !user) navigate('/login');
    if (!authLoading && !isStaff) navigate('/portal');
  }, [user, isStaff, authLoading, navigate]);

  useEffect(() => {
    if (!customerId) return;
    const resolveHome = async () => {
      const queryHomeId = searchParams.get('home');
      if (queryHomeId) {
        setHomeId(queryHomeId);
        return;
      }
      const { data: customer } = await supabase
        .from('customers')
        .select('primary_home_id')
        .eq('id', customerId)
        .single();
      const primaryId = (customer as any)?.primary_home_id;
      if (primaryId) {
        setHomeId(primaryId);
      } else {
        // Fallback: first home
        const { data: homes } = await supabase
          .from('homes')
          .select('id')
          .eq('customer_id', customerId)
          .order('created_at')
          .limit(1);
        if (homes?.[0]) setHomeId(homes[0].id);
      }
    };
    resolveHome();
  }, [customerId, searchParams]);

  if (authLoading || customerLoading || !customerId || !user) return null;

  return (
    <CustomerViewLayout>
      <div className="space-y-6 max-w-4xl mx-auto">
        <Link to={`/portal/customers/${customerId}/overview`} className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground transition-colors">
          <ArrowLeft className="w-4 h-4 mr-2" />
          {t('Tillbaka till kundvy', 'Back to customer view')}
        </Link>

        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Home className="w-7 h-7 text-primary" />
            <div>
              <h1 className="text-3xl font-medium">{t('Hemprofil', 'Home Profile')}</h1>
              <p className="text-muted-foreground">{customerData?.name}</p>
            </div>
          </div>
          {homeId && customerId && (
            <HomeSelector
              customerId={customerId}
              selectedHomeId={homeId}
              onHomeChange={(newId) => {
                setHomeId(newId);
                setSearchParams({ home: newId });
              }}
              onHomeCountChange={setHomeCount}
            />
          )}
        </div>

        {homeCount > 1 && (
          <p className="text-sm text-muted-foreground">
            {t('Svaren gäller bara denna fastighet.', 'Answers apply only to this property.')}
          </p>
        )}

        <HomeProfileForm customerId={customerId} userId={user.id} isStaffView homeId={homeId} />
      </div>
    </CustomerViewLayout>
  );
};

export default CustomerViewHomeProfile;
