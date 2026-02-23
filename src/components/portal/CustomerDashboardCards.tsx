import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Building2, FileText, MessageSquare, ClipboardList, Home, Loader2, AlertCircle, Box } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useLanguage } from '@/contexts/LanguageContext';

interface CustomerDashboardCardsProps {
  basePath: string; // e.g. '/portal' for customer, '/portal/customers/:id' for staff
  customerName?: string;
  billingEmail?: string;
  statsLoading: boolean;
  homeProfileStats: { answered: number; total: number; photos: number };
  invoiceStats: { total: number; lastDate: string | null };
  ticketStats: { open: number; total: number };
  quoteStats: { total: number; actionRequired?: number };
}

const CustomerDashboardCards: React.FC<CustomerDashboardCardsProps> = ({
  basePath,
  customerName,
  billingEmail,
  statsLoading,
  homeProfileStats,
  invoiceStats,
  ticketStats,
  quoteStats,
}) => {
  const navigate = useNavigate();
  const { t } = useLanguage();

  const cards = [
    {
      title: t('Hemprofil', 'Home Profile'),
      icon: Home,
      path: `${basePath}/home-profile`,
      content: (
        <>
          <p className="text-muted-foreground mb-2">
            {t('Din bostads tekniska profil, enheter, nätverk och installationsdokumentation.', "Your home's technical profile, devices, networks and installation documentation.")}
          </p>
          <p className="text-muted-foreground text-sm">
            {t('Besvarade frågor:', 'Questions answered:')} <strong>{homeProfileStats.answered} / {homeProfileStats.total}</strong>
          </p>
          <p className="text-muted-foreground text-sm">
            {t('Uppladdade foton:', 'Photos uploaded:')} <strong>{homeProfileStats.photos}</strong>
          </p>
        </>
      ),
    },
    {
      title: t('Enhetskatalog', 'Device Catalog'),
      icon: Box,
      path: '/portal/device-catalog',
      content: (
        <>
          <p className="text-muted-foreground mb-2">
            {t('Bläddra i enhetskatalogen, hantera enhetsmodeller och prestandadata.', 'Browse the device catalog, manage device models and performance data.')}
          </p>
        </>
      ),
    },
    {
      title: t('Konto', 'Account'),
      icon: Building2,
      path: `${basePath}/account`,
      content: (
        <>
          <p className="text-muted-foreground mb-1">
            {t('Kund:', 'Customer:')} <strong>{customerName || '-'}</strong>
          </p>
          <p className="text-muted-foreground">
            {t('Kontakt:', 'Contact:')} {billingEmail || t('Ingen e-post', 'No email')}
          </p>
        </>
      ),
    },
    {
      title: t('Offerter', 'Offers'),
      icon: ClipboardList,
      path: `${basePath}/offers`,
      content: (
        <>
          <div className="flex items-center gap-2">
            <p className="text-muted-foreground">
              {t('Offerter:', 'Offers:')} <strong>{quoteStats.total} {t('totalt', 'total')}</strong>
            </p>
            {(quoteStats.actionRequired ?? 0) > 0 && (
              <AlertCircle className="h-5 w-5 text-amber-500" />
            )}
          </div>
          {(quoteStats.actionRequired ?? 0) > 0 && (
            <p className="text-muted-foreground text-sm">
              {t('att hantera:', 'to handle:')} <strong>{quoteStats.actionRequired}</strong>
            </p>
          )}
          <p className="text-muted-foreground text-sm">
            {t('Se och ladda ner offerter', 'View and download offers')}
          </p>
        </>
      ),
    },
    {
      title: t('Fakturor', 'Invoices'),
      icon: FileText,
      path: `${basePath}/billing`,
      content: (
        <>
          <p className="text-muted-foreground mb-1">
            {t('Fakturor:', 'Invoices:')} <strong>{invoiceStats.total} {t('totalt', 'total')}</strong>
          </p>
          <p className="text-muted-foreground text-sm">
            {invoiceStats.lastDate
              ? `${t('Senaste:', 'Latest:')} ${new Date(invoiceStats.lastDate).toLocaleDateString()}`
              : t('Inga fakturor', 'No invoices')
            }
          </p>
        </>
      ),
    },
    {
      title: t('Supportärenden', 'Support Tickets'),
      icon: MessageSquare,
      path: `${basePath}/tickets`,
      content: (
        <>
          <p className="text-muted-foreground mb-1">
            {t('Öppna ärenden:', 'Open tickets:')} <strong>{ticketStats.open}</strong>
          </p>
          <p className="text-muted-foreground">
            {t('Totalt ärenden:', 'Total tickets:')} {ticketStats.total}
          </p>
        </>
      ),
    },
  ];

  return (
    <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
      {cards.map((card) => (
        <Card
          key={card.path}
          className="cursor-pointer transition-colors hover:bg-muted/50"
          onClick={() => navigate(card.path)}
        >
          <CardHeader className="flex flex-row items-center gap-4">
            <div className="p-2 rounded-lg bg-primary/10">
              <card.icon className="w-6 h-6 text-primary" />
            </div>
            <CardTitle className="text-lg">{card.title}</CardTitle>
          </CardHeader>
          <CardContent>
            {statsLoading ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              card.content
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
};

export default CustomerDashboardCards;
