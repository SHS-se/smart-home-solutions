import type {
  EnergyChargeCategory,
  EnergyDocumentKind,
} from './energy-billing-parser';

export type EnergyBillingChangeType = 'provider' | 'model' | 'price';

export interface EnergyBillingChangeDocument {
  id: string;
  document_kind: string;
  provider_key: string;
  provider_name: string;
  parser_id: string;
  parser_version: number;
  period_start: string;
  period_end: string;
  lineItems: Array<{
    category: string;
    label: string;
    unit_price_sek: number | null;
    period_start: string | null;
  }>;
}

export interface EnergyBillingChange {
  id: string;
  date: string;
  monthKey: string;
  documentKind: EnergyDocumentKind;
  type: EnergyBillingChangeType;
  titleSv: string;
  titleEn: string;
  detailSv: string;
  detailEn: string;
}

const STABLE_PRICE_CATEGORIES = new Set<EnergyChargeCategory>([
  'fixed_fee',
  'energy_transfer',
  'peak_demand',
  'energy_tax',
  'markup',
  'export_fee',
]);

const CATEGORY_LABELS: Partial<Record<EnergyChargeCategory, { sv: string; en: string }>> = {
  fixed_fee: { sv: 'fast avgift', en: 'fixed fee' },
  energy_transfer: { sv: 'överföringsavgift', en: 'transfer fee' },
  peak_demand: { sv: 'effektavgift', en: 'peak-demand fee' },
  energy_tax: { sv: 'energiskatt', en: 'energy tax' },
  markup: { sv: 'påslag', en: 'markup' },
  export_fee: { sv: 'produktionsavgift', en: 'production fee' },
};

const PARSER_CHANGE_COPY: Record<string, {
  titleSv: string;
  titleEn: string;
  detailSv: string;
  detailEn: string;
}> = {
  ellevio_peak_demand: {
    titleSv: 'Ellevio införde effektavgift',
    titleEn: 'Ellevio introduced a peak-demand fee',
    detailSv: 'Nätmodellen började debitera månadens effekttopp.',
    detailEn: 'The grid model began charging for the monthly demand peak.',
  },
  ellevio_flat_transfer: {
    titleSv: 'Ellevio ändrade nätmodell',
    titleEn: 'Ellevio changed its grid model',
    detailSv: 'Effektmodellen ersattes av en modell utan separat effektavgift.',
    detailEn: 'The peak-demand model was replaced by a model without a separate demand fee.',
  },
  karlstads_energi_consolidated: {
    titleSv: 'Karlstads Energi ändrade prismodell',
    titleEn: 'Karlstads Energi changed its pricing model',
    detailSv: 'Elhandelskostnaden började redovisas i färre, sammanslagna poster.',
    detailEn: 'Electricity charges began appearing as fewer consolidated line items.',
  },
  karlstads_energi_microproduction: {
    titleSv: 'Mikroproduktion registrerades',
    titleEn: 'Microgeneration was registered',
    detailSv: 'En separat modell för exporterad el och produktionsavgifter började användas.',
    detailEn: 'A separate model for exported electricity and production fees began being used.',
  },
};

function isDocumentKind(value: string): value is EnergyDocumentKind {
  return value === 'grid' || value === 'electricity';
}

function dayAfter(date: string): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
}

function round(value: number, decimals = 4): number {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function normalizedLabel(label: string): string {
  return label.trim().toLocaleLowerCase('sv-SE').replace(/\s+/g, ' ');
}

function formatPrice(value: number): string {
  return new Intl.NumberFormat('sv-SE', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 4,
  }).format(value);
}

function priceChangeEvents(
  documents: EnergyBillingChangeDocument[],
): EnergyBillingChange[] {
  const previousPrice = new Map<string, {
    price: number;
    date: string;
    providerName: string;
  }>();
  const grouped = new Map<string, {
    date: string;
    kind: EnergyDocumentKind;
    providerName: string;
    sv: string[];
    en: string[];
  }>();

  for (const document of documents) {
    if (!isDocumentKind(document.document_kind)) continue;
    for (const line of document.lineItems) {
      const category = line.category as EnergyChargeCategory;
      if (
        !STABLE_PRICE_CATEGORIES.has(category)
        || line.unit_price_sek === null
        || !Number.isFinite(line.unit_price_sek)
      ) {
        continue;
      }
      const date = line.period_start ?? document.period_start;
      const key = [
        document.document_kind,
        document.provider_key,
        category,
        normalizedLabel(line.label),
      ].join(':');
      const previous = previousPrice.get(key);
      previousPrice.set(key, {
        price: line.unit_price_sek,
        date,
        providerName: document.provider_name,
      });
      if (!previous || previous.date === date) continue;

      const tolerance = Math.max(0.005, Math.abs(previous.price) * 0.01);
      if (Math.abs(line.unit_price_sek - previous.price) <= tolerance) continue;

      const groupKey = `${document.document_kind}:${document.provider_key}:${date}`;
      const group = grouped.get(groupKey) ?? {
        date,
        kind: document.document_kind,
        providerName: document.provider_name,
        sv: [],
        en: [],
      };
      const label = CATEGORY_LABELS[category] ?? {
        sv: line.label,
        en: line.label,
      };
      group.sv.push(
        `${label.sv}: ${formatPrice(previous.price)} → ${formatPrice(line.unit_price_sek)} kr`,
      );
      group.en.push(
        `${label.en}: ${formatPrice(previous.price)} → ${formatPrice(line.unit_price_sek)} SEK`,
      );
      grouped.set(groupKey, group);
    }
  }

  return Array.from(grouped.entries()).map(([key, group]) => ({
    id: `price:${key}`,
    date: group.date,
    monthKey: group.date.slice(0, 7),
    documentKind: group.kind,
    type: 'price',
    titleSv: `${group.providerName} ändrade pris`,
    titleEn: `${group.providerName} changed its price`,
    detailSv: group.sv.join(' · '),
    detailEn: group.en.join(' · '),
  }));
}

function providerChangeEvents(
  documents: EnergyBillingChangeDocument[],
): EnergyBillingChange[] {
  const changes: EnergyBillingChange[] = [];

  for (const kind of ['grid', 'electricity'] as const) {
    const sorted = documents
      .filter((document) => document.document_kind === kind)
      .sort((a, b) => (
        a.period_start.localeCompare(b.period_start)
        || a.period_end.localeCompare(b.period_end)
      ));
    let active = sorted.at(0);
    if (!active) continue;

    for (const current of sorted.slice(1)) {
      if (current.provider_key === active.provider_key) {
        if (current.period_end > active.period_end) active = current;
        continue;
      }
      if (current.period_start < dayAfter(active.period_end)) continue;
      changes.push({
        id: `provider:${kind}:${current.period_start}:${current.provider_key}`,
        date: current.period_start,
        monthKey: current.period_start.slice(0, 7),
        documentKind: kind,
        type: 'provider',
        titleSv: `${kind === 'grid' ? 'Nätägare' : 'Elhandlare'} byttes`,
        titleEn: `${kind === 'grid' ? 'Grid operator' : 'Electricity provider'} changed`,
        detailSv: `${active.provider_name} → ${current.provider_name}`,
        detailEn: `${active.provider_name} → ${current.provider_name}`,
      });
      active = current;
    }
  }

  return changes;
}

function parserChangeEvents(
  documents: EnergyBillingChangeDocument[],
): EnergyBillingChange[] {
  const changes: EnergyBillingChange[] = [];
  const byProvider = new Map<string, EnergyBillingChangeDocument[]>();

  for (const document of documents) {
    if (!isDocumentKind(document.document_kind)) continue;
    const key = `${document.document_kind}:${document.provider_key}`;
    const list = byProvider.get(key) ?? [];
    list.push(document);
    byProvider.set(key, list);
  }

  for (const providerDocuments of byProvider.values()) {
    providerDocuments.sort((a, b) => (
      a.period_start.localeCompare(b.period_start)
      || a.parser_id.localeCompare(b.parser_id)
    ));
    const primaryDocuments = providerDocuments.filter(
      (document) => document.parser_id !== 'karlstads_energi_microproduction',
    );
    let baseline = primaryDocuments.at(0) ?? null;
    for (const document of primaryDocuments.slice(1)) {
      if (
        baseline
        && document.parser_id === baseline.parser_id
        && document.parser_version === baseline.parser_version
      ) {
        continue;
      }
      const parserKey = `${document.parser_id}:v${document.parser_version}`;
      const copy = PARSER_CHANGE_COPY[document.parser_id] ?? {
        titleSv: `${document.provider_name} ändrade fakturamodell`,
        titleEn: `${document.provider_name} changed its invoice model`,
        detailSv: baseline
          ? `${baseline.parser_id} v${baseline.parser_version} → ${document.parser_id} v${document.parser_version}`
          : `${document.parser_id} v${document.parser_version}`,
        detailEn: baseline
          ? `${baseline.parser_id} v${baseline.parser_version} → ${document.parser_id} v${document.parser_version}`
          : `${document.parser_id} v${document.parser_version}`,
      };
      changes.push({
        id: `model:${document.document_kind}:${document.provider_key}:${document.period_start}:${parserKey}`,
        date: document.period_start,
        monthKey: document.period_start.slice(0, 7),
        documentKind: document.document_kind as EnergyDocumentKind,
        type: 'model',
        ...copy,
      });
      baseline = document;
    }

    const supplementalParsers = new Set<string>();
    for (const document of providerDocuments.filter(
      (candidate) => candidate.parser_id === 'karlstads_energi_microproduction',
    )) {
      const parserKey = `${document.parser_id}:v${document.parser_version}`;
      if (supplementalParsers.has(parserKey)) continue;
      supplementalParsers.add(parserKey);
      const copy = PARSER_CHANGE_COPY[document.parser_id];
      changes.push({
        id: `model:${document.document_kind}:${document.provider_key}:${document.period_start}:${parserKey}`,
        date: document.period_start,
        monthKey: document.period_start.slice(0, 7),
        documentKind: document.document_kind as EnergyDocumentKind,
        type: 'model',
        ...copy,
      });
    }
  }

  return changes;
}

export function detectEnergyBillingChanges(
  documents: EnergyBillingChangeDocument[],
): EnergyBillingChange[] {
  const sorted = [...documents].sort((a, b) => (
    a.period_start.localeCompare(b.period_start)
    || a.id.localeCompare(b.id)
  ));
  return [
    ...providerChangeEvents(sorted),
    ...parserChangeEvents(sorted),
    ...priceChangeEvents(sorted),
  ].sort((a, b) => a.date.localeCompare(b.date) || a.type.localeCompare(b.type));
}
