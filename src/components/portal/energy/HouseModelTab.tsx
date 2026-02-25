import React, { useMemo, useState, useEffect, useRef } from 'react';
import { Info, Plus, Trash2, X } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { useLanguage } from '@/contexts/LanguageContext';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

type WallTypeKey = 'timber' | 'brick' | 'concrete';
type RoofTypeKey = 'attic' | 'flat' | 'vaulted';
type FloorTypeKey = 'slab' | 'crawl' | 'basement';
type InsulationTypeKey = 'mineral_wool' | 'eps' | 'cellulose' | 'pir';
type WindowTypeKey = 'single' | 'double_old' | 'double_modern' | 'triple_modern';

type ConstructionPreset = {
  key: string;
  labelEn: string;
  labelSv: string;
  lambdaWmK: number;
  defaultThicknessMm: number;
  extraR: number; // surface layers / framing / finish approximation
};

type WindowPreset = {
  key: WindowTypeKey;
  labelEn: string;
  labelSv: string;
  uWm2K: number;
};

type HouseInfoTopic =
  | 'floors'
  | 'footprint_area'
  | 'stories'
  | 'ceiling_height'
  | 'aspect_ratio'
  | 'window_to_wall'
  | 'roof_area_factor'
  | 'floor_exposure_factor'
  | 'ach'
  | 'thermal_bridges'
  | 'indoor_temp'
  | 'design_outdoor'
  | 'total_ua'
  | 'design_heat_load'
  | 'infiltration_share';

interface HouseFloorInput {
  id: string;
  name: string;
  areaM2: number;
  ceilingHeightM: number;
  heatedInWinter: boolean;
}

const WALL_PRESETS: Record<WallTypeKey, ConstructionPreset> = {
  timber: { key: 'timber', labelEn: 'Timber Frame', labelSv: 'Träregelvägg', lambdaWmK: 0.13, defaultThicknessMm: 145, extraR: 0.25 },
  brick: { key: 'brick', labelEn: 'Brick/Masonry', labelSv: 'Tegel/Murverk', lambdaWmK: 0.77, defaultThicknessMm: 250, extraR: 0.18 },
  concrete: { key: 'concrete', labelEn: 'Concrete', labelSv: 'Betong', lambdaWmK: 1.7, defaultThicknessMm: 200, extraR: 0.12 },
};

const ROOF_PRESETS: Record<RoofTypeKey, ConstructionPreset> = {
  attic: { key: 'attic', labelEn: 'Attic Floor', labelSv: 'Vindsbjälklag', lambdaWmK: 0.16, defaultThicknessMm: 45, extraR: 0.35 },
  flat: { key: 'flat', labelEn: 'Flat Roof Deck', labelSv: 'Platt tak', lambdaWmK: 0.20, defaultThicknessMm: 35, extraR: 0.25 },
  vaulted: { key: 'vaulted', labelEn: 'Vaulted Roof', labelSv: 'Snedtak', lambdaWmK: 0.16, defaultThicknessMm: 45, extraR: 0.20 },
};

const FLOOR_PRESETS: Record<FloorTypeKey, ConstructionPreset> = {
  slab: { key: 'slab', labelEn: 'Slab on Ground', labelSv: 'Platta på mark', lambdaWmK: 1.4, defaultThicknessMm: 100, extraR: 0.10 },
  crawl: { key: 'crawl', labelEn: 'Crawlspace Floor', labelSv: 'Krypgrundsbjälklag', lambdaWmK: 0.16, defaultThicknessMm: 45, extraR: 0.25 },
  basement: { key: 'basement', labelEn: 'Basement Ceiling', labelSv: 'Källartak', lambdaWmK: 0.20, defaultThicknessMm: 60, extraR: 0.20 },
};

const INSULATION_PRESETS: Record<InsulationTypeKey, { labelEn: string; labelSv: string; lambdaWmK: number }> = {
  mineral_wool: { labelEn: 'Mineral Wool', labelSv: 'Mineralull', lambdaWmK: 0.037 },
  eps: { labelEn: 'EPS', labelSv: 'EPS', lambdaWmK: 0.036 },
  cellulose: { labelEn: 'Cellulose', labelSv: 'Cellulosa', lambdaWmK: 0.040 },
  pir: { labelEn: 'PIR/PUR Board', labelSv: 'PIR/PUR-skiva', lambdaWmK: 0.024 },
};

const WINDOW_PRESETS: WindowPreset[] = [
  { key: 'single', labelEn: 'Single Pane', labelSv: 'Enkelglas', uWm2K: 5.2 },
  { key: 'double_old', labelEn: 'Old Double / Coupled', labelSv: 'Äldre 2-glas', uWm2K: 2.8 },
  { key: 'double_modern', labelEn: 'Modern Double', labelSv: 'Modernt 2-glas', uWm2K: 1.5 },
  { key: 'triple_modern', labelEn: 'Modern Triple', labelSv: 'Modernt 3-glas', uWm2K: 0.9 },
];

const HOUSE_INFO_CONTENT: Record<HouseInfoTopic, { sv: { title: string; body: string }; en: { title: string; body: string } }> = {
  floors: {
    sv: {
      title: 'Våningslista (uppvärmda / ej uppvärmda)',
      body: `**Vad:** Här beskriver du varje våningsplan separat med area, takhöjd och om planet är uppvärmt på vintern.\n\n**Varför:** Kalkylen blir mer korrekt när våningar har olika storlek. Volym (ventilation/infiltration), väggarea och tak/golv-koppling påverkas av vilka plan som faktiskt är uppvärmda.\n\n**Tips:** Lägg in källare också men markera den som ej uppvärmd om den inte värms vintertid.`,
    },
    en: {
      title: 'Floor list (heated / unheated)',
      body: `**What:** Define each floor separately with area, ceiling height, and whether it is heated in winter.\n\n**Why:** The estimate is more accurate when floors differ in size. Volume (ventilation/infiltration), wall area, and roof/floor coupling depend on which floors are actually heated.\n\n**Tip:** Add the basement too, but mark it unheated if it is not heated in winter.`,
    },
  },
  footprint_area: {
    sv: {
      title: 'Byggnadsarea / footprint',
      body: `**Vad:** Byggnadens markyta per plan (m²).\n\n**Påverkan:** Ökar golv- och takarea direkt, och påverkar väggarea via omkretsen. Större area ger normalt högre UA.\n\n**Typiskt:** Småhus ofta ca 80-200 m² per plan.\n\n**Vanligt fel:** Ange total boyta i stället för area per våningsplan när du redan anger antal våningar.`,
    },
    en: {
      title: 'Footprint area',
      body: `**What:** Building ground area per floor plate (m²).\n\n**Impact:** Directly increases floor/roof area and affects wall area through perimeter. Larger area usually means higher UA.\n\n**Typical:** Detached homes are often about 80-200 m² per floor.\n\n**Common mistake:** Entering total living area instead of per-floor footprint when you also set number of stories.`,
    },
  },
  stories: {
    sv: {
      title: 'Våningar',
      body: `**Vad:** Antal uppvärmda våningsplan.\n\n**Påverkan:** Ökar väggarea och volym. Volymen påverkar infiltration (ACH -> W/K).\n\n**Tips:** Ange bara plan som hålls varma större delen av tiden.`,
    },
    en: {
      title: 'Stories',
      body: `**What:** Number of heated stories.\n\n**Impact:** Increases wall area and volume. Volume affects infiltration (ACH -> W/K).\n\n**Tip:** Include only floors that are heated most of the time.`,
    },
  },
  ceiling_height: {
    sv: {
      title: 'Takhöjd',
      body: `**Vad:** Genomsnittlig invändig takhöjd i uppvärmda utrymmen.\n\n**Påverkan:** Ökar väggarea och volym. Högre takhöjd ökar ofta både transmission och infiltration.\n\n**Typiskt:** 2.3-2.6 m i många småhus.`,
    },
    en: {
      title: 'Ceiling height',
      body: `**What:** Average interior ceiling height in heated spaces.\n\n**Impact:** Increases wall area and volume. Higher ceiling height often raises both transmission and infiltration.\n\n**Typical:** 2.3-2.6 m in many homes.`,
    },
  },
  aspect_ratio: {
    sv: {
      title: 'L/B-förhållande',
      body: `**Vad:** Förhållande mellan längd och bredd för footprinten.\n\n**Påverkan:** Styr omkrets för given area. Högre eller lägre extremvärden ger större omkrets och mer väggarea -> högre UA.\n\n**Typiskt:** 1.0-2.0 för många hus.`,
    },
    en: {
      title: 'L/W ratio',
      body: `**What:** Length-to-width ratio of the footprint.\n\n**Impact:** Controls perimeter for a given area. More extreme values increase perimeter and wall area -> higher UA.\n\n**Typical:** 1.0-2.0 for many houses.`,
    },
  },
  window_to_wall: {
    sv: {
      title: 'Fönsterandel vägg',
      body: `**Vad:** Andel av ytterväggsarean som är fönster (%).\n\n**Påverkan:** Byter opak väggyta mot fönsteryta. Fönster har oftast högre U-värde än vägg, så högre andel höjer vanligtvis UA.\n\n**Typiskt:** Ca 10-25% i småhus.`,
    },
    en: {
      title: 'Window-to-wall ratio',
      body: `**What:** Share of exterior wall area that is windows (%).\n\n**Impact:** Replaces opaque wall area with window area. Windows usually have higher U-values than walls, so higher ratio usually increases UA.\n\n**Typical:** Around 10-25% in detached homes.`,
    },
  },
  roof_area_factor: {
    sv: {
      title: 'Takytfaktor',
      body: `**Vad:** Multiplikator på footprint för att uppskatta verklig takyta.\n\n**Påverkan:** Högre värde ger större takarea och högre tak-UA.\n\n**Exempel:** 1.00 för nästan platt tak, 1.05-1.20 för lutande tak beroende på lutning och geometri.`,
    },
    en: {
      title: 'Roof area factor',
      body: `**What:** Multiplier on footprint to estimate actual roof area.\n\n**Impact:** Higher value increases roof area and roof UA.\n\n**Examples:** 1.00 for near-flat roofs, 1.05-1.20 for pitched roofs depending on slope and geometry.`,
    },
  },
  floor_exposure_factor: {
    sv: {
      title: 'Golvens exponeringsfaktor',
      body: `**Vad:** Justerar hur starkt golvets U-värde påverkar total UA mot mark/underliggande zon.\n\n**Påverkan:** Högre faktor ökar golvbidraget till UA.\n\n**Tolkning:** Lägre värden kan passa välisolerad platta/markkoppling, högre värden mer exponerade bjälklag. Detta är en kalibreringsparameter i denna förenklade modell.`,
    },
    en: {
      title: 'Floor exposure factor',
      body: `**What:** Adjusts how strongly floor U-value contributes to total UA versus ground / underlying zone.\n\n**Impact:** Higher factor increases the floor contribution to UA.\n\n**Interpretation:** Lower values can fit well-insulated slab-on-ground, higher values more exposed floors. This is a calibration parameter in this simplified model.`,
    },
  },
  ach: {
    sv: {
      title: 'ACH (luftomsättning)',
      body: `**Vad:** Luftomsättningar per timme (1/h) för infiltration/ventilation i den förenklade modellen.\n\n**Påverkan:** Infiltrations-UA beräknas ungefär som 0.33 * ACH * volym. Därför kan ACH ge stor effekt på total UA.\n\n**Typiskt:** Ca 0.2-0.7 1/h beroende på täthet och ventilation.\n\n**Vanligt fel:** Sätta för högt värde och kompensera med för låg väggisolering.`,
    },
    en: {
      title: 'ACH (air changes per hour)',
      body: `**What:** Air changes per hour (1/h) for infiltration/ventilation in the simplified model.\n\n**Impact:** Infiltration UA is estimated roughly as 0.33 * ACH * volume, so ACH can have a large effect on total UA.\n\n**Typical:** About 0.2-0.7 1/h depending on airtightness and ventilation.\n\n**Common mistake:** Setting ACH too high and then compensating with unrealistically good wall insulation.`,
    },
  },
  thermal_bridges: {
    sv: {
      title: 'Köldbryggor',
      body: `**Vad:** Procentuellt påslag på ledningsförluster (vägg/fönster/tak/golv) för att approximera köldbryggor.\n\n**Påverkan:** Ökar total UA som ett påslag på transmission, inte på infiltration.\n\n**Typiskt:** Ofta ca 5-15% som startvärde i förenklade modeller.`,
    },
    en: {
      title: 'Thermal bridges',
      body: `**What:** Percentage adder on conduction losses (walls/windows/roof/floor) to approximate thermal bridges.\n\n**Impact:** Increases total UA as an adder on transmission, not infiltration.\n\n**Typical:** Often around 5-15% as a starting point in simplified models.`,
    },
  },
  indoor_temp: {
    sv: {
      title: 'Inomhustemperatur',
      body: `**Vad:** Referens inomhustemperatur för värmebehovsberäkning.\n\n**Påverkan:** Används tillsammans med utomhustemperatur för ΔT. Högre innetemperatur ger högre värmeeffektbehov.\n\n**Tips:** Använd samma temperatur som du tänker använda i simulatorn.`,
    },
    en: {
      title: 'Indoor temperature',
      body: `**What:** Reference indoor temperature for heat demand calculations.\n\n**Impact:** Combined with outdoor temperature to form ΔT. Higher indoor temperature increases heating load.\n\n**Tip:** Use the same target temperature you plan to use in the simulator.`,
    },
  },
  design_outdoor: {
    sv: {
      title: 'Dimensionerande utetemperatur',
      body: `**Vad:** Kall referenstemperatur för att uppskatta dimensionerande värmeeffekt.\n\n**Påverkan:** Lägre temperatur ökar ΔT och därmed designvärmeeffekten (kW).\n\n**Tips:** Välj ortsnära designvärde eller det du använder i dimensioneringsarbete.`,
    },
    en: {
      title: 'Design outdoor temperature',
      body: `**What:** Cold reference outdoor temperature used to estimate design heat load.\n\n**Impact:** Lower value increases ΔT and therefore design heat load (kW).\n\n**Tip:** Use a location-specific design value or the one used in your sizing workflow.`,
    },
  },
  total_ua: {
    sv: {
      title: 'Total UA',
      body: `**Vad:** Husets totala värmeförlustkoefficient i W/K.\n\n**Hur den används:** Detta är huvudparametern som kopplar utetemperatur till värmebehov i simulatorn (effekt ≈ UA * ΔT).\n\n**Praktik:** Använd som startvärde och kalibrera mot uppmätt energi/effekt.`,
    },
    en: {
      title: 'Total UA',
      body: `**What:** The building's total heat loss coefficient in W/K.\n\n**How it's used:** This is the main parameter that links outdoor temperature to heating demand in the simulator (power ≈ UA * ΔT).\n\n**Practice:** Use it as a starting value and calibrate against measured energy/power.`,
    },
  },
  design_heat_load: {
    sv: {
      title: 'Dimensionerande värmeeffekt',
      body: `**Vad:** Uppskattat effektbehov vid vald dimensionerande utetemperatur.\n\n**Beräkning:** ungefär Total UA * (inomhus - dimensionerande ute).\n\n**Hur den används:** Rimlighetskontroll mot installerad värmekälla och historiska toppar.`,
    },
    en: {
      title: 'Design heat load',
      body: `**What:** Estimated heating power requirement at the selected design outdoor temperature.\n\n**Calculation:** approximately Total UA * (indoor - design outdoor).\n\n**How it's used:** Sanity-check against installed heating capacity and observed winter peaks.`,
    },
  },
  infiltration_share: {
    sv: {
      title: 'Infiltrationens andel',
      body: `**Vad:** Hur stor del av total UA som kommer från infiltration/ventilation i denna modell.\n\n**Hur den används:** Hjälper dig se om ACH-antagandet verkar rimligt. Om andelen blir orimligt hög/låg bör ACH och volymantaganden granskas först.`,
    },
    en: {
      title: 'Infiltration share',
      body: `**What:** The portion of total UA that comes from infiltration/ventilation in this model.\n\n**How it's used:** Helps check whether the ACH assumption looks reasonable. If the share is unrealistically high/low, review ACH and volume assumptions first.`,
    },
  },
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function safePositive(n: number, fallback: number): number {
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function withSurfaceFilmsU(structural: ConstructionPreset, structuralThicknessMm: number, insulationLambda: number, insulationThicknessMm: number, rsi: number, rse: number): number {
  const structR = (safePositive(structuralThicknessMm, structural.defaultThicknessMm) / 1000) / structural.lambdaWmK;
  const insR = insulationThicknessMm > 0 ? (insulationThicknessMm / 1000) / insulationLambda : 0;
  const totalR = rsi + rse + structural.extraR + structR + insR;
  return totalR > 0 ? 1 / totalR : 10;
}

function perimeterFromFootprint(areaM2: number, aspectRatio: number): number {
  const a = safePositive(areaM2, 1);
  const r = clamp(aspectRatio, 0.2, 5);
  const length = Math.sqrt(a * r);
  const width = Math.sqrt(a / r);
  return 2 * (length + width);
}

function HouseInfoLabel({
  label,
  topic,
  activeInfo,
  setActiveInfo,
  className = 'text-xs',
}: {
  label: string;
  topic: HouseInfoTopic;
  activeInfo: HouseInfoTopic | null;
  setActiveInfo: (topic: HouseInfoTopic | null) => void;
  className?: string;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <Label className={className}>{label}</Label>
      <button
        type="button"
        onClick={() => setActiveInfo(activeInfo === topic ? null : topic)}
        className={`rounded-full p-0.5 transition-colors ${activeInfo === topic ? 'text-primary' : 'text-muted-foreground hover:text-foreground'}`}
        aria-label={`Info: ${label}`}
      >
        <Info className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

function HouseInfoValueLabel({
  label,
  topic,
  activeInfo,
  setActiveInfo,
}: {
  label: string;
  topic: HouseInfoTopic;
  activeInfo: HouseInfoTopic | null;
  setActiveInfo: (topic: HouseInfoTopic | null) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <div className="text-xs text-muted-foreground">{label}</div>
      <button
        type="button"
        onClick={() => setActiveInfo(activeInfo === topic ? null : topic)}
        className={`rounded-full p-0.5 transition-colors ${activeInfo === topic ? 'text-primary' : 'text-muted-foreground hover:text-foreground'}`}
        aria-label={`Info: ${label}`}
      >
        <Info className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

const STORAGE_KEY = 'house-model-inputs';

interface HouseModelInputs {
  floors: HouseFloorInput[];
  aspectRatio: number;
  windowToWallPct: number;
  roofAreaFactor: number;
  wallType: WallTypeKey;
  wallStructThicknessMm: number;
  wallInsType: InsulationTypeKey;
  wallInsThicknessMm: number;
  windowType: WindowTypeKey;
  roofType: RoofTypeKey;
  roofStructThicknessMm: number;
  roofInsType: InsulationTypeKey;
  roofInsThicknessMm: number;
  floorType: FloorTypeKey;
  floorStructThicknessMm: number;
  floorInsType: InsulationTypeKey;
  floorInsThicknessMm: number;
  floorExposureFactor: number;
  ach: number;
  thermalBridgePct: number;
  indoorTempC: number;
  designOutdoorTempC: number;
}

interface HouseModelExport {
  schema: 'house_model_v1' | 'house_model_v2';
  exportedAt: string;
  units: {
    ua: 'W/K';
    power: 'W';
    powerChart: 'kW';
    area: 'm2';
    volume: 'm3';
    temp: 'C';
    thickness: 'mm';
    uValue: 'W/m2K';
    ach: '1/h';
  };
  inputs: HouseModelInputs | (Record<string, unknown> & {
    footprintAreaM2?: number;
    stories?: number;
    ceilingHeightM?: number;
  });
  calculated: {
    geometry: {
      perimeterM: number;
      wallGrossAreaM2: number;
      wallOpaqueAreaM2: number;
      windowAreaM2: number;
      roofAreaM2: number;
      floorAreaM2: number;
      volumeM3: number;
      floorCount?: number;
      heatedFloorCount?: number;
      heatedFloorAreaM2?: number;
    };
    uValues: {
      wallWm2K: number;
      windowWm2K: number;
      roofWm2K: number;
      floorWm2K: number;
    };
    uaBreakdownWPerK: {
      wall: number;
      window: number;
      roof: number;
      floor: number;
      thermalBridges: number;
      infiltration: number;
      conduction: number;
      total: number;
    };
    design: {
      indoorTempC: number;
      designOutdoorTempC: number;
      deltaTC: number;
      heatLoadW: number;
      heatLoadKw: number;
      infiltrationSharePct: number;
    };
    charts: {
      tempSweep: Array<{ tempC: number; heatKw: number }>;
      uaBreakdown: Array<{ key: string; label: string; ua: number }>;
    };
  };
}

function createFloor(overrides: Partial<HouseFloorInput> = {}): HouseFloorInput {
  return {
    id: overrides.id ?? `floor_${Math.random().toString(36).slice(2, 10)}`,
    name: overrides.name ?? 'Floor',
    areaM2: overrides.areaM2 ?? 60,
    ceilingHeightM: overrides.ceilingHeightM ?? 2.4,
    heatedInWinter: overrides.heatedInWinter ?? true,
  };
}

const DEFAULTS: HouseModelInputs = {
  floors: [
    createFloor({ name: 'Basement', areaM2: 120, heatedInWinter: false }),
    createFloor({ name: 'Middle floor', areaM2: 120, heatedInWinter: true }),
    createFloor({ name: 'Top floor', areaM2: 90, heatedInWinter: true }),
  ],
  aspectRatio: 1.5,
  windowToWallPct: 18,
  roofAreaFactor: 1.08,
  wallType: 'timber',
  wallStructThicknessMm: WALL_PRESETS.timber.defaultThicknessMm,
  wallInsType: 'mineral_wool',
  wallInsThicknessMm: 170,
  windowType: 'double_modern',
  roofType: 'attic',
  roofStructThicknessMm: ROOF_PRESETS.attic.defaultThicknessMm,
  roofInsType: 'mineral_wool',
  roofInsThicknessMm: 350,
  floorType: 'slab',
  floorStructThicknessMm: FLOOR_PRESETS.slab.defaultThicknessMm,
  floorInsType: 'eps',
  floorInsThicknessMm: 100,
  floorExposureFactor: 0.55,
  ach: 0.35,
  thermalBridgePct: 10,
  indoorTempC: 21,
  designOutdoorTempC: -15,
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeFloors(value: unknown): HouseFloorInput[] | null {
  if (!Array.isArray(value)) return null;

  const floors: HouseFloorInput[] = value
    .filter(isRecord)
    .map((row, index) => createFloor({
      id: typeof row.id === 'string' && row.id ? row.id : undefined,
      name: typeof row.name === 'string' && row.name.trim() ? row.name : `Floor ${index + 1}`,
      areaM2: isFiniteNumber(row.areaM2) ? row.areaM2 : 0,
      ceilingHeightM: isFiniteNumber(row.ceilingHeightM) ? row.ceilingHeightM : 2.4,
      heatedInWinter: typeof row.heatedInWinter === 'boolean' ? row.heatedInWinter : true,
    }));

  return floors.length > 0 ? floors : null;
}

function loadSavedInputs(): HouseModelInputs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (isRecord(parsed)) {
        const floors = normalizeFloors(parsed.floors);
        if (floors) {
          return { ...DEFAULTS, ...parsed, floors } as HouseModelInputs;
        }
        // Migrate older saved shape (v1 footprint/stories/ceilingHeight -> floors)
        const footprint = isFiniteNumber(parsed.footprintAreaM2) ? parsed.footprintAreaM2 : 120;
        const stories = isFiniteNumber(parsed.stories) ? Math.max(1, Math.round(parsed.stories)) : 2;
        const ceilingHeightM = isFiniteNumber(parsed.ceilingHeightM) ? parsed.ceilingHeightM : 2.4;
        const migratedFloors = Array.from({ length: stories }, (_, i) =>
          createFloor({
            name: `Floor ${i + 1}`,
            areaM2: footprint,
            ceilingHeightM,
            heatedInWinter: true,
          }),
        );
        return { ...DEFAULTS, ...parsed, floors: migratedFloors } as HouseModelInputs;
      }
    }
  } catch { /* ignore */ }
  return DEFAULTS;
}

const HouseModelTab: React.FC = () => {
  const { t, language } = useLanguage();
  const [activeInfo, setActiveInfo] = useState<HouseInfoTopic | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [importStatus, setImportStatus] = useState<string | null>(null);

  const [saved] = useState(() => loadSavedInputs());

  const [floors, setFloors] = useState<HouseFloorInput[]>(saved.floors);
  const [aspectRatio, setAspectRatio] = useState(saved.aspectRatio);
  const [windowToWallPct, setWindowToWallPct] = useState(saved.windowToWallPct);
  const [roofAreaFactor, setRoofAreaFactor] = useState(saved.roofAreaFactor);

  const [wallType, setWallType] = useState<WallTypeKey>(saved.wallType);
  const [wallStructThicknessMm, setWallStructThicknessMm] = useState(saved.wallStructThicknessMm);
  const [wallInsType, setWallInsType] = useState<InsulationTypeKey>(saved.wallInsType);
  const [wallInsThicknessMm, setWallInsThicknessMm] = useState(saved.wallInsThicknessMm);

  const [windowType, setWindowType] = useState<WindowTypeKey>(saved.windowType);

  const [roofType, setRoofType] = useState<RoofTypeKey>(saved.roofType);
  const [roofStructThicknessMm, setRoofStructThicknessMm] = useState(saved.roofStructThicknessMm);
  const [roofInsType, setRoofInsType] = useState<InsulationTypeKey>(saved.roofInsType);
  const [roofInsThicknessMm, setRoofInsThicknessMm] = useState(saved.roofInsThicknessMm);

  const [floorType, setFloorType] = useState<FloorTypeKey>(saved.floorType);
  const [floorStructThicknessMm, setFloorStructThicknessMm] = useState(saved.floorStructThicknessMm);
  const [floorInsType, setFloorInsType] = useState<InsulationTypeKey>(saved.floorInsType);
  const [floorInsThicknessMm, setFloorInsThicknessMm] = useState(saved.floorInsThicknessMm);
  const [floorExposureFactor, setFloorExposureFactor] = useState(saved.floorExposureFactor);

  const [ach, setAch] = useState(saved.ach);
  const [thermalBridgePct, setThermalBridgePct] = useState(saved.thermalBridgePct);

  const [indoorTempC, setIndoorTempC] = useState(saved.indoorTempC);
  const [designOutdoorTempC, setDesignOutdoorTempC] = useState(saved.designOutdoorTempC);

  const addFloor = () => {
    setFloors(prev => [...prev, createFloor({ name: `Floor ${prev.length + 1}` })]);
  };

  const updateFloor = (id: string, patch: Partial<HouseFloorInput>) => {
    setFloors(prev => prev.map(f => (f.id === id ? { ...f, ...patch } : f)));
  };

  const removeFloor = (id: string) => {
    setFloors(prev => (prev.length <= 1 ? prev : prev.filter(f => f.id !== id)));
  };

  const currentInputs = useMemo<HouseModelInputs>(() => ({
    floors,
    aspectRatio,
    windowToWallPct,
    roofAreaFactor,
    wallType,
    wallStructThicknessMm,
    wallInsType,
    wallInsThicknessMm,
    windowType,
    roofType,
    roofStructThicknessMm,
    roofInsType,
    roofInsThicknessMm,
    floorType,
    floorStructThicknessMm,
    floorInsType,
    floorInsThicknessMm,
    floorExposureFactor,
    ach,
    thermalBridgePct,
    indoorTempC,
    designOutdoorTempC,
  }), [
    floors, aspectRatio, windowToWallPct, roofAreaFactor,
    wallType, wallStructThicknessMm, wallInsType, wallInsThicknessMm,
    windowType,
    roofType, roofStructThicknessMm, roofInsType, roofInsThicknessMm,
    floorType, floorStructThicknessMm, floorInsType, floorInsThicknessMm, floorExposureFactor,
    ach, thermalBridgePct, indoorTempC, designOutdoorTempC,
  ]);

  // Persist all inputs to localStorage on every change
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(currentInputs));
  }, [
    currentInputs,
  ]);

  const calc = useMemo(() => {
    const wallPreset = WALL_PRESETS[wallType];
    const roofPreset = ROOF_PRESETS[roofType];
    const floorPreset = FLOOR_PRESETS[floorType];
    const wallIns = INSULATION_PRESETS[wallInsType];
    const roofIns = INSULATION_PRESETS[roofInsType];
    const floorIns = INSULATION_PRESETS[floorInsType];
    const winPreset = WINDOW_PRESETS.find(w => w.key === windowType)!;

    const normalizedFloors = floors.length > 0 ? floors : DEFAULTS.floors;
    const heatedFloors = normalizedFloors.filter(f => f.heatedInWinter);
    const effectiveHeatedFloors = heatedFloors.length > 0 ? heatedFloors : [normalizedFloors[0]];

    const floorPerimeters = normalizedFloors.map(f => perimeterFromFootprint(safePositive(f.areaM2, 1), aspectRatio));
    const heatedPerimeterSum = effectiveHeatedFloors.reduce((sum, f) => sum + perimeterFromFootprint(safePositive(f.areaM2, 1), aspectRatio), 0);
    const wallGrossArea = effectiveHeatedFloors.reduce((sum, f) => {
      const perimeter = perimeterFromFootprint(safePositive(f.areaM2, 1), aspectRatio);
      const ceilingH = safePositive(f.ceilingHeightM, 2.4);
      return sum + perimeter * ceilingH;
    }, 0);
    const windowArea = clamp(wallGrossArea * (windowToWallPct / 100), 0, wallGrossArea * 0.8);
    const wallOpaqueArea = Math.max(0, wallGrossArea - windowArea);
    const topHeatedFloor = effectiveHeatedFloors[effectiveHeatedFloors.length - 1];
    const lowestHeatedFloor = effectiveHeatedFloors[0];
    const roofArea = safePositive(topHeatedFloor.areaM2, 1) * safePositive(roofAreaFactor, 1);
    const floorArea = safePositive(lowestHeatedFloor.areaM2, 1);
    const volumeM3 = effectiveHeatedFloors.reduce((sum, f) => sum + safePositive(f.areaM2, 1) * safePositive(f.ceilingHeightM, 2.4), 0);

    const wallU = withSurfaceFilmsU(wallPreset, wallStructThicknessMm, wallIns.lambdaWmK, wallInsThicknessMm, 0.13, 0.04);
    const roofU = withSurfaceFilmsU(roofPreset, roofStructThicknessMm, roofIns.lambdaWmK, roofInsThicknessMm, 0.10, 0.04);
    const floorU = withSurfaceFilmsU(floorPreset, floorStructThicknessMm, floorIns.lambdaWmK, floorInsThicknessMm, 0.17, 0.04);
    const windowU = winPreset.uWm2K;

    const wallUa = wallU * wallOpaqueArea;
    const windowUa = windowU * windowArea;
    const roofUa = roofU * roofArea;
    const floorUa = floorU * floorArea * clamp(floorExposureFactor, 0, 1.5);
    const conductionUa = wallUa + windowUa + roofUa + floorUa;
    const bridgeUa = conductionUa * (clamp(thermalBridgePct, 0, 50) / 100);
    const infiltrationUa = 0.33 * clamp(ach, 0, 5) * volumeM3;
    const totalUa = conductionUa + bridgeUa + infiltrationUa;

    const deltaT = Math.max(0, indoorTempC - designOutdoorTempC);
    const designHeatW = totalUa * deltaT;

    const breakdown = [
      { key: 'wall', label: t('Väggar (opaka)', 'Walls (opaque)'), ua: wallUa },
      { key: 'window', label: t('Fönster', 'Windows'), ua: windowUa },
      { key: 'roof', label: t('Tak', 'Roof'), ua: roofUa },
      { key: 'floor', label: t('Golv/Mark (ekv.)', 'Floor/Ground (equiv.)'), ua: floorUa },
      { key: 'bridge', label: t('Köldbryggor (påslag)', 'Thermal bridges (adder)'), ua: bridgeUa },
      { key: 'infiltration', label: t('Infiltration/Ventilation', 'Infiltration/Ventilation'), ua: infiltrationUa },
    ];

    const tempSweep = Array.from({ length: 41 }, (_, i) => {
      const tempC = -20 + i;
      const heatW = totalUa * Math.max(0, indoorTempC - tempC);
      return { tempC, heatKw: Math.round((heatW / 1000) * 10) / 10 };
    });

    return {
      heatedPerimeterSum,
      floorPerimeters,
      floorCount: normalizedFloors.length,
      heatedFloorCount: heatedFloors.length,
      wallGrossArea,
      wallOpaqueArea,
      windowArea,
      roofArea,
      floorArea,
      volumeM3,
      heatedFloorAreaM2: effectiveHeatedFloors.reduce((sum, f) => sum + safePositive(f.areaM2, 1), 0),
      wallU,
      roofU,
      floorU,
      windowU,
      wallUa,
      windowUa,
      roofUa,
      floorUa,
      conductionUa,
      bridgeUa,
      infiltrationUa,
      totalUa,
      designHeatW,
      breakdown,
      tempSweep,
    };
  }, [
    t,
    floors, aspectRatio, windowToWallPct, roofAreaFactor,
    wallType, wallStructThicknessMm, wallInsType, wallInsThicknessMm,
    windowType,
    roofType, roofStructThicknessMm, roofInsType, roofInsThicknessMm,
    floorType, floorStructThicknessMm, floorInsType, floorInsThicknessMm, floorExposureFactor,
    ach, thermalBridgePct, indoorTempC, designOutdoorTempC,
  ]);

  const infoData = activeInfo ? HOUSE_INFO_CONTENT[activeInfo][language] : null;

  const applyImportedInputs = (raw: unknown) => {
    if (!isRecord(raw)) throw new Error('Invalid JSON: expected object');

    const src = isRecord(raw.inputs) ? raw.inputs : raw;
    if (!isRecord(src)) throw new Error('Invalid JSON: missing inputs object');

    const importedFloors = normalizeFloors(src.floors);
    if (importedFloors) {
      setFloors(importedFloors);
    } else {
      const footprint = isFiniteNumber(src.footprintAreaM2) ? src.footprintAreaM2 : undefined;
      const stories = isFiniteNumber(src.stories) ? Math.max(1, Math.round(src.stories)) : undefined;
      const ceilingHeight = isFiniteNumber(src.ceilingHeightM) ? src.ceilingHeightM : undefined;
      if (footprint && stories) {
        setFloors(Array.from({ length: stories }, (_, i) => createFloor({
          name: `Floor ${i + 1}`,
          areaM2: footprint,
          ceilingHeightM: ceilingHeight ?? 2.4,
          heatedInWinter: true,
        })));
      }
    }

    const setNum = (key: keyof HouseModelInputs, setter: (n: number) => void) => {
      const value = src[key as string];
      if (isFiniteNumber(value)) setter(value);
    };

    const setEnum = <T extends string>(key: keyof HouseModelInputs, valid: readonly T[], setter: (v: T) => void) => {
      const value = src[key as string];
      if (typeof value === 'string' && (valid as readonly string[]).includes(value)) setter(value as T);
    };

    setNum('aspectRatio', setAspectRatio);
    setNum('windowToWallPct', setWindowToWallPct);
    setNum('roofAreaFactor', setRoofAreaFactor);

    setEnum('wallType', Object.keys(WALL_PRESETS) as WallTypeKey[], setWallType as (v: string) => void);
    setNum('wallStructThicknessMm', setWallStructThicknessMm);
    setEnum('wallInsType', Object.keys(INSULATION_PRESETS) as InsulationTypeKey[], setWallInsType as (v: string) => void);
    setNum('wallInsThicknessMm', setWallInsThicknessMm);

    setEnum('windowType', WINDOW_PRESETS.map(w => w.key) as WindowTypeKey[], setWindowType as (v: string) => void);

    setEnum('roofType', Object.keys(ROOF_PRESETS) as RoofTypeKey[], setRoofType as (v: string) => void);
    setNum('roofStructThicknessMm', setRoofStructThicknessMm);
    setEnum('roofInsType', Object.keys(INSULATION_PRESETS) as InsulationTypeKey[], setRoofInsType as (v: string) => void);
    setNum('roofInsThicknessMm', setRoofInsThicknessMm);

    setEnum('floorType', Object.keys(FLOOR_PRESETS) as FloorTypeKey[], setFloorType as (v: string) => void);
    setNum('floorStructThicknessMm', setFloorStructThicknessMm);
    setEnum('floorInsType', Object.keys(INSULATION_PRESETS) as InsulationTypeKey[], setFloorInsType as (v: string) => void);
    setNum('floorInsThicknessMm', setFloorInsThicknessMm);
    setNum('floorExposureFactor', setFloorExposureFactor);

    setNum('ach', setAch);
    setNum('thermalBridgePct', setThermalBridgePct);
    setNum('indoorTempC', setIndoorTempC);
    setNum('designOutdoorTempC', setDesignOutdoorTempC);
  };

  const handleExportJson = () => {
    const exportData: HouseModelExport = {
      schema: 'house_model_v2',
      exportedAt: new Date().toISOString(),
      units: {
        ua: 'W/K',
        power: 'W',
        powerChart: 'kW',
        area: 'm2',
        volume: 'm3',
        temp: 'C',
        thickness: 'mm',
        uValue: 'W/m2K',
        ach: '1/h',
      },
      inputs: currentInputs,
      calculated: {
        geometry: {
          perimeterM: calc.heatedPerimeterSum,
          wallGrossAreaM2: calc.wallGrossArea,
          wallOpaqueAreaM2: calc.wallOpaqueArea,
          windowAreaM2: calc.windowArea,
          roofAreaM2: calc.roofArea,
          floorAreaM2: calc.floorArea,
          volumeM3: calc.volumeM3,
          floorCount: calc.floorCount,
          heatedFloorCount: calc.heatedFloorCount,
          heatedFloorAreaM2: calc.heatedFloorAreaM2,
        },
        uValues: {
          wallWm2K: calc.wallU,
          windowWm2K: calc.windowU,
          roofWm2K: calc.roofU,
          floorWm2K: calc.floorU,
        },
        uaBreakdownWPerK: {
          wall: calc.wallUa,
          window: calc.windowUa,
          roof: calc.roofUa,
          floor: calc.floorUa,
          thermalBridges: calc.bridgeUa,
          infiltration: calc.infiltrationUa,
          conduction: calc.conductionUa,
          total: calc.totalUa,
        },
        design: {
          indoorTempC,
          designOutdoorTempC,
          deltaTC: Math.max(0, indoorTempC - designOutdoorTempC),
          heatLoadW: calc.designHeatW,
          heatLoadKw: calc.designHeatW / 1000,
          infiltrationSharePct: calc.totalUa > 0 ? (calc.infiltrationUa / calc.totalUa) * 100 : 0,
        },
        charts: {
          tempSweep: calc.tempSweep,
          uaBreakdown: calc.breakdown,
        },
      },
    };

    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `house-model-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setImportStatus(t('Exporterade husmodell till JSON.', 'Exported house model to JSON.'));
  };

  const handleImportClick = () => {
    fileInputRef.current?.click();
  };

  const handleImportFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as unknown;
      applyImportedInputs(parsed);
      setImportStatus(t(
        'Importerade husmodell från JSON. Beräknade värden ignorerades och räknas om.',
        'Imported house model from JSON. Calculated values were ignored and recalculated.',
      ));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      setImportStatus(t(`Import misslyckades: ${message}`, `Import failed: ${message}`));
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
      <div className="lg:col-span-1 space-y-4">
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={handleImportFile}
        />
        {activeInfo && infoData ? (
          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">{infoData.title}</CardTitle>
                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setActiveInfo(null)}>
                  <X className="w-4 h-4" />
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              <div className="text-sm text-muted-foreground whitespace-pre-line leading-relaxed prose prose-sm max-w-none">
                {infoData.body.split('\n').map((line, i) => {
                  const rendered = line
                    .replace(/\*\*(.+?)\*\*/g, '<strong class="text-foreground">$1</strong>')
                    .replace(/- /g, '• ');
                  return <p key={i} className="mb-1" dangerouslySetInnerHTML={{ __html: rendered }} />;
                })}
              </div>
            </CardContent>
          </Card>
        ) : null}

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">{t('Import / Export', 'Import / Export')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-col gap-2">
              <Button variant="outline" onClick={handleExportJson}>
                {t('Exportera JSON', 'Export JSON')}
              </Button>
              <Button variant="outline" onClick={handleImportClick}>
                {t('Importera JSON', 'Import JSON')}
              </Button>
            </div>
            <div className="text-xs text-muted-foreground">
              {t(
                'JSON innehåller både indata och beräknade värden. Vid import används endast indata; beräknade värden ignoreras och räknas om.',
                'JSON includes both inputs and calculated values. On import, only inputs are used; calculated values are ignored and recalculated.',
              )}
            </div>
            {importStatus ? (
              <div className="text-xs text-muted-foreground rounded border p-2">
                {importStatus}
              </div>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">{t('Geometri', 'Geometry')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <HouseInfoLabel label={t('Våningsplan', 'Floors')} topic="floors" activeInfo={activeInfo} setActiveInfo={setActiveInfo} />
                <Button type="button" size="sm" variant="outline" onClick={addFloor}>
                  <Plus className="w-3.5 h-3.5 mr-1" />
                  {t('Våning', 'Floor')}
                </Button>
              </div>
              {floors.map((floor, index) => (
                <div key={floor.id} className="rounded border p-2 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <Input
                      value={floor.name}
                      onChange={e => updateFloor(floor.id, { name: e.target.value })}
                      className="h-8"
                      placeholder={t(`Våning ${index + 1}`, `Floor ${index + 1}`)}
                    />
                    {floors.length > 1 ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-destructive"
                        onClick={() => removeFloor(floor.id)}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    ) : null}
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <Label className="text-xs">{t('Area (m²)', 'Area (m²)')}</Label>
                      <Input
                        type="number"
                        value={floor.areaM2}
                        onChange={e => updateFloor(floor.id, { areaM2: Number(e.target.value) || 0 })}
                        className="h-8"
                      />
                    </div>
                    <div>
                      <Label className="text-xs">{t('Takhöjd (m)', 'Ceiling height (m)')}</Label>
                      <Input
                        type="number"
                        step="0.1"
                        value={floor.ceilingHeightM}
                        onChange={e => updateFloor(floor.id, { ceilingHeightM: Number(e.target.value) || 0 })}
                        className="h-8"
                      />
                    </div>
                  </div>
                  <div className="flex items-center justify-between rounded bg-muted/40 px-2 py-1.5">
                    <span className="text-xs">{t('Uppvärmd vintertid', 'Heated in winter')}</span>
                    <Switch
                      checked={floor.heatedInWinter}
                      onCheckedChange={checked => updateFloor(floor.id, { heatedInWinter: checked })}
                    />
                  </div>
                </div>
              ))}
              <div className="text-[11px] text-muted-foreground">
                {t(
                  'Volym och ventilations-UA beräknas från våningar markerade som uppvärmda vintertid.',
                  'Volume and ventilation UA are calculated from floors marked as heated in winter.',
                )}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <HouseInfoLabel label={t('L/B-förhållande', 'L/W ratio')} topic="aspect_ratio" activeInfo={activeInfo} setActiveInfo={setActiveInfo} />
                <Input type="number" step="0.1" value={aspectRatio} onChange={e => setAspectRatio(Number(e.target.value) || 1)} className="h-8" />
              </div>
              <div>
                <HouseInfoLabel label={t('Fönsterandel vägg (%)', 'Window-to-wall (%)')} topic="window_to_wall" activeInfo={activeInfo} setActiveInfo={setActiveInfo} />
                <Input type="number" step="1" value={windowToWallPct} onChange={e => setWindowToWallPct(Number(e.target.value) || 0)} className="h-8" />
              </div>
            </div>
            <div>
              <HouseInfoLabel label={t('Takytfaktor', 'Roof area factor')} topic="roof_area_factor" activeInfo={activeInfo} setActiveInfo={setActiveInfo} />
              <Input type="number" step="0.01" value={roofAreaFactor} onChange={e => setRoofAreaFactor(Number(e.target.value) || 1)} className="h-8" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">{t('Klimatskal', 'Envelope')}</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{t('Väggar', 'Walls')}</p>
              <Select value={wallType} onValueChange={v => { const key = v as WallTypeKey; setWallType(key); setWallStructThicknessMm(WALL_PRESETS[key].defaultThicknessMm); }}>
                <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(WALL_PRESETS).map(([key, p]) => <SelectItem key={key} value={key}>{t(p.labelSv, p.labelEn)}</SelectItem>)}
                </SelectContent>
              </Select>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label className="text-xs">{t('Stomtjocklek (mm)', 'Structure thickness (mm)')}</Label>
                  <Input type="number" value={wallStructThicknessMm} onChange={e => setWallStructThicknessMm(Number(e.target.value) || 0)} className="h-8" />
                </div>
                <div>
                  <Label className="text-xs">{t('Isolering (mm)', 'Insulation (mm)')}</Label>
                  <Input type="number" value={wallInsThicknessMm} onChange={e => setWallInsThicknessMm(Number(e.target.value) || 0)} className="h-8" />
                </div>
              </div>
              <Select value={wallInsType} onValueChange={v => setWallInsType(v as InsulationTypeKey)}>
                <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(INSULATION_PRESETS).map(([key, p]) => <SelectItem key={key} value={key}>{t(p.labelSv, p.labelEn)}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{t('Fönster', 'Windows')}</p>
              <Select value={windowType} onValueChange={v => setWindowType(v as WindowTypeKey)}>
                <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {WINDOW_PRESETS.map(p => <SelectItem key={p.key} value={p.key}>{t(p.labelSv, p.labelEn)} ({p.uWm2K.toFixed(1)} U)</SelectItem>)}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{t('Tak', 'Roof')}</p>
              <Select value={roofType} onValueChange={v => { const key = v as RoofTypeKey; setRoofType(key); setRoofStructThicknessMm(ROOF_PRESETS[key].defaultThicknessMm); }}>
                <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(ROOF_PRESETS).map(([key, p]) => <SelectItem key={key} value={key}>{t(p.labelSv, p.labelEn)}</SelectItem>)}
                </SelectContent>
              </Select>
              <div className="grid grid-cols-2 gap-2">
                <Input type="number" value={roofStructThicknessMm} onChange={e => setRoofStructThicknessMm(Number(e.target.value) || 0)} className="h-8" />
                <Input type="number" value={roofInsThicknessMm} onChange={e => setRoofInsThicknessMm(Number(e.target.value) || 0)} className="h-8" />
              </div>
              <div className="text-[11px] text-muted-foreground">{t('Vänster: stomtjocklek mm, höger: isolering mm', 'Left: structure mm, right: insulation mm')}</div>
              <Select value={roofInsType} onValueChange={v => setRoofInsType(v as InsulationTypeKey)}>
                <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(INSULATION_PRESETS).map(([key, p]) => <SelectItem key={key} value={key}>{t(p.labelSv, p.labelEn)}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{t('Golv / mark', 'Floor / ground')}</p>
              <Select value={floorType} onValueChange={v => { const key = v as FloorTypeKey; setFloorType(key); setFloorStructThicknessMm(FLOOR_PRESETS[key].defaultThicknessMm); }}>
                <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(FLOOR_PRESETS).map(([key, p]) => <SelectItem key={key} value={key}>{t(p.labelSv, p.labelEn)}</SelectItem>)}
                </SelectContent>
              </Select>
              <div className="grid grid-cols-2 gap-2">
                <Input type="number" value={floorStructThicknessMm} onChange={e => setFloorStructThicknessMm(Number(e.target.value) || 0)} className="h-8" />
                <Input type="number" value={floorInsThicknessMm} onChange={e => setFloorInsThicknessMm(Number(e.target.value) || 0)} className="h-8" />
              </div>
              <div className="text-[11px] text-muted-foreground">{t('Vänster: stomtjocklek mm, höger: isolering mm', 'Left: structure mm, right: insulation mm')}</div>
              <Select value={floorInsType} onValueChange={v => setFloorInsType(v as InsulationTypeKey)}>
                <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(INSULATION_PRESETS).map(([key, p]) => <SelectItem key={key} value={key}>{t(p.labelSv, p.labelEn)}</SelectItem>)}
                </SelectContent>
              </Select>
              <div>
                <HouseInfoLabel label={t('Golvens exponeringsfaktor (0-1.5)', 'Floor exposure factor (0-1.5)')} topic="floor_exposure_factor" activeInfo={activeInfo} setActiveInfo={setActiveInfo} />
                <Input type="number" step="0.05" value={floorExposureFactor} onChange={e => setFloorExposureFactor(Number(e.target.value) || 0)} className="h-8" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">{t('Övrigt', 'Other')}</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <div>
                <HouseInfoLabel label={t('ACH (1/h)', 'ACH (1/h)')} topic="ach" activeInfo={activeInfo} setActiveInfo={setActiveInfo} />
                <Input type="number" step="0.05" value={ach} onChange={e => setAch(Number(e.target.value) || 0)} className="h-8" />
              </div>
              <div>
                <HouseInfoLabel label={t('Köldbryggor (%)', 'Thermal bridges (%)')} topic="thermal_bridges" activeInfo={activeInfo} setActiveInfo={setActiveInfo} />
                <Input type="number" step="1" value={thermalBridgePct} onChange={e => setThermalBridgePct(Number(e.target.value) || 0)} className="h-8" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <HouseInfoLabel label={t('Inomhustemp (°C)', 'Indoor temp (°C)')} topic="indoor_temp" activeInfo={activeInfo} setActiveInfo={setActiveInfo} />
                <Input type="number" value={indoorTempC} onChange={e => setIndoorTempC(Number(e.target.value) || 0)} className="h-8" />
              </div>
              <div>
                <HouseInfoLabel label={t('Dimensionerande ute (°C)', 'Design outdoor (°C)')} topic="design_outdoor" activeInfo={activeInfo} setActiveInfo={setActiveInfo} />
                <Input type="number" value={designOutdoorTempC} onChange={e => setDesignOutdoorTempC(Number(e.target.value) || 0)} className="h-8" />
              </div>
            </div>
            <div className="text-xs text-muted-foreground">
              {t(
                'Detta är en förenklad UA-kalkyl (1D ledning + uppskattad infiltration). Använd för riktvärde och kalibrera mot uppmätt data.',
                'This is a simplified UA estimate (1D conduction + estimated infiltration). Use as a starting point and calibrate against measured data.',
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="lg:col-span-3 space-y-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">{t('UA-resultat', 'UA Results')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div className="rounded border p-3">
                <HouseInfoValueLabel label={t('Total UA', 'Total UA')} topic="total_ua" activeInfo={activeInfo} setActiveInfo={setActiveInfo} />
                <div className="text-2xl font-semibold">{Math.round(calc.totalUa)} <span className="text-base font-medium text-muted-foreground">W/K</span></div>
                <div className="text-xs text-muted-foreground mt-1">{t('Detta är värdet att mata in i simulatorn (startvärde).', 'This is the value to enter in the simulator (starting value).')}</div>
              </div>
              <div className="rounded border p-3">
                <HouseInfoValueLabel label={t('Dimensionerande värmeeffekt', 'Design heat load')} topic="design_heat_load" activeInfo={activeInfo} setActiveInfo={setActiveInfo} />
                <div className="text-2xl font-semibold">{(calc.designHeatW / 1000).toFixed(1)} <span className="text-base font-medium text-muted-foreground">kW</span></div>
                <div className="text-xs text-muted-foreground mt-1">ΔT = {Math.max(0, indoorTempC - designOutdoorTempC)} °C</div>
              </div>
              <div className="rounded border p-3">
                <HouseInfoValueLabel label={t('Infiltrationens andel', 'Infiltration share')} topic="infiltration_share" activeInfo={activeInfo} setActiveInfo={setActiveInfo} />
                <div className="text-2xl font-semibold">{calc.totalUa > 0 ? Math.round((calc.infiltrationUa / calc.totalUa) * 100) : 0}<span className="text-base font-medium text-muted-foreground">%</span></div>
                <div className="text-xs text-muted-foreground mt-1">{Math.round(calc.infiltrationUa)} W/K</div>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="rounded border p-3">
                <div className="text-sm font-medium mb-2">{t('Geometri (härledd)', 'Derived Geometry')}</div>
                <div className="space-y-1 text-sm">
                  <div className="flex justify-between"><span className="text-muted-foreground">{t('Antal våningar', 'Floor count')}</span><span>{calc.floorCount}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">{t('Uppvärmda våningar', 'Heated floors')}</span><span>{calc.heatedFloorCount}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">{t('Uppvärmd golvarea', 'Heated floor area')}</span><span>{calc.heatedFloorAreaM2.toFixed(1)} m²</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">{t('Perimeter (summa uppvärmda plan)', 'Perimeter (sum heated floors)')}</span><span>{calc.heatedPerimeterSum.toFixed(1)} m</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">{t('Väggarea brutto', 'Gross wall area')}</span><span>{calc.wallGrossArea.toFixed(1)} m²</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">{t('Fönsterarea', 'Window area')}</span><span>{calc.windowArea.toFixed(1)} m²</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">{t('Väggarea opak', 'Opaque wall area')}</span><span>{calc.wallOpaqueArea.toFixed(1)} m²</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">{t('Takarea (över översta uppvärmda plan)', 'Roof area (above top heated floor)')}</span><span>{calc.roofArea.toFixed(1)} m²</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">{t('Golvarea (under nedersta uppvärmda plan)', 'Floor area (below lowest heated floor)')}</span><span>{calc.floorArea.toFixed(1)} m²</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">{t('Volym', 'Volume')}</span><span>{calc.volumeM3.toFixed(0)} m³</span></div>
                </div>
              </div>

              <div className="rounded border p-3">
                <div className="text-sm font-medium mb-2">{t('U-värden (uppskattade)', 'Estimated U-values')}</div>
                <div className="space-y-1 text-sm">
                  <div className="flex justify-between"><span className="text-muted-foreground">{t('Vägg U', 'Wall U')}</span><span>{calc.wallU.toFixed(2)} W/m²K</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">{t('Fönster U', 'Window U')}</span><span>{calc.windowU.toFixed(2)} W/m²K</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">{t('Tak U', 'Roof U')}</span><span>{calc.roofU.toFixed(2)} W/m²K</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">{t('Golv U (ekv.)', 'Floor U (equiv.)')}</span><span>{calc.floorU.toFixed(2)} W/m²K</span></div>
                  <div className="pt-2 flex flex-wrap gap-2">
                    <Badge variant="outline">{t('Kalibrera sedan mot uppmätt data', 'Calibrate later against measured data')}</Badge>
                  </div>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">{t('UA-fördelning (W/K)', 'UA Breakdown (W/K)')}</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={calc.breakdown}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                <XAxis dataKey="label" className="text-xs" tick={{ fontSize: 11 }} interval={0} angle={-10} textAnchor="end" height={70} />
                <YAxis className="text-xs" />
                <Tooltip formatter={(v: number) => [`${v.toFixed(1)} W/K`, 'UA']} />
                <Bar dataKey="ua" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">{t('Värmeeffekt vs utomhustemperatur', 'Heat Load vs Outdoor Temperature')}</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={calc.tempSweep}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                <XAxis dataKey="tempC" className="text-xs" label={{ value: '°C', position: 'insideBottomRight', offset: -5 }} />
                <YAxis className="text-xs" label={{ value: 'kW', angle: -90, position: 'insideLeft' }} />
                <Tooltip
                  formatter={(value: number) => [`${value.toFixed(1)} kW`, t('Värmeeffekt', 'Heat load')]}
                  labelFormatter={(label: number) => `${label} °C`}
                />
                <Line dataKey="heatKw" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default HouseModelTab;
