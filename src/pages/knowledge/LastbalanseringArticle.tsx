import { Link } from 'react-router-dom';
import { ArrowLeft, Clock, TrendingDown, Zap, AlertTriangle } from 'lucide-react';
import { useLanguage } from '@/contexts/LanguageContext';
import Layout from '@/components/Layout';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceArea } from 'recharts';

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
              <div className="h-80">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={washingMachineData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="powerGradient" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.4}/>
                        <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0.05}/>
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis 
                      dataKey="time" 
                      stroke="hsl(var(--muted-foreground))"
                      fontSize={12}
                      tickLine={false}
                      interval={4}
                    />
                    <YAxis 
                      stroke="hsl(var(--muted-foreground))"
                      fontSize={12}
                      tickLine={false}
                      tickFormatter={(value) => value >= 1000 ? `${(value/1000).toFixed(1)} kW` : `${value} W`}
                      domain={[0, 2500]}
                    />
                    <Tooltip 
                      contentStyle={{ 
                        backgroundColor: 'hsl(var(--card))', 
                        border: '1px solid hsl(var(--border))',
                        borderRadius: '8px',
                        fontSize: '14px'
                      }}
                      formatter={(value: number) => [
                        value >= 1000 ? `${(value/1000).toFixed(2)} kW` : `${value} W`, 
                        t('Effekt', 'Power')
                      ]}
                    />
                    {/* Highlight heating phase */}
                    <ReferenceArea 
                      x1="12:20" 
                      x2="12:36" 
                      fill="hsl(var(--destructive))" 
                      fillOpacity={0.15} 
                    />
                    <Area 
                      type="monotone" 
                      dataKey="power" 
                      stroke="hsl(var(--primary))" 
                      strokeWidth={2}
                      fill="url(#powerGradient)" 
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
              
              {/* Chart legend */}
              <div className="flex flex-wrap items-center gap-6 mt-4 pt-4 border-t border-border">
                <div className="flex items-center gap-2">
                  <div className="w-4 h-4 rounded bg-destructive/30"></div>
                  <span className="text-sm text-muted-foreground">
                    {t('Uppvärmningsfas (~2 kW)', 'Heating phase (~2 kW)')}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-4 h-4 rounded bg-primary/30"></div>
                  <span className="text-sm text-muted-foreground">
                    {t('Effektförbrukning', 'Power consumption')}
                  </span>
                </div>
              </div>
            </div>

            {/* Key insight box */}
            <div className="bg-destructive/10 border border-destructive/20 rounded-xl p-6 mb-6">
              <div className="flex gap-4">
                <AlertTriangle className="w-6 h-6 text-destructive flex-shrink-0 mt-1" />
                <div>
                  <h4 className="font-medium text-foreground mb-2">
                    {t('Insikt: Uppvärmningen är boven', 'Insight: Heating is the culprit')}
                  </h4>
                  <p className="text-muted-foreground">
                    {t(
                      'Under cirka 15 minuter drar tvättmaskinen nästan 2 kW för att värma vattnet. Resten av tvättprogrammet (1,5–2 timmar) drar bara 100–300 W. Om du startar tvättmaskinen samtidigt som elbilsladdningen körs med 7 kW, har du plötsligt en topp på nästan 9 kW – bara från två apparater.',
                      'For about 15 minutes, the washing machine draws almost 2 kW to heat the water. The rest of the wash cycle (1.5–2 hours) only draws 100–300 W. If you start the washing machine while EV charging is running at 7 kW, you suddenly have a peak of almost 9 kW – from just two appliances.'
                    )}
                  </p>
                </div>
              </div>
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
              <div className="h-80">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={tumbleDryerData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="dryerGradient" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.4}/>
                        <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0.05}/>
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis 
                      dataKey="time" 
                      stroke="hsl(var(--muted-foreground))"
                      fontSize={12}
                      tickLine={false}
                      interval={4}
                    />
                    <YAxis 
                      stroke="hsl(var(--muted-foreground))"
                      fontSize={12}
                      tickLine={false}
                      tickFormatter={(value) => `${value} W`}
                      domain={[0, 800]}
                    />
                    <Tooltip 
                      contentStyle={{ 
                        backgroundColor: 'hsl(var(--card))', 
                        border: '1px solid hsl(var(--border))',
                        borderRadius: '8px',
                        fontSize: '14px'
                      }}
                      formatter={(value: number) => [`${value} W`, t('Effekt', 'Power')]}
                    />
                    {/* Highlight sustained heating phase */}
                    <ReferenceArea 
                      x1="11:00" 
                      x2="11:27" 
                      fill="hsl(var(--warning))" 
                      fillOpacity={0.15} 
                    />
                    <Area 
                      type="monotone" 
                      dataKey="power" 
                      stroke="hsl(var(--primary))" 
                      strokeWidth={2}
                      fill="url(#dryerGradient)" 
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
              
              {/* Chart legend */}
              <div className="flex flex-wrap items-center gap-6 mt-4 pt-4 border-t border-border">
                <div className="flex items-center gap-2">
                  <div className="w-4 h-4 rounded bg-warning/30"></div>
                  <span className="text-sm text-muted-foreground">
                    {t('Kontinuerlig uppvärmning (~700-800 W)', 'Continuous heating (~700-800 W)')}
                  </span>
                </div>
              </div>
            </div>

            {/* Key insight box */}
            <div className="bg-warning/10 border border-warning/20 rounded-xl p-6 mb-6">
              <div className="flex gap-4">
                <AlertTriangle className="w-6 h-6 text-warning flex-shrink-0 mt-1" />
                <div>
                  <h4 className="font-medium text-foreground mb-2">
                    {t('Insikt: Långvarig belastning', 'Insight: Prolonged load')}
                  </h4>
                  <p className="text-muted-foreground">
                    {t(
                      'Till skillnad från tvättmaskinen drar torktumlaren högt effekt under hela programmet – ofta 2-3 timmar. Det är inte en kort topp utan en lång, kontinuerlig belastning på 700-800 W. Om du kör torktumlaren samtidigt som annan utrustning, adderas denna effekt under hela tiden.',
                      'Unlike the washing machine, the tumble dryer draws high power throughout the entire program – often 2-3 hours. It\'s not a short peak but a long, continuous load of 700-800 W. If you run the dryer alongside other equipment, this power adds up the entire time.'
                    )}
                  </p>
                </div>
              </div>
            </div>
          </section>

          {/* Heat Pump Chart */}
          <section className="mb-12">
            <h3 className="text-xl font-medium text-foreground mb-4">
              {t('Luft-luft värmepump: Verklig förbrukningsdata', 'Air-to-Air Heat Pump: Real Consumption Data')}
            </h3>
            
            <div className="bg-card border border-border rounded-xl p-6 mb-6">
              <div className="h-80">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={heatPumpData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="heatPumpGradient" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.4}/>
                        <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0.05}/>
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis 
                      dataKey="time" 
                      stroke="hsl(var(--muted-foreground))"
                      fontSize={12}
                      tickLine={false}
                      interval={4}
                    />
                    <YAxis 
                      stroke="hsl(var(--muted-foreground))"
                      fontSize={12}
                      tickLine={false}
                      tickFormatter={(value) => value >= 1000 ? `${(value/1000).toFixed(1)} kW` : `${value} W`}
                      domain={[0, 2500]}
                    />
                    <Tooltip 
                      contentStyle={{ 
                        backgroundColor: 'hsl(var(--card))', 
                        border: '1px solid hsl(var(--border))',
                        borderRadius: '8px',
                        fontSize: '14px'
                      }}
                      formatter={(value: number) => [
                        value >= 1000 ? `${(value/1000).toFixed(2)} kW` : `${value} W`, 
                        t('Effekt', 'Power')
                      ]}
                    />
                    {/* Highlight startup spike */}
                    <ReferenceArea 
                      x1="04:34" 
                      x2="04:38" 
                      fill="hsl(var(--destructive))" 
                      fillOpacity={0.15} 
                    />
                    {/* Highlight defrost cycle spike */}
                    <ReferenceArea 
                      x1="05:18" 
                      x2="05:24" 
                      fill="hsl(var(--destructive))" 
                      fillOpacity={0.15} 
                    />
                    <Area 
                      type="monotone" 
                      dataKey="power" 
                      stroke="hsl(var(--primary))" 
                      strokeWidth={2}
                      fill="url(#heatPumpGradient)" 
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
              
              {/* Chart legend */}
              <div className="flex flex-wrap items-center gap-6 mt-4 pt-4 border-t border-border">
                <div className="flex items-center gap-2">
                  <div className="w-4 h-4 rounded bg-destructive/30"></div>
                  <span className="text-sm text-muted-foreground">
                    {t('Uppstart & avfrostning (~2.2 kW)', 'Startup & defrost (~2.2 kW)')}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-4 h-4 rounded bg-primary/30"></div>
                  <span className="text-sm text-muted-foreground">
                    {t('Normal drift (~0.8-1.4 kW)', 'Normal operation (~0.8-1.4 kW)')}
                  </span>
                </div>
              </div>
            </div>

            {/* Key insight box */}
            <div className="bg-destructive/10 border border-destructive/20 rounded-xl p-6 mb-6">
              <div className="flex gap-4">
                <AlertTriangle className="w-6 h-6 text-destructive flex-shrink-0 mt-1" />
                <div>
                  <h4 className="font-medium text-foreground mb-2">
                    {t('Insikt: Oförutsägbara toppar', 'Insight: Unpredictable peaks')}
                  </h4>
                  <p className="text-muted-foreground">
                    {t(
                      'Värmepumpen startar och avfrostar när den behöver – inte när du vill. Under vintern kan avfrostningscykler inträffa flera gånger om dagen, varje gång med en topp på över 2 kW. Om detta händer samtidigt som du laddar elbilen eller kör tvättmaskinen, kan du få en oväntad effekttopp som påverkar din effektavgift.',
                      'The heat pump starts and defrosts when it needs to – not when you want it to. During winter, defrost cycles can occur several times a day, each time with a peak over 2 kW. If this happens while you\'re charging your EV or running the washing machine, you can get an unexpected power peak that affects your effektavgift.'
                    )}
                  </p>
                </div>
              </div>
            </div>
          </section>

          {/* Stove Top Chart */}
          <section className="mb-12">
            <h3 className="text-xl font-medium text-foreground mb-4">
              {t('Spishäll: Verklig förbrukningsdata', 'Stove Top: Real Consumption Data')}
            </h3>
            
            <div className="bg-card border border-border rounded-xl p-6 mb-6">
              <div className="h-80">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={stoveTopData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="stoveGradient" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.4}/>
                        <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0.05}/>
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis 
                      dataKey="time" 
                      stroke="hsl(var(--muted-foreground))"
                      fontSize={12}
                      tickLine={false}
                      interval={2}
                    />
                    <YAxis 
                      stroke="hsl(var(--muted-foreground))"
                      fontSize={12}
                      tickLine={false}
                      tickFormatter={(value) => value >= 1000 ? `${(value/1000).toFixed(1)} kW` : `${value} W`}
                      domain={[0, 2000]}
                    />
                    <Tooltip 
                      contentStyle={{ 
                        backgroundColor: 'hsl(var(--card))', 
                        border: '1px solid hsl(var(--border))',
                        borderRadius: '8px',
                        fontSize: '14px'
                      }}
                      formatter={(value: number) => [
                        value >= 1000 ? `${(value/1000).toFixed(2)} kW` : `${value} W`, 
                        t('Effekt', 'Power')
                      ]}
                    />
                    {/* Highlight initial heating phase */}
                    <ReferenceArea 
                      x1="19:07" 
                      x2="19:11" 
                      fill="hsl(var(--destructive))" 
                      fillOpacity={0.15} 
                    />
                    <Area 
                      type="monotone" 
                      dataKey="power" 
                      stroke="hsl(var(--primary))" 
                      strokeWidth={2}
                      fill="url(#stoveGradient)" 
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
              
              {/* Chart legend */}
              <div className="flex flex-wrap items-center gap-6 mt-4 pt-4 border-t border-border">
                <div className="flex items-center gap-2">
                  <div className="w-4 h-4 rounded bg-destructive/30"></div>
                  <span className="text-sm text-muted-foreground">
                    {t('Uppvärmningsfas (~1.7 kW)', 'Heating phase (~1.7 kW)')}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-4 h-4 rounded bg-primary/30"></div>
                  <span className="text-sm text-muted-foreground">
                    {t('Underhållseffekt (~800 W)', 'Maintenance power (~800 W)')}
                  </span>
                </div>
              </div>
            </div>

            {/* Key insight box */}
            <div className="bg-warning/10 border border-warning/20 rounded-xl p-6 mb-6">
              <div className="flex gap-4">
                <AlertTriangle className="w-6 h-6 text-warning flex-shrink-0 mt-1" />
                <div>
                  <h4 className="font-medium text-foreground mb-2">
                    {t('Insikt: Matlagning sker på kvällstid', 'Insight: Cooking happens in the evening')}
                  </h4>
                  <p className="text-muted-foreground">
                    {t(
                      'De flesta lagar mat mellan 17:00-19:00 – precis under kvällens höglasttid. En spishäll kan dra 1.5-2 kW per platta. Om du använder två plattor samtidigt som ugnen körs, kan du lätt nå 5-6 kW bara från matlagning. Lägg till elbilsladdning och du har snabbt en betydande effekttopp.',
                      'Most people cook between 17:00-19:00 – right during the evening peak hours. A stove top can draw 1.5-2 kW per burner. If you use two burners while the oven is running, you can easily reach 5-6 kW just from cooking. Add EV charging and you quickly have a significant power peak.'
                    )}
                  </p>
                </div>
              </div>
            </div>
          </section>

          {/* More appliances coming section */}
          <section className="mb-12">
            <h2 className="text-2xl font-medium text-foreground mb-4">
              {t('Fler apparater kommer', 'More Appliances Coming')}
            </h2>
            
            {/* Placeholder for future charts */}
            <div className="grid sm:grid-cols-2 gap-4">
              {[
                { 
                  name: t('Diskmaskin', 'Dishwasher'), 
                  peak: '~2.2 kW',
                  description: t('Kommer snart', 'Coming soon')
                },
                { 
                  name: t('Elbilsladdare', 'EV charger'), 
                  peak: '3.7–22 kW',
                  description: t('Kommer snart', 'Coming soon')
                },
                { 
                  name: t('Varmvattenberedare', 'Water heater'),
                  peak: '~3 kW',
                  description: t('Kommer snart', 'Coming soon')
                },
              ].map((appliance) => (
                <div key={appliance.name} className="bg-muted/50 border border-border rounded-xl p-5 opacity-70">
                  <div className="flex items-center justify-between mb-2">
                    <h4 className="font-medium text-foreground">{appliance.name}</h4>
                    <span className="text-sm text-primary font-mono">{appliance.peak}</span>
                  </div>
                  <p className="text-sm text-muted-foreground">{appliance.description}</p>
                </div>
              ))}
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
