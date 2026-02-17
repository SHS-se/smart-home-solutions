import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Home, Info, ArrowLeft } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import PortalLayout from '@/components/portal/PortalLayout';
import CustomerViewLayout from '@/components/portal/CustomerViewLayout';
import HomeProfileForm from '@/components/portal/home-profile/HomeProfileForm';
import HomeSelector from '@/components/portal/energy/HomeSelector';
import { useAuth } from '@/contexts/AuthContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { supabase } from '@/integrations/supabase/client';

interface HomeProfileProps {
  customerId?: string;
  isStaffView?: boolean;
  customerName?: string;
}

const HomeProfile: React.FC<HomeProfileProps> = ({ customerId: propCustomerId, isStaffView = false, customerName }) => {
  const { user, customerData, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const { t } = useLanguage();
  const [searchParams, setSearchParams] = useSearchParams();
  const [bannerDismissed, setBannerDismissed] = useState(() => localStorage.getItem('home_profile_banner_dismissed') === 'true');
  const [homeId, setHomeId] = useState<string | null>(null);
  const [homeName, setHomeName] = useState<string | null>(null);
  const [homeCount, setHomeCount] = useState(0);
  const [loadingHome, setLoadingHome] = useState(true);

  const resolvedCustomerId = propCustomerId || customerData?.id;
  const userId = user?.id;

  useEffect(() => {
    if (!authLoading && !user) navigate('/login');
    if (!isStaffView && !authLoading && !customerData) navigate('/portal');
  }, [user, authLoading, customerData, navigate, isStaffView]);

  useEffect(() => {
    if (!resolvedCustomerId) return;
    const resolveHome = async () => {
      setLoadingHome(true);
      const queryHomeId = searchParams.get('home');

      const { data: homes } = await supabase
        .from('homes')
        .select('id, name')
        .eq('customer_id', resolvedCustomerId)
        .order('created_at');

      if (!homes || homes.length === 0) {
        // Auto-create primary home (only for customer self-view)
        if (!isStaffView) {
          const { data: newHome } = await supabase
            .from('homes')
            .insert({ customer_id: resolvedCustomerId, name: 'My home' })
            .select('id, name')
            .single();
          if (newHome) {
            await supabase.from('customers').update({ primary_home_id: newHome.id } as any).eq('id', resolvedCustomerId);
            setHomeId(newHome.id);
            setHomeName(newHome.name);
            setHomeCount(1);
          }
        }
      } else {
        setHomeCount(homes.length);
        if (queryHomeId) {
          const match = homes.find(h => h.id === queryHomeId);
          if (match) {
            setHomeId(match.id);
            setHomeName(match.name);
          } else {
            setHomeId(homes[0].id);
            setHomeName(homes[0].name);
          }
        } else {
          const { data: customer } = await supabase
            .from('customers')
            .select('primary_home_id')
            .eq('id', resolvedCustomerId)
            .single();
          const primaryId = (customer as any)?.primary_home_id;
          const match = primaryId ? homes.find(h => h.id === primaryId) : null;
          setHomeId(match?.id || homes[0].id);
          setHomeName(match?.name || homes[0].name);
        }
      }
      setLoadingHome(false);
    };
    resolveHome();
  }, [resolvedCustomerId, searchParams, isStaffView]);

  if (authLoading || !resolvedCustomerId || !userId || loadingHome) return null;

  const dismissBanner = () => {
    localStorage.setItem('home_profile_banner_dismissed', 'true');
    setBannerDismissed(true);
  };

  const Layout = isStaffView ? CustomerViewLayout : PortalLayout;

  return (
    <Layout>
      <div className="space-y-8 max-w-4xl mx-auto">
        {isStaffView && (
          <Link to={`/portal/customers/${resolvedCustomerId}/overview`} className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground transition-colors">
            <ArrowLeft className="w-4 h-4 mr-2" />
            {t('Tillbaka till kundvy', 'Back to customer view')}
          </Link>
        )}

        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Home className="w-7 h-7 text-primary" />
            <div>
              <h1 className="text-3xl font-medium">{t('Hemprofil', 'Home Profile')}</h1>
              {isStaffView && customerName && (
                <p className="text-muted-foreground">{customerName}</p>
              )}
            </div>
          </div>
          {homeId && (
            <HomeSelector
              customerId={resolvedCustomerId}
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

        {!isStaffView && !bannerDismissed && (
          <Alert className="bg-primary/5 border-primary/20">
            <Info className="w-4 h-4" />
            <AlertDescription className="flex items-center justify-between">
              <span>
                {t(
                  'Tack! Om du fyller i hemprofilen och lägger till bilder kan vi hjälpa dig mycket snabbare.',
                  'Thanks! Filling in your home profile and adding photos helps us help you much faster.'
                )}
              </span>
              <Button variant="ghost" size="sm" onClick={dismissBanner} className="shrink-0 ml-4">
                {t('Stäng', 'Dismiss')}
              </Button>
            </AlertDescription>
          </Alert>
        )}

        <HomeProfileForm customerId={resolvedCustomerId} userId={userId} isStaffView={isStaffView} homeId={homeId} />
      </div>
    </Layout>
  );
};

export default HomeProfile;
