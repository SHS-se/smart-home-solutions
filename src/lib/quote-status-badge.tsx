import React from 'react';
import { Badge } from '@/components/ui/badge';

export const getQuoteStatusBadge = (status: string, t: (sv: string, en: string) => string) => {
  switch (status) {
    case 'draft':
      return <Badge variant="secondary">{t('Utkast', 'Draft')}</Badge>;
    case 'sent':
      return <Badge variant="default">{t('Skickad', 'Sent')}</Badge>;
    case 'viewed':
      return <Badge className="bg-blue-500/20 text-blue-700 border-0">{t('Visad', 'Viewed')}</Badge>;
    case 'accepted':
      return <Badge className="bg-green-500/20 text-green-700 border-0">{t('Accepterad', 'Accepted')}</Badge>;
    case 'declined':
      return <Badge variant="destructive">{t('Avvisad', 'Declined')}</Badge>;
    case 'revision_requested':
      return <Badge className="bg-amber-500/20 text-amber-700 border-0">{t('Ändring begärd', 'Revision requested')}</Badge>;
    case 'invoiced':
      return <Badge className="bg-primary/20 text-primary border-0">{t('Fakturerad', 'Invoiced')}</Badge>;
    case 'expired':
      return <Badge variant="secondary">{t('Utgången', 'Expired')}</Badge>;
    case 'cancelled':
      return <Badge variant="outline" className="text-muted-foreground">{t('Avbruten', 'Cancelled')}</Badge>;
    default:
      return <Badge variant="secondary">{status}</Badge>;
  }
};
