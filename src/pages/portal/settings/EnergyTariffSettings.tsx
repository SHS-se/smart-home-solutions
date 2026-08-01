import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Calculator, FileJson, Loader2, Save, Upload } from 'lucide-react';
import { useLanguage } from '@/contexts/LanguageContext';
import { useToast } from '@/hooks/use-toast';
import {
  fetchEnergyTariffProfiles,
  fetchEnergyTariffSettings,
  fetchEnergyTariffVersions,
  publishEnergyTariffVersion,
  saveEnergyTariffSettings,
  type TariffGridArea,
} from '@/lib/energy-tariff-storage';
import type { Json } from '@/integrations/supabase/types';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';

const QUERY_KEY = ['central-energy-tariffs'] as const;

const GRID_AREAS: Array<{ value: TariffGridArea; sv: string; en: string }> = [
  { value: 'stockholm', sv: 'Stockholm', en: 'Stockholm' },
  { value: 'dalarna_sodra_norrland_edsbyn', sv: 'Dalarna, södra Norrland och Edsbyn', en: 'Dalarna, southern Norrland and Edsbyn' },
  { value: 'vastkusten', sv: 'Västkusten', en: 'West coast' },
  { value: 'vastra_svealand_vastergotland', sv: 'Västra Svealand och Västergötland', en: 'Western Svealand and Västergötland' },
];

function isJsonObject(value: unknown): value is Record<string, Json | undefined> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const EnergyTariffSettings: React.FC = () => {
  const { t, language } = useLanguage();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const query = useQuery({
    queryKey: QUERY_KEY,
    queryFn: async () => {
      const [profiles, versions, settings] = await Promise.all([
        fetchEnergyTariffProfiles(),
        fetchEnergyTariffVersions(),
        fetchEnergyTariffSettings(),
      ]);
      return { profiles, versions, settings };
    },
  });
  const [profileId, setProfileId] = useState('');
  const [gridArea, setGridArea] = useState<TariffGridArea>('stockholm');
  const [includeVat, setIncludeVat] = useState(true);
  const [energyTaxReduced, setEnergyTaxReduced] = useState(false);
  const [exportVatRegistered, setExportVatRegistered] = useState(false);
  const [revision, setRevision] = useState('');
  const [validFrom, setValidFrom] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [definitionText, setDefinitionText] = useState('');
  const [savingSettings, setSavingSettings] = useState(false);
  const [publishing, setPublishing] = useState(false);

  const versions = useMemo(
    () => (query.data?.versions ?? []).filter((version) => !profileId || version.profile_id === profileId),
    [profileId, query.data?.versions],
  );
  const latestVersion = versions.at(0) ?? null;

  useEffect(() => {
    if (!query.data) return;
    setProfileId(query.data.settings.profile_id);
    setGridArea(query.data.settings.grid_area as TariffGridArea);
    setIncludeVat(query.data.settings.include_vat);
    setEnergyTaxReduced(query.data.settings.energy_tax_reduced);
    setExportVatRegistered(query.data.settings.export_vat_registered);
  }, [query.data]);

  const loadLatestDefinition = () => {
    if (!latestVersion) return;
    setDefinitionText(JSON.stringify(latestVersion.definition, null, 2));
    setSourceUrl(latestVersion.source_url);
  };

  const handleFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const parsed: unknown = JSON.parse(await file.text());
      if (!isJsonObject(parsed)) throw new Error(t('Filen måste innehålla ett JSON-objekt.', 'The file must contain a JSON object.'));
      setDefinitionText(JSON.stringify(parsed, null, 2));
    } catch (error) {
      toast({ title: t('Ogiltig tariffil', 'Invalid tariff file'), description: error instanceof Error ? error.message : String(error), variant: 'destructive' });
    }
  };

  const saveSettings = async () => {
    setSavingSettings(true);
    try {
      await saveEnergyTariffSettings({
        profileId,
        gridArea,
        energyTaxReduced,
        includeVat,
        exportVatRegistered,
      });
      await queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      toast({ title: t('Globala tariffinställningar sparade', 'Global tariff settings saved') });
    } catch (error) {
      toast({ title: t('Kunde inte spara', 'Could not save'), description: error instanceof Error ? error.message : String(error), variant: 'destructive' });
    } finally {
      setSavingSettings(false);
    }
  };

  const publish = async () => {
    setPublishing(true);
    try {
      const definition: unknown = JSON.parse(definitionText);
      if (!isJsonObject(definition)) throw new Error(t('Definitionen måste vara ett JSON-objekt.', 'The definition must be a JSON object.'));
      await publishEnergyTariffVersion({
        profileId,
        revision,
        validFrom,
        calculationModel: 'se_grid_v1',
        definition: definition as Json,
        sourceUrl,
      });
      setRevision('');
      setValidFrom('');
      setDefinitionText('');
      setSourceUrl('');
      await queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      toast({ title: t('Tariffversion publicerad', 'Tariff version published') });
    } catch (error) {
      toast({ title: t('Kunde inte publicera', 'Could not publish'), description: error instanceof Error ? error.message : String(error), variant: 'destructive' });
    } finally {
      setPublishing(false);
    }
  };

  if (query.isLoading) return <div className="flex min-h-80 items-center justify-center"><Loader2 className="h-7 w-7 animate-spin text-primary" /></div>;
  if (query.error) return <Alert variant="destructive"><AlertTitle>{t('Tariffer kunde inte läsas', 'Tariffs could not be loaded')}</AlertTitle><AlertDescription>{String(query.error)}</AlertDescription></Alert>;

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-3">
        <div className="rounded-lg bg-primary/10 p-2 text-primary"><Calculator className="h-6 w-6" /></div>
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-3xl font-medium">{t('Ellevio-tariffer', 'Ellevio tariffs')}</h1>
            <Badge variant="secondary">{t('Endast personal', 'Staff only')}</Badge>
          </div>
          <p className="mt-1 max-w-4xl text-sm text-muted-foreground">
            {t(
              'En central, datumstyrd tariffkatalog gäller för alla kunder. Huvudsäkring och solceller hämtas automatiskt från kundens hemprofil.',
              'One central, effective-dated tariff catalogue applies to every customer. Main fuse and solar panels are read automatically from the customer’s home profile.',
            )}
          </p>
        </div>
      </div>

      <Card>
        <CardHeader><CardTitle>{t('Gemensamt avtal', 'Shared contract')}</CardTitle></CardHeader>
        <CardContent className="space-y-5">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label>{t('Tariffprofil', 'Tariff profile')}</Label>
              <Select value={profileId} onValueChange={setProfileId}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{query.data?.profiles.map((profile) => <SelectItem key={profile.id} value={profile.id}>{profile.provider_name} – {profile.display_name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>{t('Ellevios nätområde', 'Ellevio grid area')}</Label>
              <Select value={gridArea} onValueChange={(value) => setGridArea(value as TariffGridArea)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{GRID_AREAS.map((area) => <SelectItem key={area.value} value={area.value}>{language === 'sv' ? area.sv : area.en}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid gap-4 border-t pt-4 md:grid-cols-3">
            <Label className="flex flex-col gap-2 rounded-lg border p-3">
              <span className="flex items-center justify-between gap-3">
                <span>{t('Debitera moms', 'Charge VAT')}</span>
                <Switch checked={includeVat} onCheckedChange={setIncludeVat} />
              </span>
              <span className="text-xs font-normal text-muted-foreground">{t('Katalogens priser är alltid exkl. moms. På betyder att 25 % moms läggs på summan, precis som på fakturan.', 'Catalogue rates are always ex-VAT. On adds 25% VAT to the total, exactly as the invoice does.')}</span>
            </Label>
            <Label className="flex flex-col gap-2 rounded-lg border p-3">
              <span className="flex items-center justify-between gap-3">
                <span>{t('Reducerad energiskatt', 'Reduced energy tax')}</span>
                <Switch checked={energyTaxReduced} onCheckedChange={setEnergyTaxReduced} />
              </span>
              <span className="text-xs font-normal text-muted-foreground">{t('För kommuner med nedsatt energiskatt.', 'For municipalities with a reduced energy-tax rate.')}</span>
            </Label>
            <Label className="flex flex-col gap-2 rounded-lg border p-3">
              <span className="flex items-center justify-between gap-3">
                <span>{t('Momsregistrerad mikroproducent', 'VAT-registered microgenerator')}</span>
                <Switch checked={exportVatRegistered} onCheckedChange={setExportVatRegistered} />
              </span>
              <span className="text-xs font-normal text-muted-foreground">{t('Av betyder att produktionsersättningen är ej momsgrundande.', 'Off means the production credit is not VAT-able.')}</span>
            </Label>
          </div>
          <div className="flex items-center justify-between gap-4">
            <p className="text-sm text-muted-foreground">{t('Anslutning är alltid trefas. Kundens säkringsstorlek väljer prisnivån.', 'Connection is always three-phase. The customer’s fuse size selects the rate.')}</p>
            <Button onClick={saveSettings} disabled={savingSettings || !profileId}>{savingSettings ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}{t('Spara', 'Save')}</Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>{t('Publicera ny tariffversion', 'Publish a new tariff version')}</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <Alert><FileJson className="h-4 w-4" /><AlertDescription>{t('Börja från den senaste definitionen eller importera JSON. En publicerad version är oföränderlig; giltighetsdatumen kopplas automatiskt utan överlapp. En helt ny beräkningsformel måste först få en ny, testad beräkningsmodell i integrationen.', 'Start from the latest definition or import JSON. A published version is immutable; effective dates are connected automatically without overlaps. A genuinely new formula must first receive a new, tested calculation model in the integration.')}</AlertDescription></Alert>
          <div className="grid gap-4 md:grid-cols-3">
            <div className="space-y-2"><Label htmlFor="tariff-revision">{t('Revisionsnyckel', 'Revision key')}</Label><Input id="tariff-revision" value={revision} onChange={(event) => setRevision(event.target.value)} placeholder="ellevio-2027-01-01" /></div>
            <div className="space-y-2"><Label htmlFor="tariff-valid-from">{t('Gäller från', 'Effective from')}</Label><Input id="tariff-valid-from" type="date" value={validFrom} onChange={(event) => setValidFrom(event.target.value)} /></div>
            <div className="space-y-2"><Label htmlFor="tariff-source">{t('Käll-URL', 'Source URL')}</Label><Input id="tariff-source" type="url" value={sourceUrl} onChange={(event) => setSourceUrl(event.target.value)} placeholder="https://www.ellevio.se/..." /></div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" onClick={loadLatestDefinition} disabled={!latestVersion}><FileJson className="mr-2 h-4 w-4" />{t('Kopiera senaste', 'Copy latest')}</Button>
            <Button type="button" variant="outline" onClick={() => fileInputRef.current?.click()}><Upload className="mr-2 h-4 w-4" />{t('Importera JSON', 'Import JSON')}</Button>
            <input ref={fileInputRef} className="hidden" type="file" accept="application/json,.json" onChange={handleFile} />
          </div>
          <div className="space-y-2"><Label htmlFor="tariff-definition">{t('Maskinläsbar definition', 'Machine-readable definition')}</Label><Textarea id="tariff-definition" className="min-h-[28rem] font-mono text-xs" value={definitionText} onChange={(event) => setDefinitionText(event.target.value)} spellCheck={false} /></div>
          <div className="flex justify-end"><Button onClick={publish} disabled={publishing || !profileId || !revision || !validFrom || !sourceUrl || !definitionText}>{publishing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}{t('Publicera version', 'Publish version')}</Button></div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>{t('Publicerad historik', 'Published history')}</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {versions.map((version) => (
            <div key={version.id} className="flex flex-col gap-1 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between">
              <div><p className="font-mono text-sm font-medium">{version.revision}</p><p className="text-xs text-muted-foreground">{version.calculation_model}</p></div>
              <div className="text-sm text-muted-foreground"><span>{version.valid_from} – {version.valid_to ?? t('pågående', 'ongoing')}</span>{' · '}<a className="text-primary hover:underline" href={version.source_url} target="_blank" rel="noreferrer">{t('källa', 'source')}</a></div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
};

export default EnergyTariffSettings;
