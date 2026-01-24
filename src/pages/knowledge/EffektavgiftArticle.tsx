import { Link } from 'react-router-dom';
import { ArrowLeft, Clock, Zap, ExternalLink } from 'lucide-react';
import { useLanguage } from '@/contexts/LanguageContext';
import Layout from '@/components/Layout';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';

const EffektavgiftArticle = () => {
  const { t } = useLanguage();

  return (
    <Layout>
      {/* Article Header */}
      <section className="py-12 md:py-16 hero-gradient">
        <div className="container mx-auto max-w-4xl">
          <Link 
            to="/knowledge" 
            className="inline-flex items-center gap-2 text-muted-foreground hover:text-primary mb-6"
          >
            <ArrowLeft className="w-4 h-4" />
            {t('Tillbaka till Kunskapscenter', 'Back to Knowledge Center')}
          </Link>
          
          <div className="flex items-center gap-3 mb-4">
            <span className="bg-primary-lighter text-foreground/80 text-sm font-medium px-3 py-1 rounded-full">
              {t('Energigrunder', 'Energy Basics')}
            </span>
            <span className="flex items-center gap-1 text-sm text-muted-foreground">
              <Clock className="w-4 h-4" />
              8 min {t('läsning', 'read')}
            </span>
          </div>
          
          <h1 className="text-foreground mb-4">
            {t('Vad är effektavgift?', 'What Is Effektavgift?')}
          </h1>
          <p className="text-lg text-muted-foreground">
            {t(
              'En komplett guide till den svenska effektavgiften – från EU-lagstiftning till praktiska tips för att sänka dina kostnader.',
              'A complete guide to the Swedish peak power charge – from EU legislation to practical tips for reducing your costs.'
            )}
          </p>
        </div>
      </section>

      {/* Article Content */}
      <article className="py-12 md:py-16">
        <div className="container mx-auto max-w-4xl">
          <div className="prose prose-lg max-w-none">
            
            {/* Introduction */}
            <section className="mb-12">
              <p className="text-muted-foreground leading-relaxed">
                {t(
                  'Från och med januari 2027 ska alla svenska elnätsföretag ha infört en ny prismodell som inkluderar en effektavgift. Denna förändring påverkar hur du betalar för el och ger dig nya möjligheter att påverka dina kostnader. I den här artikeln förklarar vi bakgrunden, lagstiftningen och vad det betyder för dig som konsument.',
                  'Starting January 2027, all Swedish grid operators must implement a new pricing model that includes a peak power charge (effektavgift). This change affects how you pay for electricity and gives you new opportunities to influence your costs. In this article, we explain the background, legislation, and what it means for you as a consumer.'
                )}
              </p>
            </section>

            {/* EU Background */}
            <section className="mb-12">
              <h2 className="text-2xl font-medium text-foreground mb-4 flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-primary-lighter/50 flex items-center justify-center">
                  <span className="text-lg">🇪🇺</span>
                </div>
                {t('EU:s Clean Energy Package', 'The EU Clean Energy Package')}
              </h2>
              
              <div className="bg-card border border-border rounded-xl p-6 mb-6">
                <h3 className="font-medium text-foreground mb-2">
                  {t('Direktiv (EU) 2019/944', 'Directive (EU) 2019/944')}
                </h3>
                <p className="text-muted-foreground text-sm leading-relaxed">
                  {t(
                    'EU:s elmarknadsdirektiv från 2019 är en del av det så kallade "Clean Energy Package" och fastställer gemensamma regler för den inre marknaden för el. Direktivet kräver att nättariffer ska vara transparenta, icke-diskriminerande och utformade för att uppmuntra effektiv användning av elnätet.',
                    'The EU Electricity Market Directive from 2019 is part of the so-called "Clean Energy Package" and establishes common rules for the internal electricity market. The directive requires that network tariffs be transparent, non-discriminatory, and designed to encourage efficient use of the grid.'
                  )}
                </p>
              </div>
              
              <p className="text-muted-foreground leading-relaxed mb-4">
                {t(
                  'Enligt artikel 18 i direktivet ska medlemsstaterna säkerställa att distributionssystemoperatörer utformar nättariffer som återspeglar de faktiska kostnaderna för att använda nätet. Detta inkluderar att tariffer ska kunna vara tidsdifferentierade och kapacitetsbaserade – det vill säga baserade på hur mycket effekt (kW) du använder, inte bara hur mycket energi (kWh).',
                  'According to Article 18 of the directive, member states must ensure that distribution system operators design network tariffs that reflect the actual costs of using the grid. This includes that tariffs should be able to be time-differentiated and capacity-based – that is, based on how much power (kW) you use, not just how much energy (kWh).'
                )}
              </p>
              
              <p className="text-muted-foreground leading-relaxed">
                {t(
                  'Syftet är att skapa en mer flexibel och effektiv elmarknad där konsumenter aktivt kan bidra till att balansera elnätet genom att anpassa sin förbrukning.',
                  'The purpose is to create a more flexible and efficient electricity market where consumers can actively contribute to balancing the grid by adjusting their consumption.'
                )}
              </p>
            </section>

            {/* Swedish Implementation */}
            <section className="mb-12">
              <h2 className="text-2xl font-medium text-foreground mb-4 flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-primary-lighter/50 flex items-center justify-center">
                  <span className="text-lg">🇸🇪</span>
                </div>
                {t('Sveriges implementering', 'Sweden\'s Implementation')}
              </h2>
              
              <p className="text-muted-foreground leading-relaxed mb-4">
                {t(
                  'I Sverige har Energimarknadsinspektionen (Ei) ansvaret för att reglera elnätsföretagen. År 2022 utfärdade Ei föreskriften EIFS 2022:1 som specificerar hur den nya prismodellen ska utformas. Alla elnätsföretag ska ha implementerat modellen senast den 1 januari 2027.',
                  'In Sweden, the Swedish Energy Markets Inspectorate (Ei) is responsible for regulating grid operators. In 2022, Ei issued regulation EIFS 2022:1 which specifies how the new pricing model should be designed. All grid operators must implement the model by January 1, 2027.'
                )}
              </p>
              
              <div className="mb-6">
                <h3 className="font-medium text-foreground mb-4">
                  {t('Den nya prismodellen består av fyra komponenter:', 'The new pricing model consists of four components:')}
                </h3>
                <div className="grid sm:grid-cols-2 gap-4">
                  <div className="bg-card border border-border rounded-xl p-5">
                    <div className="font-medium text-primary mb-2">{t('Fast avgift', 'Fixed fee')}</div>
                    <p className="text-sm text-muted-foreground">
                      {t('Baseras på abonnerad effekt eller huvudsäkringens storlek.', 'Based on subscribed capacity or main fuse size.')}
                    </p>
                  </div>
                  <div className="bg-card border border-border rounded-xl p-5">
                    <div className="font-medium text-primary mb-2">{t('Kundspecifik avgift', 'Customer-specific fee')}</div>
                    <p className="text-sm text-muted-foreground">
                      {t('Täcker kostnader för mätning och rapportering.', 'Covers costs for metering and reporting.')}
                    </p>
                  </div>
                  <div className="bg-card border border-border rounded-xl p-5">
                    <div className="font-medium text-primary mb-2">{t('Energiavgift', 'Energy fee')}</div>
                    <p className="text-sm text-muted-foreground">
                      {t('Betalas per kWh som transporterats i elnätet. Kan vara tidsdifferentierad.', 'Paid per kWh transported in the grid. May be time-differentiated.')}
                    </p>
                  </div>
                  <div className="bg-card border border-border rounded-xl p-5">
                    <div className="font-medium text-primary mb-2">{t('Effektavgift', 'Peak power fee')}</div>
                    <p className="text-sm text-muted-foreground">
                      {t('Betalas per kW baserat på din högsta effektanvändning. Ska vara tidsdifferentierad.', 'Paid per kW based on your peak power usage. Must be time-differentiated.')}
                    </p>
                  </div>
                </div>
              </div>
              
              <div className="bg-warning/10 border border-warning/30 rounded-xl p-6">
                <h3 className="font-medium text-foreground mb-2 flex items-center gap-2">
                  <Zap className="w-5 h-5 text-warning" />
                  {t('Viktigt att förstå', 'Important to understand')}
                </h3>
                <p className="text-muted-foreground text-sm leading-relaxed">
                  {t(
                    'Effektavgiften innebär inte att elnätsföretagen får ta ut mer pengar totalt. Intäktsramen (taket för vad de får ta ut) bestäms fortfarande av Ei vart fjärde år. Det handlar om hur kostnaderna fördelas mellan kunderna baserat på deras faktiska användningsmönster.',
                    'The peak power charge does not mean grid operators can charge more money in total. The revenue cap (ceiling for what they can charge) is still determined by Ei every four years. It\'s about how costs are distributed among customers based on their actual usage patterns.'
                  )}
                </p>
              </div>
            </section>

            {/* Why This Change */}
            <section className="mb-12">
              <h2 className="text-2xl font-medium text-foreground mb-4">
                {t('Varför denna förändring?', 'Why This Change?')}
              </h2>
              
              <p className="text-muted-foreground leading-relaxed mb-4">
                {t(
                  'Sveriges elanvändning ökar kraftigt, drivet av elektrifiering av transportsektorn, värmepumpar och industrin. Detta skapar flaskhalsar i elnäten, särskilt under topptimmarna morgon och kväll. Att bygga ut elnäten tar tid och kostar enorma summor.',
                  'Sweden\'s electricity consumption is increasing dramatically, driven by electrification of transportation, heat pumps, and industry. This creates bottlenecks in the grid, especially during peak hours in the morning and evening. Expanding the grid takes time and costs enormous sums.'
                )}
              </p>
              
              <p className="text-muted-foreground leading-relaxed mb-6">
                {t(
                  'Effektavgiften är ett verktyg för att bättre utnyttja befintlig kapacitet genom att ge konsumenter ekonomiska incitament att sprida ut sin elanvändning. Om fler använder el när nätet är mindre belastat, kan dyra investeringar i nya ledningar skjutas upp eller undvikas helt.',
                  'The peak power charge is a tool for better utilizing existing capacity by giving consumers economic incentives to spread out their electricity usage. If more people use electricity when the grid is less loaded, expensive investments in new lines can be postponed or avoided entirely.'
                )}
              </p>
              
              {/* Consumption Chart */}
              <div className="bg-card border border-border rounded-xl p-6">
                <h3 className="font-medium text-foreground mb-2">
                  {t('Typisk dygnsförbrukning för ett svenskt hushåll', 'Typical daily consumption for a Swedish household')}
                </h3>
                <p className="text-sm text-muted-foreground mb-6">
                  {t(
                    'Grafen visar hur elförbrukningen varierar under dygnet. De markerade områdena representerar höglasttider då effektavgiften vanligtvis är högre.',
                    'The chart shows how electricity consumption varies throughout the day. The highlighted areas represent peak times when the peak power charge is usually higher.'
                  )}
                </p>
                
                <div className="h-64 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart
                      data={[
                        { hour: '00', consumption: 1.2, isPeak: false },
                        { hour: '01', consumption: 1.0, isPeak: false },
                        { hour: '02', consumption: 0.9, isPeak: false },
                        { hour: '03', consumption: 0.8, isPeak: false },
                        { hour: '04', consumption: 0.9, isPeak: false },
                        { hour: '05', consumption: 1.2, isPeak: false },
                        { hour: '06', consumption: 2.8, isPeak: true },
                        { hour: '07', consumption: 4.2, isPeak: true },
                        { hour: '08', consumption: 3.8, isPeak: true },
                        { hour: '09', consumption: 2.5, isPeak: false },
                        { hour: '10', consumption: 2.0, isPeak: false },
                        { hour: '11', consumption: 1.8, isPeak: false },
                        { hour: '12', consumption: 2.2, isPeak: false },
                        { hour: '13', consumption: 1.9, isPeak: false },
                        { hour: '14', consumption: 1.7, isPeak: false },
                        { hour: '15', consumption: 1.8, isPeak: false },
                        { hour: '16', consumption: 2.5, isPeak: false },
                        { hour: '17', consumption: 4.0, isPeak: true },
                        { hour: '18', consumption: 5.2, isPeak: true },
                        { hour: '19', consumption: 4.8, isPeak: true },
                        { hour: '20', consumption: 3.5, isPeak: false },
                        { hour: '21', consumption: 2.8, isPeak: false },
                        { hour: '22', consumption: 2.0, isPeak: false },
                        { hour: '23', consumption: 1.5, isPeak: false },
                      ]}
                      margin={{ top: 10, right: 10, left: 0, bottom: 0 }}
                    >
                      <defs>
                        <linearGradient id="consumptionGradient" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.3}/>
                          <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0}/>
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                      <XAxis 
                        dataKey="hour" 
                        tick={{ fontSize: 12, fill: 'hsl(var(--muted-foreground))' }}
                        axisLine={{ stroke: 'hsl(var(--border))' }}
                        tickLine={false}
                      />
                      <YAxis 
                        tick={{ fontSize: 12, fill: 'hsl(var(--muted-foreground))' }}
                        axisLine={false}
                        tickLine={false}
                        tickFormatter={(value) => `${value} kW`}
                        width={50}
                      />
                      <Tooltip 
                        contentStyle={{ 
                          backgroundColor: 'hsl(var(--card))', 
                          border: '1px solid hsl(var(--border))',
                          borderRadius: '8px',
                          fontSize: '12px'
                        }}
                        formatter={(value: number) => [`${value} kW`, t('Förbrukning', 'Consumption')]}
                        labelFormatter={(label) => `${label}:00`}
                      />
                      {/* Morning peak zone */}
                      <ReferenceLine x="06" stroke="hsl(var(--warning))" strokeDasharray="3 3" strokeOpacity={0.5} />
                      <ReferenceLine x="09" stroke="hsl(var(--warning))" strokeDasharray="3 3" strokeOpacity={0.5} />
                      {/* Evening peak zone */}
                      <ReferenceLine x="17" stroke="hsl(var(--warning))" strokeDasharray="3 3" strokeOpacity={0.5} />
                      <ReferenceLine x="20" stroke="hsl(var(--warning))" strokeDasharray="3 3" strokeOpacity={0.5} />
                      <Area 
                        type="monotone" 
                        dataKey="consumption" 
                        stroke="hsl(var(--primary))" 
                        strokeWidth={2}
                        fill="url(#consumptionGradient)" 
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
                
                {/* Peak period legend */}
                <div className="flex flex-wrap gap-4 mt-4 pt-4 border-t border-border">
                  <div className="flex items-center gap-2">
                    <div className="w-3 h-3 rounded-full bg-warning" />
                    <span className="text-sm text-muted-foreground">
                      {t('Morgontopp: 06:00–09:00', 'Morning peak: 06:00–09:00')}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="w-3 h-3 rounded-full bg-warning" />
                    <span className="text-sm text-muted-foreground">
                      {t('Kvällstopp: 17:00–20:00', 'Evening peak: 17:00–20:00')}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="w-3 h-3 rounded-full bg-primary" />
                    <span className="text-sm text-muted-foreground">
                      {t('Typisk förbrukning (kW)', 'Typical consumption (kW)')}
                    </span>
                  </div>
                </div>
                
                <p className="text-xs text-muted-foreground mt-4">
                  {t(
                    'Källa: Typiska förbrukningsmönster baserade på data från svenska elnätsföretag. Faktisk förbrukning varierar beroende på hushållets storlek och vanor.',
                    'Source: Typical consumption patterns based on data from Swedish grid operators. Actual consumption varies depending on household size and habits.'
                  )}
                </p>
              </div>
            </section>

            {/* What It Means for You */}
            <section className="mb-12">
              <h2 className="text-2xl font-medium text-foreground mb-4">
                {t('Vad betyder det för dig?', 'What Does It Mean for You?')}
              </h2>
              
              <p className="text-muted-foreground leading-relaxed mb-6">
                {t(
                  'Med den nya modellen har du större möjlighet att påverka dina elnätskostnader. Din effektavgift baseras på hur mycket effekt du använder samtidigt – inte bara på hur mycket energi du förbrukar totalt.',
                  'With the new model, you have greater ability to influence your grid costs. Your peak power charge is based on how much power you use simultaneously – not just how much energy you consume in total.'
                )}
              </p>
              
              <div className="bg-card border border-border rounded-xl p-6 mb-6">
                <h3 className="font-medium text-foreground mb-4">{t('Exempel: Effekttoppar', 'Example: Power Peaks')}</h3>
                <div className="space-y-4">
                  <div className="flex items-center gap-4">
                    <div className="w-20 text-center">
                      <div className="text-2xl font-light text-destructive">8 kW</div>
                      <div className="text-xs text-muted-foreground">{t('Hög topp', 'High peak')}</div>
                    </div>
                    <div className="flex-1 text-sm text-muted-foreground">
                      {t(
                        'Ugn (2 kW) + tvättmaskin (2 kW) + elbilsladdning (7 kW) – alla samtidigt under en timme.',
                        'Oven (2 kW) + washing machine (2 kW) + EV charging (7 kW) – all at the same time for one hour.'
                      )}
                    </div>
                  </div>
                  <div className="border-t border-border" />
                  <div className="flex items-center gap-4">
                    <div className="w-20 text-center">
                      <div className="text-2xl font-light text-energy-dark">3 kW</div>
                      <div className="text-xs text-muted-foreground">{t('Låg topp', 'Low peak')}</div>
                    </div>
                    <div className="flex-1 text-sm text-muted-foreground">
                      {t(
                        'Samma apparater, men fördelade över dagen – ugnen vid lunch, tvätt på eftermiddagen, laddning på natten.',
                        'Same appliances, but distributed throughout the day – oven at lunch, laundry in the afternoon, charging at night.'
                      )}
                    </div>
                  </div>
                </div>
              </div>
              
              <p className="text-muted-foreground leading-relaxed">
                {t(
                  'Den totala energianvändningen (kWh) är densamma i båda fallen, men effektavgiften blir betydligt lägre när du sprider ut användningen. Detta är kärnan i det nya systemet.',
                  'The total energy usage (kWh) is the same in both cases, but the peak power charge is significantly lower when you spread out the usage. This is the core of the new system.'
                )}
              </p>
            </section>

            {/* Practical Tips */}
            <section className="mb-12">
              <h2 className="text-2xl font-medium text-foreground mb-4">
                {t('Praktiska tips för att sänka din effektavgift', 'Practical Tips for Reducing Your Peak Power Charge')}
              </h2>
              
              <div className="space-y-4">
                {[
                  {
                    number: '1',
                    title: t('Kartlägg dina effekttoppar', 'Map your power peaks'),
                    description: t(
                      'Logga in på ditt elnätsföretags kundportal och analysera när dina högsta toppar inträffar. Detta ger dig en tydlig bild av vad du behöver ändra.',
                      'Log in to your grid operator\'s customer portal and analyze when your highest peaks occur. This gives you a clear picture of what you need to change.'
                    )
                  },
                  {
                    number: '2',
                    title: t('Undvik samtidig användning', 'Avoid simultaneous usage'),
                    description: t(
                      'Starta inte diskmaskin, tvättmaskin och elbilsladdning samtidigt. Schemalägg apparater för att sprida belastningen.',
                      'Don\'t start the dishwasher, washing machine, and EV charging at the same time. Schedule appliances to spread the load.'
                    )
                  },
                  {
                    number: '3',
                    title: t('Flytta användning till låglasttid', 'Shift usage to off-peak hours'),
                    description: t(
                      'Natten (22:00–06:00) och mitt på dagen är ofta billigare. Perfekt för elbilsladdning och tvättmaskiner med timer.',
                      'Night (22:00–06:00) and midday are often cheaper. Perfect for EV charging and washing machines with timers.'
                    )
                  },
                  {
                    number: '4',
                    title: t('Begränsa laddeffekt', 'Limit charging power'),
                    description: t(
                      'Många laddboxar låter dig ställa in maxeffekt. Att ladda långsammare över natten ger ofta lägre total kostnad än snabbladdning på kvällen.',
                      'Many charging stations let you set maximum power. Charging slower overnight often results in lower total cost than fast charging in the evening.'
                    )
                  },
                  {
                    number: '5',
                    title: t('Investera i smart hemautomation', 'Invest in smart home automation'),
                    description: t(
                      'Med ett smart hem kan du automatiskt balansera laster, schemalägg apparater och optimera din energianvändning utan att tänka på det.',
                      'With a smart home, you can automatically balance loads, schedule appliances, and optimize your energy usage without thinking about it.'
                    )
                  },
                ].map((tip) => (
                  <div key={tip.number} className="flex gap-4 bg-card border border-border rounded-xl p-5">
                    <div className="w-8 h-8 rounded-full bg-primary text-primary-foreground flex items-center justify-center font-medium flex-shrink-0">
                      {tip.number}
                    </div>
                    <div>
                      <h3 className="font-medium text-foreground mb-1">{tip.title}</h3>
                      <p className="text-sm text-muted-foreground">{tip.description}</p>
                    </div>
                  </div>
                ))}
              </div>
            </section>

            {/* Sources */}
            <section className="mb-12">
              <h2 className="text-2xl font-medium text-foreground mb-4">
                {t('Källor och vidare läsning', 'Sources and Further Reading')}
              </h2>
              
              <div className="space-y-3">
                <a 
                  href="https://eur-lex.europa.eu/eli/dir/2019/944/oj/eng" 
                  target="_blank" 
                  rel="noopener noreferrer"
                  className="flex items-center gap-3 text-primary hover:underline"
                >
                  <ExternalLink className="w-4 h-4" />
                  {t('EU Direktiv 2019/944 – Elmarknadsdirektivet', 'EU Directive 2019/944 – Electricity Market Directive')}
                </a>
                <a 
                  href="https://ei.se/konsument/el/elnatsavgiften-och-elnatsreglering/effektavgifter" 
                  target="_blank" 
                  rel="noopener noreferrer"
                  className="flex items-center gap-3 text-primary hover:underline"
                >
                  <ExternalLink className="w-4 h-4" />
                  {t('Energimarknadsinspektionen – Effektavgifter', 'Swedish Energy Markets Inspectorate – Peak Power Charges')}
                </a>
                <a 
                  href="https://ei.se/konsument/el/elnatsavgiften-och-elnatsreglering/fragor-och-svar-om-effektavgifter" 
                  target="_blank" 
                  rel="noopener noreferrer"
                  className="flex items-center gap-3 text-primary hover:underline"
                >
                  <ExternalLink className="w-4 h-4" />
                  {t('Ei – Vanliga frågor och svar om effektavgifter', 'Ei – FAQ about Peak Power Charges')}
                </a>
              </div>
            </section>

            {/* CTA */}
            <section className="bg-primary/5 border border-primary/20 rounded-xl p-6 text-center">
              <h2 className="text-xl font-medium text-foreground mb-2">
                {t('Vill du optimera ditt hem för den nya prismodellen?', 'Want to optimize your home for the new pricing model?')}
              </h2>
              <p className="text-muted-foreground mb-4">
                {t(
                  'Vi hjälper dig med smart hemautomation som automatiskt balanserar din energianvändning.',
                  'We help you with smart home automation that automatically balances your energy usage.'
                )}
              </p>
              <Link 
                to="/contact" 
                className="inline-flex items-center gap-2 bg-primary text-primary-foreground px-6 py-3 rounded-lg font-medium hover:bg-primary/90 transition-colors"
              >
                {t('Boka gratis konsultation', 'Book Free Consultation')}
              </Link>
            </section>

          </div>
        </div>
      </article>
    </Layout>
  );
};

export default EffektavgiftArticle;
