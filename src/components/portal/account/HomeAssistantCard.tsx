import React, { useCallback, useEffect, useState } from 'react';
import { HousePlug, Loader2, Plus, Unplug } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { useLanguage } from '@/contexts/LanguageContext';
import { supabase } from '@/integrations/supabase/client';

interface DeviceToken {
  id: string;
  device_name: string;
  created_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
}

interface HomeAssistantCardProps {
  customerId: string;
}

/**
 * Link a Home Assistant instance: generate a single-use pairing code for the
 * SHS integration's config flow, and list/revoke connected instances. The
 * plaintext code is shown once here and never stored server-side.
 */
const HomeAssistantCard: React.FC<HomeAssistantCardProps> = ({ customerId }) => {
  const { t } = useLanguage();
  const { toast } = useToast();
  const [tokens, setTokens] = useState<DeviceToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [codeExpiresAt, setCodeExpiresAt] = useState<Date | null>(null);

  const loadTokens = useCallback(async () => {
    const { data, error } = await supabase
      .from('ha_device_tokens')
      .select('id, device_name, created_at, last_seen_at, revoked_at')
      .eq('customer_id', customerId)
      .is('revoked_at', null)
      .order('created_at', { ascending: false });
    if (!error) setTokens(data ?? []);
    setLoading(false);
  }, [customerId]);

  useEffect(() => {
    loadTokens();
  }, [loadTokens]);

  // Hide the code (and refresh the token list — pairing may have completed)
  // once it expires.
  useEffect(() => {
    if (!codeExpiresAt) return;
    const timeout = setTimeout(() => {
      setPairingCode(null);
      setCodeExpiresAt(null);
      loadTokens();
    }, Math.max(0, codeExpiresAt.getTime() - Date.now()));
    return () => clearTimeout(timeout);
  }, [codeExpiresAt, loadTokens]);

  const generateCode = async () => {
    setGenerating(true);
    try {
      const { data, error } = await supabase.functions.invoke('create-pairing-code', {
        body: {},
      });
      if (error || !data?.code) {
        const detail = data?.error === 'subscription_inactive'
          ? t('Kräver aktiv prenumeration.', 'Requires an active subscription.')
          : t('Försök igen senare.', 'Please try again later.');
        toast({
          title: t('Kunde inte skapa parningskod', 'Could not create pairing code'),
          description: detail,
          variant: 'destructive',
        });
        return;
      }
      setPairingCode(data.code);
      setCodeExpiresAt(new Date(data.expires_at));
    } finally {
      setGenerating(false);
    }
  };

  const revoke = async (tokenId: string) => {
    setRevokingId(tokenId);
    try {
      const { data, error } = await supabase.rpc('revoke_ha_device_token', {
        p_token_id: tokenId,
      });
      if (error || !data) {
        toast({
          title: t('Kunde inte koppla från', 'Could not disconnect'),
          variant: 'destructive',
        });
        return;
      }
      toast({
        title: t('Frånkopplad', 'Disconnected'),
        description: t(
          'Home Assistant-instansen kan inte längre skicka data.',
          'The Home Assistant instance can no longer push data.'
        ),
      });
      await loadTokens();
    } finally {
      setRevokingId(null);
    }
  };

  const formatDate = (iso: string | null) =>
    iso ? new Date(iso).toLocaleString() : t('Aldrig', 'Never');

  return (
    <Card className="max-w-2xl" data-testid="home-assistant-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <HousePlug className="w-5 h-5" />
          {t('Home Assistant', 'Home Assistant')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          {t(
            'Koppla din Home Assistant för att automatiskt skicka daglig energianvändning per kategori till din energihistorik.',
            'Connect your Home Assistant to automatically push daily energy use per category into your energy history.'
          )}
        </p>

        {pairingCode ? (
          <div
            className="rounded-md border border-border bg-muted p-4 text-center"
            data-testid="pairing-code-display"
          >
            <div className="font-mono text-2xl tracking-[0.3em]">{pairingCode}</div>
            <p className="mt-2 text-xs text-muted-foreground">
              {t(
                'Ange koden i SHS-integrationen i Home Assistant. Giltig i 10 minuter och kan bara användas en gång.',
                'Enter this code in the SHS integration in Home Assistant. Valid for 10 minutes, single-use.'
              )}
            </p>
          </div>
        ) : (
          <Button
            variant="outline"
            onClick={generateCode}
            disabled={generating}
            data-testid="generate-pairing-code"
          >
            {generating ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : (
              <Plus className="w-4 h-4 mr-2" />
            )}
            {t('Skapa parningskod', 'Generate pairing code')}
          </Button>
        )}

        {loading ? (
          <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
        ) : tokens.length > 0 ? (
          <div className="space-y-2">
            {tokens.map((token) => (
              <div
                key={token.id}
                className="flex items-center justify-between rounded-md border border-border p-3"
              >
                <div>
                  <div className="text-sm font-medium">{token.device_name}</div>
                  <div className="text-xs text-muted-foreground">
                    {t('Ansluten', 'Connected')}: {formatDate(token.created_at)}
                    {' · '}
                    {t('Senast sedd', 'Last seen')}: {formatDate(token.last_seen_at)}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => revoke(token.id)}
                  disabled={revokingId === token.id}
                  data-testid={`revoke-token-${token.id}`}
                >
                  {revokingId === token.id ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Unplug className="w-4 h-4" />
                  )}
                  <span className="ml-1">{t('Koppla från', 'Disconnect')}</span>
                </Button>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            {t('Ingen Home Assistant är ansluten ännu.', 'No Home Assistant connected yet.')}
          </p>
        )}
      </CardContent>
    </Card>
  );
};

export default HomeAssistantCard;
