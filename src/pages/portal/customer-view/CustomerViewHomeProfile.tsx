import React, { useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Home, ArrowLeft } from 'lucide-react';
import CustomerViewLayout from '@/components/portal/CustomerViewLayout';
import HomeProfileForm from '@/components/portal/home-profile/HomeProfileForm';
import { useAuth } from '@/contexts/AuthContext';
import { useViewedCustomer } from '@/contexts/ViewedCustomerContext';
import { useLanguage } from '@/contexts/LanguageContext';

const CustomerViewHomeProfile: React.FC = () => {
  const { user, isStaff, loading: authLoading } = useAuth();
  const { customerId, customerData, loading: customerLoading } = useViewedCustomer();
  const navigate = useNavigate();
  const { t } = useLanguage();

  useEffect(() => {
    if (!authLoading && !user) navigate('/login');
    if (!authLoading && !isStaff) navigate('/portal');
  }, [user, isStaff, authLoading, navigate]);

  if (authLoading || customerLoading || !customerId || !user) return null;

  return (
    <CustomerViewLayout>
      <div className="space-y-6 max-w-4xl mx-auto">
        <Link to={`/portal/customers/${customerId}/overview`} className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground transition-colors">
          <ArrowLeft className="w-4 h-4 mr-2" />
          {t('Tillbaka till kundvy', 'Back to customer view')}
        </Link>

        <div className="flex items-center gap-3">
          <Home className="w-7 h-7 text-primary" />
          <div>
            <h1 className="text-3xl font-medium">{t('Hemprofil', 'Home Profile')}</h1>
            <p className="text-muted-foreground">{customerData?.name}</p>
          </div>
        </div>

        <HomeProfileForm customerId={customerId} userId={user.id} isStaffView />
      </div>
    </CustomerViewLayout>
  );
};

export default CustomerViewHomeProfile;
