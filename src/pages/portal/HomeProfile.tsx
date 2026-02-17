import React, { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Home, Info } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import PortalLayout from '@/components/portal/PortalLayout';
import HomeProfileForm from '@/components/portal/home-profile/HomeProfileForm';
import { useAuth } from '@/contexts/AuthContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { supabase } from '@/integrations/supabase/client';

const HomeProfile: React.FC = () => {
  const { user, customerData, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const { t } = useLanguage();
  const [searchParams] = useSearchParams();
  const [bannerDismissed, setBannerDismissed] = useState(() => localStorage.getItem('home_profile_banner_dismissed') === 'true');
  const [homeId, setHomeId] = useState<string | null>(null);
  const [homeName, setHomeName] = useState<string | null>(null);
  const [homeCount, setHomeCount] = useState(0);
  const [loadingHome, setLoadingHome] = useState(true);

  useEffect(() => {
    if (!authLoading && !user) navigate('/login');
    if (!authLoading && !customerData) navigate('/portal');
  }, [user, authLoading, customerData, navigate]);

  useEffect(() => {
    if (!customerData) return;
    const resolveHome = async () => {
      setLoadingHome(true);
      const queryHomeId = searchParams.get('home');

      // Fetch all homes for count
      const { data: homes } = await supabase
        .from('homes')
        .select('id, name')
        .eq('customer_id', customerData.id)
        .order('created_at');

      if (!homes || homes.length === 0) {
        // Auto-create primary home
        const { data: newHome } = await supabase
          .from('homes')
          .insert({ customer_id: customerData.id, name: 'My home' })
          .select('id, name')
          .single();
        if (newHome) {
          await supabase.from('customers').update({ primary_home_id: newHome.id } as any).eq('id', customerData.id);
          setHomeId(newHome.id);
          setHomeName(newHome.name);
          setHomeCount(1);
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
          // Use primary_home_id or first home
          const { data: customer } = await supabase
            .from('customers')
            .select('primary_home_id')
            .eq('id', customerData.id)
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
  }, [customerData, searchParams]);

  if (authLoading || !customerData || !user || loadingHome) return null;

  const dismissBanner = () => {
    localStorage.setItem('home_profile_banner_dismissed', 'true');
    setBannerDismissed(true);
  };

  return (
    <PortalLayout>
      <div className="space-y-8 max-w-4xl mx-auto">
        <div className="flex items-center gap-3">
          <Home className="w-7 h-7 text-primary" />
          <div>
            <h1 className="text-3xl font-medium">{t('Hemprofil', 'Home Profile')}</h1>
            {homeCount > 1 && homeName && (
              <p className="text-sm text-muted-foreground">{t('Fastighet', 'Property')}: {homeName}</p>
            )}
          </div>
        </div>

        {homeCount > 1 && (
          <p className="text-sm text-muted-foreground">
            {t('Svaren gäller bara denna fastighet.', 'Answers apply only to this property.')}
          </p>
        )}

        {!bannerDismissed && (
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

        <HomeProfileForm customerId={customerData.id} userId={user.id} homeId={homeId} />
      </div>
    </PortalLayout>
  );
};

export default HomeProfile;
