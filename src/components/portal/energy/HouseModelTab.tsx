import React, { useMemo, useState } from 'react';
import { Info, X } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
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

const HouseModelTab: React.FC = () => {
  const { t, language } = useLanguage();
  const [activeInfo, setActiveInfo] = useState<HouseInfoTopic | null>(null);

  const [footprintAreaM2, setFootprintAreaM2] = useState(120);
  const [stories, setStories] = useState(2);
  const [ceilingHeightM, setCeilingHeightM] = useState(2.4);
  const [aspectRatio, setAspectRatio] = useState(1.5);
  const [windowToWallPct, setWindowToWallPct] = useState(18);
  const [roofAreaFactor, setRoofAreaFactor] = useState(1.08);

  const [wallType, setWallType] = useState<WallTypeKey>('timber');
  const [wallStructThicknessMm, setWallStructThicknessMm] = useState(WALL_PRESETS.timber.defaultThicknessMm);
  const [wallInsType, setWallInsType] = useState<InsulationTypeKey>('mineral_wool');
  const [wallInsThicknessMm, setWallInsThicknessMm] = useState(170);

  const [windowType, setWindowType] = useState<WindowTypeKey>('double_modern');

  const [roofType, setRoofType] = useState<RoofTypeKey>('attic');
  const [roofStructThicknessMm, setRoofStructThicknessMm] = useState(ROOF_PRESETS.attic.defaultThicknessMm);
  const [roofInsType, setRoofInsType] = useState<InsulationTypeKey>('mineral_wool');
  const [roofInsThicknessMm, setRoofInsThicknessMm] = useState(350);

  const [floorType, setFloorType] = useState<FloorTypeKey>('slab');
  const [floorStructThicknessMm, setFloorStructThicknessMm] = useState(FLOOR_PRESETS.slab.defaultThicknessMm);
  const [floorInsType, setFloorInsType] = useState<InsulationTypeKey>('eps');
  const [floorInsThicknessMm, setFloorInsThicknessMm] = useState(100);
  const [floorExposureFactor, setFloorExposureFactor] = useState(0.55);

  const [ach, setAch] = useState(0.35);
  const [thermalBridgePct, setThermalBridgePct] = useState(10);

  const [indoorTempC, setIndoorTempC] = useState(21);
  const [designOutdoorTempC, setDesignOutdoorTempC] = useState(-15);

  const calc = useMemo(() => {
    const wallPreset = WALL_PRESETS[wallType];
    const roofPreset = ROOF_PRESETS[roofType];
    const floorPreset = FLOOR_PRESETS[floorType];
    const wallIns = INSULATION_PRESETS[wallInsType];
    const roofIns = INSULATION_PRESETS[roofInsType];
    const floorIns = INSULATION_PRESETS[floorInsType];
    const winPreset = WINDOW_PRESETS.find(w => w.key === windowType)!;

    const footprint = safePositive(footprintAreaM2, 1);
    const storyCount = Math.max(1, Math.round(stories));
    const ceilingH = safePositive(ceilingHeightM, 2.4);

    const perimeter = perimeterFromFootprint(footprint, aspectRatio);
    const wallGrossArea = perimeter * ceilingH * storyCount;
    const windowArea = clamp(wallGrossArea * (windowToWallPct / 100), 0, wallGrossArea * 0.8);
    const wallOpaqueArea = Math.max(0, wallGrossArea - windowArea);
    const roofArea = footprint * safePositive(roofAreaFactor, 1);
    const floorArea = footprint;
    const volumeM3 = footprint * storyCount * ceilingH;

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
      perimeter,
      wallGrossArea,
      wallOpaqueArea,
      windowArea,
      roofArea,
      floorArea,
      volumeM3,
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
    footprintAreaM2, stories, ceilingHeightM, aspectRatio, windowToWallPct, roofAreaFactor,
    wallType, wallStructThicknessMm, wallInsType, wallInsThicknessMm,
    windowType,
    roofType, roofStructThicknessMm, roofInsType, roofInsThicknessMm,
    floorType, floorStructThicknessMm, floorInsType, floorInsThicknessMm, floorExposureFactor,
    ach, thermalBridgePct, indoorTempC, designOutdoorTempC,
  ]);

  const infoData = activeInfo ? HOUSE_INFO_CONTENT[activeInfo][language] : null;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
      <div className="lg:col-span-1 space-y-4">
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
            <CardTitle className="text-base">{t('Geometri', 'Geometry')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <HouseInfoLabel label={t('Byggnadsarea / footprint (m²)', 'Footprint area (m²)')} topic="footprint_area" activeInfo={activeInfo} setActiveInfo={setActiveInfo} />
              <Input type="number" value={footprintAreaM2} onChange={e => setFootprintAreaM2(Number(e.target.value) || 0)} className="h-8" />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <HouseInfoLabel label={t('Våningar', 'Stories')} topic="stories" activeInfo={activeInfo} setActiveInfo={setActiveInfo} />
                <Input type="number" value={stories} onChange={e => setStories(Number(e.target.value) || 1)} className="h-8" />
              </div>
              <div>
                <HouseInfoLabel label={t('Takhöjd (m)', 'Ceiling height (m)')} topic="ceiling_height" activeInfo={activeInfo} setActiveInfo={setActiveInfo} />
                <Input type="number" step="0.1" value={ceilingHeightM} onChange={e => setCeilingHeightM(Number(e.target.value) || 0)} className="h-8" />
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
                  <div className="flex justify-between"><span className="text-muted-foreground">{t('Perimeter', 'Perimeter')}</span><span>{calc.perimeter.toFixed(1)} m</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">{t('Väggarea brutto', 'Gross wall area')}</span><span>{calc.wallGrossArea.toFixed(1)} m²</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">{t('Fönsterarea', 'Window area')}</span><span>{calc.windowArea.toFixed(1)} m²</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">{t('Väggarea opak', 'Opaque wall area')}</span><span>{calc.wallOpaqueArea.toFixed(1)} m²</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">{t('Takarea', 'Roof area')}</span><span>{calc.roofArea.toFixed(1)} m²</span></div>
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
