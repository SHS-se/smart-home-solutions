import { Link } from 'react-router-dom';
import { ArrowLeft, Clock, TrendingDown, Zap, AlertTriangle } from 'lucide-react';
import { useLanguage } from '@/contexts/LanguageContext';
import Layout from '@/components/Layout';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceArea } from 'recharts';
import waterBoilerChartImage from '@/assets/water-boiler-chart.png';
import washingMachineChartImage from '@/assets/washing-machine-chart.png';
import tumbleDryerChartImage from '@/assets/tumble-dryer-chart.png';
import heatPumpChartImage from '@/assets/heat-pump-chart.png';
import stoveChartImage from '@/assets/stove-chart.png';
import dishwasherChartImage from '@/assets/dishwasher-chart.png';
import evChargerChartImage from '@/assets/ev-charger-chart.png';

// Washing machine power consumption data (realistic pattern based on real measurements)
// Shows: heating phase (~2kW), washing (~100-200W), rinse cycles, spin cycles (~200-300W)
const washingMachineData = [
  // Pre-start
  { time: '12:10', power: 0 },
  { time: '12:12', power: 10 },
  { time: '12:14', power: 15 },
  { time: '12:16', power: 20 },
  { time: '12:18', power: 25 },
  // Heating phase starts - massive spike
  { time: '12:20', power: 1850 },
  { time: '12:22', power: 1950 },
  { time: '12:24', power: 2000 },
  { time: '12:26', power: 2050 },
  { time: '12:28', power: 2000 },
  { time: '12:30', power: 2020 },
  { time: '12:32', power: 1980 },
  { time: '12:34', power: 2000 },
  { time: '12:36', power: 1900 },
  // Heating ends, washing begins
  { time: '12:38', power: 150 },
  { time: '12:40', power: 120 },
  { time: '12:42', power: 100 },
  { time: '12:44', power: 130 },
  { time: '12:46', power: 110 },
  { time: '12:48', power: 140 },
  { time: '12:50', power: 100 },
  { time: '12:52', power: 120 },
  { time: '12:54', power: 90 },
  { time: '12:56', power: 110 },
  { time: '12:58', power: 100 },
  { time: '13:00', power: 130 },
  { time: '13:05', power: 100 },
  { time: '13:10', power: 120 },
  { time: '13:15', power: 90 },
  { time: '13:20', power: 100 },
  { time: '13:25', power: 80 },
  { time: '13:30', power: 70 },
  { time: '13:35', power: 60 },
  { time: '13:40', power: 50 },
  // Rinse cycle starts
  { time: '13:45', power: 180 },
  { time: '13:50', power: 200 },
  { time: '13:55', power: 220 },
  { time: '14:00', power: 250 },
  { time: '14:05', power: 280 },
  { time: '14:10', power: 300 },
  { time: '14:15', power: 280 },
  { time: '14:20', power: 260 },
  { time: '14:25', power: 300 },
  { time: '14:30', power: 320 },
  { time: '14:35', power: 280 },
  { time: '14:40', power: 300 },
  { time: '14:45', power: 250 },
  { time: '14:50', power: 200 },
];

// Tumble dryer power consumption data (realistic pattern based on real measurements)
// Shows: brief startup, gradual ramp-up to ~700W, sustained heating, cool-down tumbling
const tumbleDryerData = [
  { time: '10:55', power: 0 },
  // Brief startup spike
  { time: '10:57', power: 200 },
  { time: '10:58', power: 170 },
  // Ramp up heating
  { time: '11:00', power: 530 },
  { time: '11:02', power: 550 },
  { time: '11:04', power: 580 },
  { time: '11:06', power: 600 },
  { time: '11:08', power: 620 },
  { time: '11:10', power: 630 },
  { time: '11:12', power: 650 },
  { time: '11:14', power: 640 },
  { time: '11:16', power: 660 },
  { time: '11:18', power: 700 },
  { time: '11:20', power: 690 },
  // Brief dip
  { time: '11:22', power: 500 },
  { time: '11:23', power: 190 },
  // Back up for final heating
  { time: '11:24', power: 550 },
  { time: '11:25', power: 680 },
  { time: '11:26', power: 700 },
  { time: '11:27', power: 710 },
  // Cool-down/tumbling phase
  { time: '11:28', power: 170 },
  { time: '11:30', power: 160 },
  { time: '11:32', power: 170 },
  { time: '11:34', power: 160 },
  { time: '11:36', power: 170 },
  { time: '11:38', power: 160 },
  { time: '11:40', power: 170 },
];

// Heat pump (luft-luft värmepump) power consumption data
// Shows: startup spike (~2.2kW), normal operation (~0.8-1.4kW), defrost cycle spike (~2.2kW)
const heatPumpData = [
  { time: '04:30', power: 0 },
  { time: '04:32', power: 500 },
  // Startup spike
  { time: '04:34', power: 1500 },
  { time: '04:35', power: 2100 },
  { time: '04:36', power: 2200 },
  { time: '04:37', power: 1300 },
  { time: '04:38', power: 1100 },
  { time: '04:40', power: 1050 },
  { time: '04:42', power: 1100 },
  { time: '04:44', power: 1150 },
  { time: '04:46', power: 1300 },
  { time: '04:48', power: 1350 },
  { time: '04:50', power: 1400 },
  { time: '04:52', power: 1350 },
  { time: '04:54', power: 1300 },
  { time: '04:56', power: 1000 },
  { time: '04:58', power: 950 },
  { time: '05:00', power: 900 },
  // Brief pause/low period
  { time: '05:02', power: 100 },
  { time: '05:04', power: 50 },
  { time: '05:06', power: 300 },
  { time: '05:08', power: 500 },
  { time: '05:10', power: 700 },
  { time: '05:12', power: 800 },
  { time: '05:14', power: 850 },
  { time: '05:16', power: 900 },
  // Defrost cycle spike
  { time: '05:18', power: 1500 },
  { time: '05:19', power: 2100 },
  { time: '05:20', power: 2200 },
  { time: '05:21', power: 2150 },
  { time: '05:22', power: 1400 },
  { time: '05:24', power: 1000 },
  { time: '05:26', power: 700 },
  { time: '05:28', power: 1000 },
  { time: '05:30', power: 1100 },
  { time: '05:32', power: 900 },
  { time: '05:34', power: 950 },
  { time: '05:36', power: 900 },
  { time: '05:38', power: 880 },
];

// Stove top power consumption data (realistic pattern based on real measurements)
// Shows: initial high-power heating (~1.7kW), then cycling to maintain temperature (~800W)
const stoveTopData = [
  { time: '19:04', power: 0 },
  { time: '19:05', power: 0 },
  { time: '19:06', power: 0 },
  // Initial heating - high power
  { time: '19:07', power: 1700 },
  { time: '19:08', power: 1720 },
  { time: '19:09', power: 1700 },
  { time: '19:10', power: 1710 },
  { time: '19:11', power: 1300 },
  // Drop to maintenance power
  { time: '19:12', power: 850 },
  { time: '19:13', power: 840 },
  { time: '19:14', power: 850 },
  { time: '19:15', power: 830 },
  { time: '19:16', power: 850 },
  { time: '19:17', power: 820 },
  { time: '19:18', power: 840 },
  { time: '19:19', power: 800 },
  { time: '19:20', power: 820 },
  // Turn off
  { time: '19:21', power: 0 },
];

// Dishwasher power consumption data (realistic pattern based on real measurements)
// Shows: multiple heating cycles (~2kW) for wash, rinse, and drying phases
const dishwasherData = [
  { time: '20:55', power: 0 },
  { time: '21:00', power: 50 },
  // First heating cycle - main wash
  { time: '21:02', power: 2000 },
  { time: '21:04', power: 2050 },
  { time: '21:06', power: 2000 },
  { time: '21:08', power: 2020 },
  { time: '21:10', power: 1950 },
  { time: '21:12', power: 50 },
  { time: '21:14', power: 30 },
  // Second heating cycle - rinse
  { time: '21:16', power: 2000 },
  { time: '21:18', power: 2050 },
  { time: '21:20', power: 2000 },
  { time: '21:22', power: 50 },
  { time: '21:25', power: 30 },
  { time: '21:30', power: 50 },
  // Third heating cycle
  { time: '21:35', power: 2000 },
  { time: '21:38', power: 1980 },
  { time: '21:40', power: 2000 },
  { time: '21:42', power: 1950 },
  { time: '21:45', power: 1980 },
  { time: '21:48', power: 50 },
  // Low power period
  { time: '21:55', power: 30 },
  { time: '22:00', power: 50 },
  { time: '22:05', power: 30 },
  { time: '22:10', power: 50 },
  { time: '22:15', power: 30 },
  { time: '22:20', power: 50 },
  // Drying cycle
  { time: '22:25', power: 1900 },
  { time: '22:28', power: 1950 },
  { time: '22:30', power: 2000 },
  { time: '22:32', power: 1980 },
  { time: '22:35', power: 2000 },
  { time: '22:38', power: 1950 },
  { time: '22:40', power: 1900 },
  { time: '22:42', power: 1850 },
  { time: '22:45', power: 50 },
  { time: '22:48', power: 0 },
];

// Electric water boiler power consumption data (realistic pattern based on real measurements)
// Shows: thin maintenance spikes throughout day, one wide bar after morning shower
const waterBoilerData = [
  { time: '00:00', power: 0 },
  // Thin maintenance spike - night
  { time: '02:00', power: 0 },
  { time: '02:02', power: 3000 },
  { time: '02:04', power: 0 },
  { time: '04:00', power: 0 },
  // Thin maintenance spike - early morning
  { time: '05:00', power: 0 },
  { time: '05:02', power: 3000 },
  { time: '05:04', power: 0 },
  { time: '06:00', power: 0 },
  { time: '07:00', power: 0 },
  // WIDE BAR - Post-shower recovery (significantly wider than others)
  { time: '07:30', power: 0 },
  { time: '07:32', power: 3000 },
  { time: '08:30', power: 3000 },
  { time: '08:32', power: 0 },
  { time: '09:00', power: 0 },
  // Thin maintenance spike - late morning
  { time: '11:00', power: 0 },
  { time: '11:02', power: 3000 },
  { time: '11:04', power: 0 },
  { time: '12:00', power: 0 },
  // Thin maintenance spike - afternoon
  { time: '14:00', power: 0 },
  { time: '14:02', power: 3000 },
  { time: '14:04', power: 0 },
  { time: '15:00', power: 0 },
  { time: '16:00', power: 0 },
  // Thin maintenance spike - evening
  { time: '17:00', power: 0 },
  { time: '17:02', power: 3000 },
  { time: '17:04', power: 0 },
  { time: '18:00', power: 0 },
  // Thin maintenance spike - night
  { time: '20:00', power: 0 },
  { time: '20:02', power: 3000 },
  { time: '20:04', power: 0 },
  { time: '21:00', power: 0 },
  // Thin maintenance spike - late night
  { time: '22:00', power: 0 },
  { time: '22:02', power: 3000 },
  { time: '22:04', power: 0 },
  { time: '23:59', power: 0 },
];

// EV charger power consumption data (11kW charger, realistic pattern based on real measurements)
// Shows: sustained high-power charging (~10-10.5kW) over several hours
const evChargerData = [
  { time: '21:00', power: 0 },
  { time: '21:30', power: 0 },
  { time: '22:00', power: 0 },
  // Charging starts
  { time: '22:30', power: 10200 },
  { time: '22:45', power: 10300 },
  { time: '23:00', power: 10400 },
  { time: '23:15', power: 10350 },
  { time: '23:30', power: 10400 },
  { time: '23:45', power: 10350 },
  { time: '00:00', power: 10400 },
  { time: '00:15', power: 10500 },
  { time: '00:30', power: 10400 },
  { time: '00:45', power: 10350 },
  { time: '01:00', power: 10400 },
  { time: '01:15', power: 10500 },
  { time: '01:30', power: 10400 },
  { time: '01:45', power: 10500 },
  { time: '02:00', power: 10400 },
  // Charging ends
  { time: '02:15', power: 0 },
  { time: '02:30', power: 0 },
];

const LastbalanseringArticle = () => {
  const { t } = useLanguage();

  return (
    <Layout>
      {/* Hero */}
      <section className="py-12 md:py-16 hero-gradient">
        <div className="container mx-auto">
          <Link 
            to="/knowledge" 
            className="inline-flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors mb-6"
          >
            <ArrowLeft className="w-4 h-4" />
            {t('Tillbaka till Kunskapscenter', 'Back to Knowledge Center')}
          </Link>
          
          <div className="flex items-center gap-3 mb-4">
            <span className="bg-energy px-3 py-1 rounded-full text-sm font-medium text-foreground/80">
              {t('Automation', 'Automation')}
            </span>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Clock className="w-4 h-4" />
              <span>10 min {t('läsning', 'read')}</span>
            </div>
          </div>
          
          <h1 className="text-foreground mb-4">
            {t('Hur lastbalansering verkligen fungerar', 'How Load Balancing Actually Works')}
          </h1>
          <p className="text-lg text-muted-foreground max-w-3xl">
            {t(
              'De vanliga tipsen om att "sprida ut förbrukningen" är lättare sagda än gjorda. Här visar vi med riktig data varför det är svårare än du tror – och hur smart hemautomation faktiskt kan lösa problemet.',
              'The typical advice about "spreading out consumption" is easier said than done. Here we show with real data why it\'s harder than you think – and how smart home automation can actually solve the problem.'
            )}
          </p>
        </div>
      </section>

      {/* Article Content */}
      <section className="py-12 md:py-16">
        <div className="container mx-auto max-w-4xl">
          
          {/* Introduction */}
          <div className="prose prose-lg max-w-none mb-12">
            <p className="text-muted-foreground leading-relaxed text-lg">
              {t(
                'I vår tidigare artikel om effektavgift presenterade vi de "typiska råden" – undvik att köra diskmaskin och tvättmaskin samtidigt, ladda elbilen på natten, etc. Men hur ser det egentligen ut när dina hushållsapparater körs? Och varför är det så svårt att följa dessa råd i praktiken?',
                'In our previous article about effektavgift, we presented the "typical advice" – avoid running the dishwasher and washing machine at the same time, charge your EV at night, etc. But what does it actually look like when your household appliances run? And why is it so hard to follow this advice in practice?'
              )}
            </p>
          </div>

          {/* The Problem Section */}
          <section className="mb-12">
            <h2 className="text-2xl font-medium text-foreground mb-4">
              {t('Problemet: Du vet inte vad som drar ström', 'The Problem: You Don\'t Know What Draws Power')}
            </h2>
            
            <p className="text-muted-foreground leading-relaxed mb-6">
              {t(
                'Det första hindret för att minska din effekttopp är brist på information. De flesta vet inte hur mycket ström deras apparater faktiskt drar – eller när de gör det. Låt oss titta på en tvättmaskin som exempel.',
                'The first obstacle to reducing your power peak is lack of information. Most people don\'t know how much power their appliances actually draw – or when they do it. Let\'s look at a washing machine as an example.'
              )}
            </p>
          </section>

          {/* Washing Machine Chart */}
          <section className="mb-12">
            <h3 className="text-xl font-medium text-foreground mb-4">
              {t('Tvättmaskin: Verklig förbrukningsdata', 'Washing Machine: Real Consumption Data')}
            </h3>
            
            <div className="bg-card border border-border rounded-xl p-6 mb-6">
              <div className="flex justify-center">
                <img 
                  src={washingMachineChartImage} 
                  alt={t('Tvättmaskin effektförbrukning', 'Washing machine power consumption')}
                  className="max-w-full h-auto rounded-lg"
                />
              </div>
            </div>

            {/* Key insight */}
            <div className="mb-6">
              <h4 className="font-medium text-foreground mb-2">
                {t('Insikt: Uppvärmningen är boven', 'Insight: Heating is the culprit')}
              </h4>
              <p className="text-muted-foreground leading-relaxed">
                {t(
                  'Under cirka 15 minuter drar tvättmaskinen nästan 2 kW för att värma vattnet. Resten av tvättprogrammet (1,5–2 timmar) drar bara 100–300 W. Om du startar tvättmaskinen samtidigt som elbilsladdningen körs med 7 kW, har du plötsligt en topp på nästan 9 kW – bara från två apparater.',
                  'For about 15 minutes, the washing machine draws almost 2 kW to heat the water. The rest of the wash cycle (1.5–2 hours) only draws 100–300 W. If you start the washing machine while EV charging is running at 7 kW, you suddenly have a peak of almost 9 kW – from just two appliances.'
                )}
              </p>
            </div>

            <p className="text-muted-foreground leading-relaxed">
              {t(
                'Det här är något som de typiska råden inte berättar. "Kör inte tvättmaskin och diskmaskin samtidigt" låter enkelt, men problemet är att du inte vet exakt när uppvärmningsfasen sker, eller hur lång tid den tar. Och du kan knappast stå och vänta vid tvättmaskinen för att se när den är klar med uppvärmningen.',
                'This is something the typical advice doesn\'t tell you. "Don\'t run the washing machine and dishwasher at the same time" sounds simple, but the problem is you don\'t know exactly when the heating phase occurs, or how long it takes. And you can hardly stand and wait by the washing machine to see when it\'s done heating.'
              )}
            </p>
          </section>

          {/* Tumble Dryer Chart */}
          <section className="mb-12">
            <h3 className="text-xl font-medium text-foreground mb-4">
              {t('Torktumlare: Verklig förbrukningsdata', 'Tumble Dryer: Real Consumption Data')}
            </h3>
            
            <div className="bg-card border border-border rounded-xl p-6 mb-6">
              <div className="flex justify-center">
                <img 
                  src={tumbleDryerChartImage} 
                  alt={t('Torktumlare effektförbrukning', 'Tumble dryer power consumption')}
                  className="max-w-full h-auto rounded-lg"
                />
              </div>
            </div>

            {/* Key insight */}
            <div className="mb-6">
              <h4 className="font-medium text-foreground mb-2">
                {t('Insikt: Långvarig belastning', 'Insight: Prolonged load')}
              </h4>
              <p className="text-muted-foreground leading-relaxed">
                {t(
                  'Till skillnad från tvättmaskinen drar torktumlaren högt effekt under hela programmet – ofta 2-3 timmar. Det är inte en kort topp utan en lång, kontinuerlig belastning på 700-800 W. Om du kör torktumlaren samtidigt som annan utrustning, adderas denna effekt under hela tiden.',
                  'Unlike the washing machine, the tumble dryer draws high power throughout the entire program – often 2-3 hours. It\'s not a short peak but a long, continuous load of 700-800 W. If you run the dryer alongside other equipment, this power adds up the entire time.'
                )}
              </p>
            </div>
          </section>

          {/* Heat Pump Chart */}
          <section className="mb-12">
            <h3 className="text-xl font-medium text-foreground mb-4">
              {t('Luft-luft värmepump: Verklig förbrukningsdata', 'Air-to-Air Heat Pump: Real Consumption Data')}
            </h3>
            
            <div className="bg-card border border-border rounded-xl p-6 mb-6">
              <div className="flex justify-center">
                <img 
                  src={heatPumpChartImage} 
                  alt={t('Värmepump effektförbrukning', 'Heat pump power consumption')}
                  className="max-w-full h-auto rounded-lg"
                />
              </div>
            </div>

            {/* Key insight */}
            <div className="mb-6">
              <h4 className="font-medium text-foreground mb-2">
                {t('Insikt: Oförutsägbara toppar', 'Insight: Unpredictable peaks')}
              </h4>
              <p className="text-muted-foreground leading-relaxed">
                {t(
                  'Värmepumpen startar och avfrostar när den behöver – inte när du vill. Under vintern kan avfrostningscykler inträffa flera gånger om dagen, varje gång med en topp på över 2 kW. Om detta händer samtidigt som du laddar elbilen eller kör tvättmaskinen, kan du få en oväntad effekttopp som påverkar din effektavgift.',
                  'The heat pump starts and defrosts when it needs to – not when you want it to. During winter, defrost cycles can occur several times a day, each time with a peak over 2 kW. If this happens while you\'re charging your EV or running the washing machine, you can get an unexpected power peak that affects your effektavgift.'
                )}
              </p>
            </div>
          </section>

          {/* Stove Top Chart */}
          <section className="mb-12">
            <h3 className="text-xl font-medium text-foreground mb-4">
              {t('Spishäll: Verklig förbrukningsdata', 'Stove Top: Real Consumption Data')}
            </h3>
            
            <div className="bg-card border border-border rounded-xl p-6 mb-6">
              <div className="flex justify-center">
                <img 
                  src={stoveChartImage} 
                  alt={t('Spishäll effektförbrukning', 'Stove top power consumption')}
                  className="max-w-full h-auto rounded-lg"
                />
              </div>
            </div>

            {/* Key insight */}
            <div className="mb-6">
              <h4 className="font-medium text-foreground mb-2">
                {t('Insikt: Matlagning sker på kvällstid', 'Insight: Cooking happens in the evening')}
              </h4>
              <p className="text-muted-foreground leading-relaxed">
                {t(
                  'De flesta lagar mat mellan 17:00-19:00 – precis under kvällens höglasttid. En spishäll kan dra 1.5-2 kW per platta. Om du använder två plattor samtidigt som ugnen körs, kan du lätt nå 5-6 kW bara från matlagning. Lägg till elbilsladdning och du har snabbt en betydande effekttopp.',
                  'Most people cook between 17:00-19:00 – right during the evening peak hours. A stove top can draw 1.5-2 kW per burner. If you use two burners while the oven is running, you can easily reach 5-6 kW just from cooking. Add EV charging and you quickly have a significant power peak.'
                )}
              </p>
            </div>
          </section>

          {/* Dishwasher Chart */}
          <section className="mb-12">
            <h3 className="text-xl font-medium text-foreground mb-4">
              {t('Diskmaskin: Verklig förbrukningsdata', 'Dishwasher: Real Consumption Data')}
            </h3>
            
            <div className="bg-card border border-border rounded-xl p-6 mb-6">
              <div className="flex justify-center">
                <img 
                  src={dishwasherChartImage} 
                  alt={t('Diskmaskin effektförbrukning', 'Dishwasher power consumption')}
                  className="max-w-full h-auto rounded-lg"
                />
              </div>
            </div>

            {/* Key insight */}
            <div className="mb-6">
              <h4 className="font-medium text-foreground mb-2">
                {t('Insikt: Flera oförutsägbara toppar', 'Insight: Multiple unpredictable peaks')}
              </h4>
              <p className="text-muted-foreground leading-relaxed">
                {t(
                  'Diskmaskinen har minst 3-4 uppvärmningscykler under ett program, var och en på ~2 kW. Dessa sker vid olika tidpunkter beroende på program och hur smutsig disken är. Du kan inte veta exakt när nästa topp kommer. Ett 2-timmars diskprogram kan ge 4 effekttoppar på 2 kW – och om du startar den efter middagen kan flera av dessa sammanfalla med annan kvällsanvändning.',
                  'The dishwasher has at least 3-4 heating cycles during a program, each at ~2 kW. These occur at different times depending on the program and how dirty the dishes are. You can\'t know exactly when the next peak will come. A 2-hour dish program can give 4 power peaks of 2 kW – and if you start it after dinner, several of these can coincide with other evening usage.'
                )}
              </p>
            </div>
          </section>

          {/* Water Boiler Chart */}
          <section className="mb-12">
            <h3 className="text-xl font-medium text-foreground mb-4">
              {t('Varmvattenberedare: Verklig förbrukningsdata', 'Water Boiler: Real Consumption Data')}
            </h3>
            
            <div className="bg-card border border-border rounded-xl p-6 mb-6">
              <div className="flex justify-center">
                <img 
                  src={waterBoilerChartImage} 
                  alt={t('Varmvattenberedare effektförbrukning', 'Water boiler power consumption')}
                  className="max-w-full h-auto rounded-lg"
                />
              </div>
            </div>

            {/* Key insight */}
            <div className="mb-6">
              <h4 className="font-medium text-foreground mb-2">
                {t('Insikt: En av de värsta bovarna', 'Insight: One of the worst culprits')}
              </h4>
              <p className="text-muted-foreground leading-relaxed">
                {t(
                  'En elektrisk varmvattenberedare drar konstant ~3 kW varje gång den värmer. Efter dusch eller bad kan den köra i timmar för att återställa temperaturen. Dessutom slår den på regelbundet under dagen för att hålla vattnet varmt – ofta vid oförutsägbara tidpunkter. På kvällen kan dessa korta uppvärmningscykler lätt sammanfalla med matlagning, diskmaskin och elbilsladdning.',
                  'An electric water boiler draws a constant ~3 kW every time it heats. After a shower or bath, it can run for hours to restore the temperature. Additionally, it turns on regularly throughout the day to keep the water warm – often at unpredictable times. In the evening, these short heating cycles can easily coincide with cooking, dishwasher, and EV charging.'
                )}
              </p>
            </div>
          </section>

          {/* EV Charger Chart */}
          <section className="mb-12">
            <h3 className="text-xl font-medium text-foreground mb-4">
              {t('Elbilsladdare (11 kW): Verklig förbrukningsdata', 'EV Charger (11 kW): Real Consumption Data')}
            </h3>
            
            <div className="bg-card border border-border rounded-xl p-6 mb-6">
              <div className="flex justify-center">
                <img 
                  src={evChargerChartImage} 
                  alt={t('Elbilsladdare effektförbrukning', 'EV charger power consumption')}
                  className="max-w-full h-auto rounded-lg"
                />
              </div>
            </div>

            {/* Key insight */}
            <div className="mb-6">
              <h4 className="font-medium text-foreground mb-2">
                {t('Insikt: När du absolut inte vill köra andra apparater', 'Insight: When you definitely don\'t want to use other appliances')}
              </h4>
              <p className="text-muted-foreground leading-relaxed">
                {t(
                  'En 11 kW elbilsladdare drar konstant ~10 kW under hela laddningen – ofta 3-5 timmar. Detta är mer än hela din övriga hushållsförbrukning tillsammans. Om varmvattenberedaren slår på (~3 kW) eller diskmaskinen startar en uppvärmningscykel (~2 kW) medan laddningen pågår, kan du lätt nå 15 kW. Lägg till att någon lagar mat, och du är snabbt uppe i effekttoppar som kostar dig hundratals kronor extra per månad.',
                  'An 11 kW EV charger draws a constant ~10 kW throughout charging – often 3-5 hours. This is more than your entire remaining household consumption combined. If the water heater kicks in (~3 kW) or the dishwasher starts a heating cycle (~2 kW) while charging, you can easily reach 15 kW. Add someone cooking, and you quickly reach power peaks that cost you hundreds of extra kronor per month.'
                )}
              </p>
            </div>
          </section>

          {/* The Solution Section */}
          <section className="mb-12">
            <h2 className="text-2xl font-medium text-foreground mb-4">
              {t('Lösningen: Intelligent lastbalansering', 'The Solution: Intelligent Load Balancing')}
            </h2>
            
            <p className="text-muted-foreground leading-relaxed mb-6">
              {t(
                'Ett smart hem med energiövervakning kan se exakt vad varje apparat drar i realtid. Med den informationen kan automationen fatta intelligenta beslut:',
                'A smart home with energy monitoring can see exactly what each appliance draws in real-time. With that information, automation can make intelligent decisions:'
              )}
            </p>

            <div className="space-y-4 mb-8">
              {[
                {
                  title: t('Pausa elbilsladdning under uppvärmningsfaser', 'Pause EV charging during heating phases'),
                  description: t(
                    'När tvättmaskinen startar sin uppvärmning, sänks elbilsladdningen automatiskt från 16A till 6A i 15 minuter. Du märker ingen skillnad på morgonen.',
                    'When the washing machine starts its heating, EV charging automatically drops from 16A to 6A for 15 minutes. You notice no difference in the morning.'
                  )
                },
                {
                  title: t('Fördröj start av nya laster', 'Delay start of new loads'),
                  description: t(
                    'Om du trycker på start på diskmaskinen medan tvättmaskinen värmer, kan automationen vänta 15 minuter och sedan starta diskmaskinen.',
                    'If you press start on the dishwasher while the washing machine is heating, automation can wait 15 minutes and then start the dishwasher.'
                  )
                },
                {
                  title: t('Prioritera efter behov', 'Prioritize by need'),
                  description: t(
                    'Elbilen behöver vara laddad till kl 07:00, men det spelar ingen roll om tvätten blir klar kl 14:00 eller 16:00. Systemet vet detta och planerar därefter.',
                    'The EV needs to be charged by 07:00, but it doesn\'t matter if the laundry is done at 14:00 or 16:00. The system knows this and plans accordingly.'
                  )
                },
              ].map((item, index) => (
                <div key={index} className="flex gap-4 bg-card border border-border rounded-xl p-5">
                  <div className="w-8 h-8 rounded-full bg-primary text-primary-foreground flex items-center justify-center font-medium flex-shrink-0">
                    <TrendingDown className="w-4 h-4" />
                  </div>
                  <div>
                    <h3 className="font-medium text-foreground mb-1">{item.title}</h3>
                    <p className="text-sm text-muted-foreground">{item.description}</p>
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* CTA */}
          <section className="mb-12">
            <div className="bg-primary/10 border border-primary/20 rounded-xl p-8 text-center">
              <Zap className="w-12 h-12 text-primary mx-auto mb-4" />
              <h3 className="text-xl font-medium text-foreground mb-3">
                {t('Vill du veta mer?', 'Want to know more?')}
              </h3>
              <p className="text-muted-foreground mb-6 max-w-xl mx-auto">
                {t(
                  'Vi kan hjälpa dig sätta upp energiövervakning och intelligent lastbalansering i ditt hem. Kontakta oss för en kostnadsfri konsultation.',
                  'We can help you set up energy monitoring and intelligent load balancing in your home. Contact us for a free consultation.'
                )}
              </p>
              <Link 
                to="/contact" 
                className="inline-flex items-center gap-2 bg-primary text-primary-foreground px-6 py-3 rounded-lg font-medium hover:opacity-90 transition-opacity"
              >
                {t('Boka konsultation', 'Book consultation')}
              </Link>
            </div>
          </section>

          {/* Back link */}
          <div className="border-t border-border pt-8">
            <Link 
              to="/knowledge/effektavgift" 
              className="inline-flex items-center gap-2 text-primary hover:underline"
            >
              <ArrowLeft className="w-4 h-4" />
              {t('Tillbaka till: Vad är effektavgift?', 'Back to: What Is Effektavgift?')}
            </Link>
          </div>

        </div>
      </section>
    </Layout>
  );
};

export default LastbalanseringArticle;
