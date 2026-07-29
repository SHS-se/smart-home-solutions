import type { QuestionType } from './questionnaire-engine';

export type HomeQuestionFeature = 'energy_history' | 'energy_simulator' | 'energy_setup' | 'roi';
export type HomeQuestionImportance = 'required' | 'recommended' | 'optional';
export type HomeQuestionDataUse = 'calculation' | 'setup_only';

export interface HomeQuestionFunctionality {
  key: string;
  type: QuestionType;
  importance: HomeQuestionImportance;
  dataUse: HomeQuestionDataUse;
  features: HomeQuestionFeature[];
  label: { sv: string; en: string };
  purpose: { sv: string; en: string };
  suggestedQuestion: { sv: string; en: string };
}

export const HOME_QUESTION_FEATURE_LABELS: Record<
  HomeQuestionFeature,
  { sv: string; en: string }
> = {
  energy_history: { sv: 'Energihistorik', en: 'Energy history' },
  energy_simulator: { sv: 'Energisimulator', en: 'Energy simulator' },
  energy_setup: { sv: 'Energiinställningar', en: 'Energy setup' },
  roi: { sv: 'Lönsamhet', en: 'ROI' },
};

export const HOME_QUESTION_FUNCTIONALITY: HomeQuestionFunctionality[] = [
  {
    key: 'move_in_date',
    type: 'date',
    importance: 'recommended',
    dataUse: 'calculation',
    features: ['energy_history'],
    label: { sv: 'Inflyttningsdatum', en: 'Move-in date' },
    purpose: {
      sv: 'Avgör när fakturatäckningen ska börja och om den första delmånaden är förväntad.',
      en: 'Defines when invoice coverage should begin and whether the first partial month is expected.',
    },
    suggestedQuestion: {
      sv: 'När flyttade ni in i bostaden?',
      en: 'When did you move into the home?',
    },
  },
  {
    key: 'dwelling_type',
    type: 'single_choice',
    importance: 'required',
    dataUse: 'calculation',
    features: ['energy_simulator', 'roi'],
    label: { sv: 'Bostadstyp', en: 'Dwelling type' },
    purpose: {
      sv: 'Påverkar byggnadens värmeförlustmodell och krävs för lönsamhetsberäkningen.',
      en: 'Affects the building heat-loss model and is required for ROI calculations.',
    },
    suggestedQuestion: {
      sv: 'Vilken typ av bostad gäller det?',
      en: 'What type of home is this?',
    },
  },
  {
    key: 'heated_area_m2',
    type: 'number',
    importance: 'required',
    dataUse: 'calculation',
    features: ['energy_history', 'energy_simulator', 'roi'],
    label: { sv: 'Uppvärmd yta', en: 'Heated area' },
    purpose: {
      sv: 'Skalar värmebehovet, används i den indikativa energiprestandan och krävs för lönsamhetsberäkningen.',
      en: 'Scales heating demand, supports the indicative energy-performance estimate, and is required for ROI calculations.',
    },
    suggestedQuestion: {
      sv: 'Hur stor är den uppvärmda ytan (m²)?',
      en: 'What is the heated area (m²)?',
    },
  },
  {
    key: 'year_built',
    type: 'number',
    importance: 'required',
    dataUse: 'calculation',
    features: ['energy_simulator', 'roi'],
    label: { sv: 'Byggnadsår', en: 'Year built' },
    purpose: {
      sv: 'Används för att uppskatta isoleringsnivå och krävs för lönsamhetsberäkningen.',
      en: 'Used to estimate insulation performance and is required for ROI calculations.',
    },
    suggestedQuestion: {
      sv: 'Vilket år byggdes bostaden?',
      en: 'What year was the home built?',
    },
  },
  {
    key: 'occupants',
    type: 'number',
    importance: 'optional',
    dataUse: 'setup_only',
    features: ['energy_setup'],
    label: { sv: 'Antal boende', en: 'Occupants' },
    purpose: {
      sv: 'Samlar in underlag för framtida modeller av hushållsel, varmvatten och närvaro.',
      en: 'Collects input for future household-electricity, hot-water, and occupancy models.',
    },
    suggestedQuestion: {
      sv: 'Hur många personer bor i bostaden?',
      en: 'How many people live in the home?',
    },
  },
  {
    key: 'heating_types',
    type: 'multi_choice',
    importance: 'optional',
    dataUse: 'setup_only',
    features: ['energy_setup'],
    label: { sv: 'Uppvärmningstyper', en: 'Heating types' },
    purpose: {
      sv: 'Registrerar vilka värmesystem som finns för framtida automatisk modellkoppling.',
      en: 'Records installed heating systems for future automatic model connections.',
    },
    suggestedQuestion: {
      sv: 'Hur värms bostaden upp?',
      en: 'How is the home heated?',
    },
  },
  {
    key: 'hot_water_type',
    type: 'single_choice',
    importance: 'optional',
    dataUse: 'setup_only',
    features: ['energy_setup'],
    label: { sv: 'Varmvattenberedning', en: 'Hot-water system' },
    purpose: {
      sv: 'Registrerar hur varmvatten produceras för framtida modellering.',
      en: 'Records how hot water is produced for future modelling.',
    },
    suggestedQuestion: {
      sv: 'Hur produceras varmvatten i bostaden?',
      en: 'How is hot water produced in the home?',
    },
  },
  {
    key: 'has_ev',
    type: 'boolean',
    importance: 'optional',
    dataUse: 'setup_only',
    features: ['energy_setup'],
    label: { sv: 'Elbil', en: 'Electric vehicle' },
    purpose: {
      sv: 'Registrerar om hushållet har ett laddbart fordon.',
      en: 'Records whether the household has a plug-in vehicle.',
    },
    suggestedQuestion: {
      sv: 'Har hushållet en elbil eller laddhybrid?',
      en: 'Does the household have an electric or plug-in hybrid vehicle?',
    },
  },
  {
    key: 'ev_charger_power_kw',
    type: 'number',
    importance: 'optional',
    dataUse: 'setup_only',
    features: ['energy_setup'],
    label: { sv: 'Laddareffekt', en: 'EV charger power' },
    purpose: {
      sv: 'Registrerar laddarens möjliga toppeffekt för framtida modellkoppling.',
      en: 'Records possible EV charging peak power for future model connections.',
    },
    suggestedQuestion: {
      sv: 'Vilken maxeffekt har billaddaren (kW)?',
      en: 'What is the EV charger maximum power (kW)?',
    },
  },
  {
    key: 'annual_kwh',
    type: 'number',
    importance: 'optional',
    dataUse: 'setup_only',
    features: ['energy_setup'],
    label: { sv: 'Årlig elanvändning', en: 'Annual electricity use' },
    purpose: {
      sv: 'Lagrar kundens referensvärde; simulatorn använder för närvarande fakturahistorik eller en separat manuell override.',
      en: 'Stores the customer reference value; the simulator currently uses invoice history or a separate manual override.',
    },
    suggestedQuestion: {
      sv: 'Hur stor är den årliga elanvändningen (kWh)?',
      en: 'What is the annual electricity use (kWh)?',
    },
  },
  {
    key: 'annual_peak_kw',
    type: 'number',
    importance: 'optional',
    dataUse: 'setup_only',
    features: ['energy_setup'],
    label: { sv: 'Årlig toppeffekt', en: 'Annual peak demand' },
    purpose: {
      sv: 'Lagrar ett referensvärde för framtida effekt- och lastbalanseringsmodeller.',
      en: 'Stores a reference value for future demand and load-balancing models.',
    },
    suggestedQuestion: {
      sv: 'Vilken är bostadens högsta uppmätta effekt (kW)?',
      en: 'What is the home’s highest measured demand (kW)?',
    },
  },
  {
    key: 'contract_type',
    type: 'single_choice',
    importance: 'optional',
    dataUse: 'setup_only',
    features: ['energy_setup'],
    label: { sv: 'Elavtal', en: 'Electricity contract' },
    purpose: {
      sv: 'Registrerar kundens prisupplägg för framtida kostnadsjämförelser.',
      en: 'Records the customer pricing arrangement for future cost comparisons.',
    },
    suggestedQuestion: {
      sv: 'Vilken typ av elavtal har hushållet?',
      en: 'What type of electricity contract does the household have?',
    },
  },
  {
    key: 'has_solar',
    type: 'boolean',
    importance: 'optional',
    dataUse: 'setup_only',
    features: ['energy_setup'],
    label: { sv: 'Solceller', en: 'Solar panels' },
    purpose: {
      sv: 'Registrerar om lokal elproduktion finns.',
      en: 'Records whether on-site electricity generation is installed.',
    },
    suggestedQuestion: {
      sv: 'Finns det solceller på bostaden?',
      en: 'Does the home have solar panels?',
    },
  },
  {
    key: 'has_battery',
    type: 'boolean',
    importance: 'optional',
    dataUse: 'setup_only',
    features: ['energy_setup'],
    label: { sv: 'Batterilagring', en: 'Battery storage' },
    purpose: {
      sv: 'Registrerar om batterilagring finns.',
      en: 'Records whether battery storage is installed.',
    },
    suggestedQuestion: {
      sv: 'Finns det ett hembatteri?',
      en: 'Does the home have a battery?',
    },
  },
];

export const HOME_QUESTION_FUNCTIONALITY_BY_KEY = new Map(
  HOME_QUESTION_FUNCTIONALITY.map((definition) => [definition.key, definition]),
);

export function getHomeQuestionFunctionality(
  semanticKey: string | null | undefined,
): HomeQuestionFunctionality | null {
  if (!semanticKey) return null;
  return HOME_QUESTION_FUNCTIONALITY_BY_KEY.get(semanticKey) ?? null;
}
