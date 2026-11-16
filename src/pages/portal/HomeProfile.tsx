import React, { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Home, Info, Loader2 } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import HomeProfileForm from '@/components/portal/home-profile/HomeProfileForm';
import RoomConnections from '@/components/portal/home-profile/RoomConnections';
import { useQuery } from '@tanstack/react-query';
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
  const { user, customerData, isStaff, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const { t } = useLanguage();
  const [searchParams, setSearchParams] = useSearchParams();
  const [bannerDismissed, setBannerDismissed] = useState(() => localStorage.getItem('home_profile_banner_dismissed') === 'true');
  const [homeId, setHomeId] = useState<string | null>(null);
  const [homeName, setHomeName] = useState<string | null>(null);
  const [homeCount, setHomeCount] = useState(0);
  const [loadingHome, setLoadingHome] = useState(true);

  const linkedHomeId = searchParams.get('home');
  const connectionsLinked = searchParams.get('section') === 'room-connections';
  const resolveLinkedHome = connectionsLinked && !!linkedHomeId;
  const { data: linkedHome, isPending: loadingLinkedHome } = useQuery({
    queryKey: ['room-profile-home-link', linkedHomeId],
    enabled: resolveLinkedHome && !!user,
    retry: false,
    queryFn: async () => {
      const { data, error } = await supabase.from('homes')
        .select('id, customer_id').eq('id', linkedHomeId ?? '').maybeSingle();
      if (error) throw error;
      return data;
    },
  });
  const allowedLinkedHome = linkedHome && (!propCustomerId || propCustomerId === linkedHome.customer_id);
  const resolvedCustomerId = resolveLinkedHome
    ? allowedLinkedHome ? linkedHome.customer_id : undefined
    : propCustomerId || customerData?.id;
  const selectedHomeId = resolveLinkedHome ? (allowedLinkedHome ? linkedHome.id : null) : homeId;
  const staffContext = isStaffView || Boolean(isStaff && connectionsLinked);
  const userId = user?.id;

  useEffect(() => {
    if (!authLoading && !user) navigate('/login');
    if (!staffContext && !authLoading && !customerData) navigate('/portal');
  }, [user, authLoading, customerData, navigate, staffContext]);

  useEffect(() => {
    if (!resolvedCustomerId || resolveLinkedHome) return;
    const resolveHome = async () => {
      setLoadingHome(true);
      const queryHomeId = searchParams.get('home');

      const { data: homes } = await supabase
        .from('homes')
        .select('id, name')
        .eq('customer_id', resolvedCustomerId)
        .order('created_at');

      if (!homes || homes.length === 0) {
        const { data: newHome, error: createHomeError } = await supabase
          .from('homes')
          .insert({ customer_id: resolvedCustomerId, name: 'My home' })
          .select('id, name')
          .single();

        if (createHomeError) {
          console.error('Failed to auto-create home:', createHomeError);
        } else if (newHome) {
          await supabase.from('customers').update({ primary_home_id: newHome.id }).eq('id', resolvedCustomerId);
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
          const { data: customer } = await supabase
            .from('customers')
            .select('primary_home_id')
            .eq('id', resolvedCustomerId)
            .single();
          const primaryId = customer?.primary_home_id;
          const match = primaryId ? homes.find(h => h.id === primaryId) : null;
          setHomeId(match?.id || homes[0].id);
          setHomeName(match?.name || homes[0].name);
        }
      }
      setLoadingHome(false);
    };
    resolveHome();
  }, [resolvedCustomerId, searchParams, resolveLinkedHome]);

  if (resolveLinkedHome && userId && !loadingLinkedHome && !allowedLinkedHome) {
    return <Alert><AlertDescription>{t('Hemmet kunde inte öppnas.', 'The linked home could not be opened.')}</AlertDescription></Alert>;
  }
  if (authLoading || (!staffContext && user && !resolvedCustomerId) || !userId || (resolveLinkedHome ? loadingLinkedHome : loadingHome)) {
    return (
      <>
        <div className="flex items-center justify-center min-h-[400px]">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
      </>
    );
  }

  const dismissBanner = () => {
    localStorage.setItem('home_profile_banner_dismissed', 'true');
    setBannerDismissed(true);
  };

  return (
    <>
      <div className="space-y-8 max-w-4xl mx-auto">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Home className="w-7 h-7 text-primary" />
            <div>
              <h1 className="text-3xl font-medium">{t('Hemprofil', 'Home Profile')}</h1>
            </div>
          </div>
          <HomeSelector
            customerId={resolvedCustomerId}
            selectedHomeId={selectedHomeId}
            onHomeChange={(newId) => {
              setHomeId(newId);
              setSearchParams(connectionsLinked ? { home: newId, section: 'room-connections' } : { home: newId });
            }}
            onHomeCountChange={setHomeCount}
          />
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

        {selectedHomeId && (
          <RoomConnections key={selectedHomeId} homeId={selectedHomeId}
            linkedRoom={searchParams.get('room')} linked={connectionsLinked} />
        )}
        <HomeProfileForm customerId={resolvedCustomerId} userId={userId} isStaffView={staffContext} homeId={selectedHomeId} />
      </div>
    </>
  );
};

export default HomeProfile;
