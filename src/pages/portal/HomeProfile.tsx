import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Home, Info } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import PortalLayout from '@/components/portal/PortalLayout';
import HomeProfileForm from '@/components/portal/home-profile/HomeProfileForm';
import { useAuth } from '@/contexts/AuthContext';
import { useLanguage } from '@/contexts/LanguageContext';

const HomeProfile: React.FC = () => {
  const { user, customerData, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const { t } = useLanguage();
  const [bannerDismissed, setBannerDismissed] = useState(() => localStorage.getItem('home_profile_banner_dismissed') === 'true');

  useEffect(() => {
    if (!authLoading && !user) navigate('/login');
    if (!authLoading && !customerData) navigate('/portal');
  }, [user, authLoading, customerData, navigate]);

  if (authLoading || !customerData || !user) return null;

  const dismissBanner = () => {
    localStorage.setItem('home_profile_banner_dismissed', 'true');
    setBannerDismissed(true);
  };

  return (
    <PortalLayout>
      <div className="space-y-8 max-w-4xl mx-auto">
        <div className="flex items-center gap-3">
          <Home className="w-7 h-7 text-primary" />
          <h1 className="text-3xl font-medium">{t('Hemprofil', 'Home Profile')}</h1>
        </div>

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

        <HomeProfileForm customerId={customerData.id} userId={user.id} />
      </div>
    </PortalLayout>
  );
};

export default HomeProfile;
