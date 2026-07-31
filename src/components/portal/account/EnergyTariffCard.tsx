import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Calculator, Loader2, Save } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { useLanguage } from '@/contexts/LanguageContext';
import {
  fetchCustomerEnergyTariffAssignments,
  fetchEnergyTariffProfiles,
  fetchEnergyTariffVersions,
  setCustomerEnergyTariffAssignment,
  type EnergyTariffAssignment,
  type EnergyTariffConfiguration,
  type EnergyTariffProfile,
  type EnergyTariffVersion,
  type TariffApartmentBand,
  type TariffConnectionType,
  type TariffGridArea,
} from '@/lib/energy-tariff-storage';

interface EnergyTariffCardProps {
  customerId: string;
}

const THREE_PHASE_FUSES = [16, 20, 25, 35, 50, 63] as const;
const SINGLE_PHASE_FUSES = [20, 25, 35] as const;

const DEFAULT_CONFIGURATION: EnergyTariffConfiguration = {
  connection_type: 'three_phase',
  fuse_a: 20,
  grid_area: 'stockholm',
  production_enabled: false,
  energy_tax_reduced: false,
  include_vat: true,
  export_vat_registered: false,
};

function localIsoMonthStart(): string {
  const date = new Date();
  const offset = date.getTimezoneOffset() * 60_000;
  return `${new Date(date.getTime() - offset).toISOString().slice(0, 7)}-01`;
}

function assignmentConfiguration(assignment: EnergyTariffAssignment): EnergyTariffConfiguration {
  return assignment.configuration as unknown as EnergyTariffConfiguration;
}

const EnergyTariffCard: React.FC<EnergyTariffCardProps> = ({ customerId }) => {
  const { t } = useLanguage();
  const { toast } = useToast();
  const [profiles, setProfiles] = useState<EnergyTariffProfile[]>([]);
  const [assignments, setAssignments] = useState<EnergyTariffAssignment[]>([]);
  const [versions, setVersions] = useState<EnergyTariffVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [profileId, setProfileId] = useState('');
  const [validFrom, setValidFrom] = useState(localIsoMonthStart);
  const [configuration, setConfiguration] = useState<EnergyTariffConfiguration>(
    DEFAULT_CONFIGURATION,
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [nextProfiles, nextVersions, nextAssignments] = await Promise.all([
        fetchEnergyTariffProfiles(),
        fetchEnergyTariffVersions(),
        fetchCustomerEnergyTariffAssignments(customerId),
      ]);
      setProfiles(nextProfiles);
      setVersions(nextVersions);
      setAssignments(nextAssignments);
      const latest = nextAssignments.at(0);
      if (latest) {
        setProfileId(latest.profile_id);
        setValidFrom(localIsoMonthStart());
        setConfiguration(assignmentConfiguration(latest));
      } else if (nextProfiles.at(0)) {
        setProfileId(nextProfiles[0].id);
      }
    } catch (error) {
      toast({
        title: t('Nättariffen kunde inte läsas', 'Grid tariff could not be loaded'),
        description: error instanceof Error ? error.message : String(error),
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  }, [customerId, t, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const fuseOptions = configuration.connection_type === 'single_phase'
    ? SINGLE_PHASE_FUSES
    : THREE_PHASE_FUSES;
  const profileNames = useMemo(
    () => new Map(profiles.map((profile) => [profile.id, profile.display_name])),
    [profiles],
  );

  const updateConfiguration = <K extends keyof EnergyTariffConfiguration>(
    key: K,
    value: EnergyTariffConfiguration[K],
  ) => setConfiguration((current) => ({ ...current, [key]: value }));

  const setConnectionType = (connectionType: TariffConnectionType) => {
    setConfiguration((current) => {
      if (connectionType === 'apartment') {
        const { fuse_a: _fuse, ...withoutFuse } = current;
        return {
          ...withoutFuse,
          connection_type: connectionType,
          apartment_band: 'up_to_29',
        };
      }
      const { apartment_band: _band, ...withoutBand } = current;
      return {
        ...withoutBand,
        connection_type: connectionType,
        fuse_a: 20,
      };
    });
  };

  const save = async () => {
    if (!profileId || !validFrom) return;
    setSaving(true);
    try {
      await setCustomerEnergyTariffAssignment({
        customerId,
        profileId,
        validFrom,
        configuration: {
          ...configuration,
          export_vat_registered: configuration.production_enabled
            && configuration.export_vat_registered,
        },
      });
      toast({
        title: t('Nättariffen har sparats', 'Grid tariff saved'),
        description: t(
          'Den skickas automatiskt till kundens anslutna Home Assistant.',
          "It will be delivered automatically to the customer's connected Home Assistant.",
        ),
      });
      await load();
    } catch (error) {
      toast({
        title: t('Nättariffen kunde inte sparas', 'Grid tariff could not be saved'),
        description: error instanceof Error ? error.message : String(error),
        variant: 'destructive',
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card data-testid="staff-energy-tariff-card">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <Calculator className="h-5 w-5" />
          {t('Nättariff för Home Assistant', 'Grid tariff for Home Assistant')}
          <Badge variant="secondary">{t('Endast personal', 'Staff only')}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <p className="text-sm text-muted-foreground">
          {t(
            'Tilldela kundens Ellevio-avtal här. Publicering, prisversioner och överföring till integrationen hanteras utan kundens medverkan.',
            "Assign the customer's Ellevio agreement here. Publishing, rate versions, and delivery to the integration require no customer action.",
          )}
        </p>

        {loading ? (
          <div className="flex min-h-32 items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
          </div>
        ) : profiles.length === 0 ? (
          <p className="text-sm text-destructive">
            {t('Ingen publicerad nättariff hittades.', 'No published grid tariff was found.')}
          </p>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <div className="space-y-2 sm:col-span-2">
                <Label>{t('Publicerad tariff', 'Published tariff')}</Label>
                <Select value={profileId} onValueChange={setProfileId}>
                  <SelectTrigger data-testid="energy-tariff-profile">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {profiles.map((profile) => (
                      <SelectItem key={profile.id} value={profile.id}>
                        {profile.provider_name} – {profile.display_name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="energy-tariff-valid-from">
                  {t('Gäller från', 'Effective from')}
                </Label>
                <Input
                  id="energy-tariff-valid-from"
                  type="date"
                  value={validFrom}
                  onChange={(event) => setValidFrom(event.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label>{t('Anslutning', 'Connection')}</Label>
                <Select
                  value={configuration.connection_type}
                  onValueChange={(value) => setConnectionType(value as TariffConnectionType)}
                >
                  <SelectTrigger data-testid="energy-tariff-connection">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="three_phase">{t('Trefas', 'Three phase')}</SelectItem>
                    <SelectItem value="single_phase">{t('Enfas', 'Single phase')}</SelectItem>
                    <SelectItem value="apartment">{t('Lägenhet', 'Apartment')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {configuration.connection_type === 'apartment' ? (
                <div className="space-y-2">
                  <Label>{t('Årsförbrukningsintervall', 'Annual usage band')}</Label>
                  <Select
                    value={configuration.apartment_band ?? 'up_to_29'}
                    onValueChange={(value) => updateConfiguration(
                      'apartment_band',
                      value as TariffApartmentBand,
                    )}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="up_to_29">≤ 2 999 kWh</SelectItem>
                      <SelectItem value="30_59">3 000–5 999 kWh</SelectItem>
                      <SelectItem value="60_99">6 000–9 999 kWh</SelectItem>
                      <SelectItem value="100_plus">≥ 10 000 kWh</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              ) : (
                <div className="space-y-2">
                  <Label>{t('Huvudsäkring', 'Main fuse')}</Label>
                  <Select
                    value={String(configuration.fuse_a ?? 20)}
                    onValueChange={(value) => updateConfiguration(
                      'fuse_a',
                      Number(value) as EnergyTariffConfiguration['fuse_a'],
                    )}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {fuseOptions.map((fuse) => (
                        <SelectItem key={fuse} value={String(fuse)}>{fuse} A</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              <div className="space-y-2">
                <Label>{t('Ellevio nätområde', 'Ellevio grid area')}</Label>
                <Select
                  value={configuration.grid_area}
                  onValueChange={(value) => updateConfiguration('grid_area', value as TariffGridArea)}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="stockholm">Stockholm</SelectItem>
                    <SelectItem value="vastkusten">Västkusten</SelectItem>
                    <SelectItem value="dalarna_sodra_norrland_edsbyn">
                      Dalarna / Södra Norrland / Edsbyn
                    </SelectItem>
                    <SelectItem value="vastra_svealand_vastergotland">
                      Västra Svealand / Västergötland
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid gap-3 border-y border-border py-4 sm:grid-cols-2">
              <ToggleRow
                id="energy-tariff-production"
                label={t('Mikroproduktion', 'Microgeneration')}
                checked={configuration.production_enabled}
                onCheckedChange={(checked) => updateConfiguration('production_enabled', checked)}
              />
              <ToggleRow
                id="energy-tariff-tax-reduction"
                label={t('Reducerad energiskatt', 'Reduced energy tax')}
                checked={configuration.energy_tax_reduced}
                onCheckedChange={(checked) => updateConfiguration('energy_tax_reduced', checked)}
              />
              <ToggleRow
                id="energy-tariff-vat"
                label={t('Visa priser inklusive moms', 'Calculate prices including VAT')}
                checked={configuration.include_vat}
                onCheckedChange={(checked) => updateConfiguration('include_vat', checked)}
              />
              <ToggleRow
                id="energy-tariff-export-vat"
                label={t('Momsregistrerad mikroproducent', 'VAT-registered microgenerator')}
                checked={configuration.export_vat_registered}
                disabled={!configuration.production_enabled}
                onCheckedChange={(checked) => updateConfiguration('export_vat_registered', checked)}
              />
            </div>

            <div className="flex justify-end">
              <Button onClick={save} disabled={saving || !profileId || !validFrom}>
                {saving ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Save className="mr-2 h-4 w-4" />
                )}
                {t('Tilldela tariff', 'Assign tariff')}
              </Button>
            </div>

            <div className="space-y-2">
              <h3 className="text-sm font-medium">
                {t('Publicerade prisversioner', 'Published rate versions')}
              </h3>
              {versions
                .filter((version) => version.profile_id === profileId)
                .map((version) => (
                  <div
                    key={version.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-sm"
                  >
                    <span className="font-mono text-xs">{version.revision}</span>
                    <span className="text-muted-foreground">
                      {version.valid_from} – {version.valid_to ?? t('tills vidare', 'ongoing')}
                      {' · '}
                      <a
                        href={version.source_url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-primary underline-offset-4 hover:underline"
                      >
                        {t('källa', 'source')}
                      </a>
                    </span>
                  </div>
                ))}
            </div>

            {assignments.length > 0 && (
              <div className="space-y-2">
                <h3 className="text-sm font-medium">{t('Tariffhistorik', 'Tariff history')}</h3>
                {assignments.map((assignment) => {
                  const config = assignmentConfiguration(assignment);
                  return (
                    <div
                      key={assignment.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-sm"
                    >
                      <span>
                        {profileNames.get(assignment.profile_id) ?? assignment.profile_id}
                        {' · '}
                        {config.connection_type === 'apartment'
                          ? t('Lägenhet', 'Apartment')
                          : `${config.fuse_a} A`}
                      </span>
                      <span className="text-muted-foreground">
                        {assignment.valid_from} – {assignment.valid_to ?? t('tills vidare', 'ongoing')}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
};

const ToggleRow: React.FC<{
  id: string;
  label: string;
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
}> = ({ id, label, checked, disabled = false, onCheckedChange }) => (
  <div className="flex items-center gap-2">
    <Checkbox
      id={id}
      checked={checked}
      disabled={disabled}
      onCheckedChange={(value) => onCheckedChange(value === true)}
    />
    <Label htmlFor={id} className="cursor-pointer font-normal">{label}</Label>
  </div>
);

export default EnergyTariffCard;
