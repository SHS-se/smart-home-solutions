import React, { useEffect, useState, useCallback } from 'react';
import { Loader2, Plus, Save, Trash2, GripVertical, Info, X } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { useLanguage } from '@/contexts/LanguageContext';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

interface FieldDef {
  key: string;
  type: 'text' | 'number';
  required: boolean;
  label: string;
}

interface DeviceType {
  id: string;
  key: string;
  display_name: string;
  field_schema: { fields: FieldDef[] };
  supported_profile_kinds: string[];
  simulation_model_key: string;
}

const PROFILE_KIND_OPTIONS = ['cop_curve', 'capacity_curve', 'load_curve'];

type InfoTopic = 'key' | 'display_name' | 'simulation_model_key' | 'supported_profile_kinds' | 'field_schema';

const INFO_CONTENT: Record<InfoTopic, { sv: { title: string; body: string }; en: { title: string; body: string } }> = {
  key: {
    sv: {
      title: 'Nyckel (Key)',
      body: `**Vad:** En unik, maskinläsbar identifierare för enhetstypen (t.ex. "air_to_air_heat_pump").\n\n**Regler:** Använd snake_case, inga mellanslag. Kan inte ändras efter att typen skapats.\n\n**Hur den används:** Nyckeln är en intern referens som kopplar enhetstypen till simuleringslogik och andra systemdelar. Den visas inte för kunder.`,
    },
    en: {
      title: 'Key',
      body: `**What:** A unique, machine-readable identifier for the device type (e.g. "air_to_air_heat_pump").\n\n**Rules:** Use snake_case, no spaces. Cannot be changed after the type is created.\n\n**How it's used:** The key is an internal reference that links the device type to simulation logic and other system parts. It is not shown to customers.`,
    },
  },
  display_name: {
    sv: {
      title: 'Visningsnamn',
      body: `**Vad:** Det mänskligt läsbara namnet som visas i gränssnittet (t.ex. "Luft-Luft Värmepump").\n\n**Hur den används:** Visas för både personal och kunder i enhetskataloger, formulär och rapporter. Rent informativt – påverkar inte simuleringar.`,
    },
    en: {
      title: 'Display Name',
      body: `**What:** The human-readable name shown in the interface (e.g. "Air-Air Heat Pump").\n\n**How it's used:** Displayed to both staff and customers in device catalogs, forms, and reports. Purely informational – does not affect simulations.`,
    },
  },
  simulation_model_key: {
    sv: {
      title: 'Simuleringsmodellnyckel',
      body: `**Vad:** Kopplar enhetstypen till en specifik beräkningsmotor i simulatorn (t.ex. "heat_pump_aa").\n\n**Hur den används:** När en simulering körs, avgör denna nyckel vilken matematisk modell som används för att beräkna energiförbrukning, COP-kurvor och lastbalanser. Varje modellnyckel motsvarar en unik algoritm i simuleringsmotorn.\n\n**Viktigt:** Ange exakt den nyckel som stöds av simuleringsmotorn. En felaktig nyckel innebär att simuleringar inte kan köras för denna enhetstyp.`,
    },
    en: {
      title: 'Simulation Model Key',
      body: `**What:** Links the device type to a specific calculation engine in the simulator (e.g. "heat_pump_aa").\n\n**How it's used:** When a simulation is run, this key determines which mathematical model is used to compute energy consumption, COP curves, and load balancing. Each model key maps to a unique algorithm in the simulation engine.\n\n**Important:** Enter the exact key supported by the simulation engine. An incorrect key means simulations cannot run for this device type.`,
    },
  },
  supported_profile_kinds: {
    sv: {
      title: 'Profiltyper',
      body: `**Vad:** Anger vilka typer av prestandaprofiler som kan laddas upp för enhetsmallar av denna typ.\n\n**Tillgängliga typer:**\n- **cop_curve** – COP (Coefficient of Performance) som funktion av utomhustemperatur. Används i värmepumpssimuleringar.\n- **capacity_curve** – Värmekapacitet (kW) som funktion av utomhustemperatur. Avgör hur mycket värme enheten kan leverera.\n- **load_curve** – Tidsserie med elförbrukning (W). Används för apparater med kända belastningsmönster (t.ex. tvättmaskiner, diskmaskiner).\n\n**Hur den används:** Styr vilka flikar och uppladdningsalternativ som visas i kalibreringsverktyget. Simulatorn använder den aktiva profilen vid beräkningar.`,
    },
    en: {
      title: 'Supported Profile Kinds',
      body: `**What:** Specifies which types of performance profiles can be uploaded for device templates of this type.\n\n**Available types:**\n- **cop_curve** – COP (Coefficient of Performance) as a function of outdoor temperature. Used in heat pump simulations.\n- **capacity_curve** – Heating capacity (kW) as a function of outdoor temperature. Determines how much heat the device can deliver.\n- **load_curve** – Time series of electrical consumption (W). Used for appliances with known load patterns (e.g. washing machines, dishwashers).\n\n**How it's used:** Controls which tabs and upload options appear in the calibration tool. The simulator uses the active profile for calculations.`,
    },
  },
  field_schema: {
    sv: {
      title: 'Fältschema',
      body: `**Vad:** Definierar vilka datafält som ska fyllas i för varje enhet av denna typ.\n\n**Fältegenskaper:**\n- **Nyckel** – Internt namn (snake_case), används som referens i kod och simuleringar.\n- **Etikett** – Visningsnamn som kunder och personal ser i formulär.\n- **Typ** – "Text" för fritext eller "Number" för numeriska värden.\n- **Obligatoriskt** – Om fältet måste fyllas i vid skapande av enhet.\n\n**Hur den används:** Fältschemat genererar dynamiska formulär i enhetskataloger och hemprofiler. Numeriska fält med kända nycklar (t.ex. "max_input_power_w", "scop") används direkt av simuleringsmotorn. Textfält (t.ex. "make", "model") är informativa och visas i rapporter.\n\n**Ordning:** Dra fälten för att ändra ordningen – detta avgör visningsordningen i formulär.`,
    },
    en: {
      title: 'Field Schema',
      body: `**What:** Defines which data fields must be filled in for each device of this type.\n\n**Field properties:**\n- **Key** – Internal name (snake_case), used as reference in code and simulations.\n- **Label** – Display name that customers and staff see in forms.\n- **Type** – "Text" for free text or "Number" for numeric values.\n- **Required** – Whether the field must be completed when creating a device.\n\n**How it's used:** The field schema generates dynamic forms in device catalogs and home profiles. Numeric fields with known keys (e.g. "max_input_power_w", "scop") are used directly by the simulation engine. Text fields (e.g. "make", "model") are informational and shown in reports.\n\n**Ordering:** Drag fields to change their order – this determines the display order in forms.`,
    },
  },
};

/* ── Sortable field row ── */
interface SortableFieldRowProps {
  field: FieldDef;
  idx: number;
  total: number;
  onUpdate: (idx: number, patch: Partial<FieldDef>) => void;
  onRemove: (idx: number) => void;
  t: (sv: string, en: string) => string;
}

function SortableFieldRow({ field, idx, total, onUpdate, onRemove, t }: SortableFieldRowProps) {
  const id = `field-${idx}`;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div ref={setNodeRef} style={style} className="flex items-center gap-2 p-2 rounded border border-border">
      <button type="button" className="cursor-grab touch-none" {...attributes} {...listeners}>
        <GripVertical className="w-4 h-4 text-muted-foreground flex-shrink-0" />
      </button>
      <Input className="flex-1" value={field.key} onChange={e => onUpdate(idx, { key: e.target.value })} placeholder={t('Nyckel', 'Key')} />
      <Input className="flex-1" value={field.label} onChange={e => onUpdate(idx, { label: e.target.value })} placeholder={t('Etikett', 'Label')} />
      <Select value={field.type} onValueChange={v => onUpdate(idx, { type: v as 'text' | 'number' })}>
        <SelectTrigger className="w-24"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="text">Text</SelectItem>
          <SelectItem value="number">Number</SelectItem>
        </SelectContent>
      </Select>
      <div className="flex items-center gap-1">
        <Switch checked={field.required} onCheckedChange={v => onUpdate(idx, { required: v })} />
        <span className="text-xs text-muted-foreground">{t('Obligatoriskt', 'Required')}</span>
      </div>
      {total > 1 && (
        <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => onRemove(idx)}>
          <Trash2 className="w-3.5 h-3.5" />
        </Button>
      )}
    </div>
  );
}

/* ── Info heading helper ── */
function InfoLabel({ label, topic, activeInfo, setActiveInfo }: {
  label: string;
  topic: InfoTopic;
  activeInfo: InfoTopic | null;
  setActiveInfo: (t: InfoTopic | null) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <Label className="text-sm">{label}</Label>
      <button
        type="button"
        onClick={() => setActiveInfo(activeInfo === topic ? null : topic)}
        className={`rounded-full p-0.5 transition-colors ${activeInfo === topic ? 'text-primary' : 'text-muted-foreground hover:text-foreground'}`}
      >
        <Info className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

/* ── Main component ── */
const DeviceTypesManager: React.FC = () => {
  const { t, language } = useLanguage();
  const { toast } = useToast();
  const [types, setTypes] = useState<DeviceType[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [selected, setSelected] = useState<DeviceType | null>(null);
  const [activeInfo, setActiveInfo] = useState<InfoTopic | null>(null);

  const [form, setForm] = useState({
    key: '',
    display_name: '',
    simulation_model_key: '',
    supported_profile_kinds: [] as string[],
    fields: [{ key: '', type: 'text' as 'text' | 'number', required: true, label: '' }],
  });

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const fetchTypes = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase.from('device_types').select('*').order('display_name');
    if (data) {
      setTypes(data.map(d => ({
        ...d,
        field_schema: d.field_schema as any,
        supported_profile_kinds: d.supported_profile_kinds as any,
      })));
    }
    setLoading(false);
  }, []);

  useEffect(() => { fetchTypes(); }, [fetchTypes]);

  const handleSelect = (dt: DeviceType) => {
    setSelected(dt);
    setActiveInfo(null);
    setForm({
      key: dt.key,
      display_name: dt.display_name,
      simulation_model_key: dt.simulation_model_key,
      supported_profile_kinds: dt.supported_profile_kinds,
      fields: dt.field_schema.fields.length > 0 ? dt.field_schema.fields : [{ key: '', type: 'text', required: true, label: '' }],
    });
  };

  const handleNew = () => {
    setSelected(null);
    setActiveInfo(null);
    setForm({
      key: '', display_name: '', simulation_model_key: '',
      supported_profile_kinds: [],
      fields: [{ key: '', type: 'text', required: true, label: '' }],
    });
  };

  const handleSave = async () => {
    if (!form.key.trim() || !form.display_name.trim() || !form.simulation_model_key.trim()) return;
    const validFields = form.fields.filter(f => f.key.trim() && f.label.trim());
    if (validFields.length === 0) return;

    setSaving(true);
    try {
      const payload = {
        key: form.key.trim(),
        display_name: form.display_name.trim(),
        simulation_model_key: form.simulation_model_key.trim(),
        supported_profile_kinds: form.supported_profile_kinds,
        field_schema: { fields: validFields },
      };

      if (selected) {
        const { error } = await supabase.from('device_types').update(payload).eq('id', selected.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from('device_types').insert(payload);
        if (error) throw error;
      }
      toast({ title: t('Sparat!', 'Saved!') });
      fetchTypes();
    } catch (err: any) {
      toast({ title: t('Fel', 'Error'), description: err.message, variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!selected || !confirm(t('Ta bort denna enhetstyp?', 'Delete this device type?'))) return;
    const { error } = await supabase.from('device_types').delete().eq('id', selected.id);
    if (error) {
      toast({ title: t('Fel', 'Error'), description: error.message, variant: 'destructive' });
    } else {
      toast({ title: t('Borttagen!', 'Deleted!') });
      setSelected(null);
      handleNew();
      fetchTypes();
    }
  };

  const addField = () => {
    setForm(f => ({ ...f, fields: [...f.fields, { key: '', type: 'text', required: false, label: '' }] }));
  };

  const removeField = (idx: number) => {
    setForm(f => ({ ...f, fields: f.fields.filter((_, i) => i !== idx) }));
  };

  const updateField = (idx: number, patch: Partial<FieldDef>) => {
    setForm(f => ({
      ...f,
      fields: f.fields.map((field, i) => i === idx ? { ...field, ...patch } : field),
    }));
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = form.fields.findIndex((_, i) => `field-${i}` === active.id);
    const newIndex = form.fields.findIndex((_, i) => `field-${i}` === over.id);
    if (oldIndex !== -1 && newIndex !== -1) {
      setForm(f => ({ ...f, fields: arrayMove(f.fields, oldIndex, newIndex) }));
    }
  };

  const toggleProfileKind = (kind: string) => {
    setForm(f => ({
      ...f,
      supported_profile_kinds: f.supported_profile_kinds.includes(kind)
        ? f.supported_profile_kinds.filter(k => k !== kind)
        : [...f.supported_profile_kinds, kind],
    }));
  };

  if (loading) {
    return <div className="flex items-center justify-center min-h-[300px]"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>;
  }

  const infoData = activeInfo ? INFO_CONTENT[activeInfo][language] : null;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      {/* List – hidden when info panel is open */}
      {!activeInfo && <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">{t('Enhetstyper', 'Device Types')}</CardTitle>
            <Button size="sm" variant="outline" onClick={handleNew}><Plus className="w-3.5 h-3.5 mr-1" />{t('Ny', 'New')}</Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-1 max-h-[500px] overflow-y-auto">
          {types.map(dt => (
            <div
              key={dt.id}
              className={`p-2 rounded cursor-pointer flex items-center justify-between ${selected?.id === dt.id ? 'bg-muted' : 'hover:bg-muted/50'}`}
              onClick={() => handleSelect(dt)}
            >
              <div>
                <p className="text-sm font-medium">{dt.display_name}</p>
                <p className="text-xs text-muted-foreground">{dt.key}</p>
              </div>
              <Badge variant="outline" className="text-xs">{dt.field_schema.fields.length} {t('fält', 'fields')}</Badge>
            </div>
          ))}
        </CardContent>
      </Card>}

      {/* Form */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">{selected ? t('Redigera typ', 'Edit Type') : t('Ny typ', 'New Type')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <InfoLabel label={t('Nyckel', 'Key')} topic="key" activeInfo={activeInfo} setActiveInfo={setActiveInfo} />
              <Input value={form.key} onChange={e => setForm(f => ({ ...f, key: e.target.value }))} placeholder="e.g. air_to_air_heat_pump" disabled={!!selected} />
            </div>
            <div>
              <InfoLabel label={t('Visningsnamn', 'Display Name')} topic="display_name" activeInfo={activeInfo} setActiveInfo={setActiveInfo} />
              <Input value={form.display_name} onChange={e => setForm(f => ({ ...f, display_name: e.target.value }))} />
            </div>
          </div>
          <div>
            <InfoLabel label={t('Simuleringsmodell', 'Simulation Model Key')} topic="simulation_model_key" activeInfo={activeInfo} setActiveInfo={setActiveInfo} />
            <Input value={form.simulation_model_key} onChange={e => setForm(f => ({ ...f, simulation_model_key: e.target.value }))} placeholder="e.g. heat_pump_aa" />
          </div>

          <div>
            <InfoLabel label={t('Profiltyper', 'Supported Profile Kinds')} topic="supported_profile_kinds" activeInfo={activeInfo} setActiveInfo={setActiveInfo} />
            <div className="flex flex-wrap gap-2 mt-1">
              {PROFILE_KIND_OPTIONS.map(kind => (
                <Badge
                  key={kind}
                  variant={form.supported_profile_kinds.includes(kind) ? 'default' : 'outline'}
                  className="cursor-pointer"
                  onClick={() => toggleProfileKind(kind)}
                >
                  {kind}
                </Badge>
              ))}
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <InfoLabel label={t('Fältschema', 'Field Schema')} topic="field_schema" activeInfo={activeInfo} setActiveInfo={setActiveInfo} />
              <Button size="sm" variant="outline" onClick={addField}><Plus className="w-3 h-3 mr-1" />{t('Fält', 'Field')}</Button>
            </div>
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
              <SortableContext items={form.fields.map((_, i) => `field-${i}`)} strategy={verticalListSortingStrategy}>
                <div className="space-y-2">
                  {form.fields.map((field, idx) => (
                    <SortableFieldRow
                      key={`field-${idx}`}
                      field={field}
                      idx={idx}
                      total={form.fields.length}
                      onUpdate={updateField}
                      onRemove={removeField}
                      t={t}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          </div>

          <div className="flex gap-2">
            <Button onClick={handleSave} disabled={saving || !form.key.trim() || !form.display_name.trim()} className="flex-1">
              {saving && <Loader2 className="w-4 h-4 animate-spin mr-2" />}
              <Save className="w-4 h-4 mr-2" /> {t('Spara', 'Save')}
            </Button>
            {selected && (
              <Button variant="destructive" size="icon" onClick={handleDelete}>
                <Trash2 className="w-4 h-4" />
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Info panel */}
      {activeInfo && infoData && (
        <Card className="lg:col-span-1">
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
      )}
    </div>
  );
};

export default DeviceTypesManager;
