import { 
  Home, 
  Zap, 
  Wifi, 
  Settings, 
  Thermometer, 
  Users,
  TrendingDown,
  Shield,
  Smartphone,
  Code,
  CheckCircle
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { useLanguage } from '@/contexts/LanguageContext';
import Layout from '@/components/Layout';
import { Button } from '@/components/ui/button';

const Services = () => {
  const { t } = useLanguage();

  const services = [
    {
      id: 'installation',
      icon: Home,
      title: t('Komplett smart hemplanering & installation', 'Complete Smart Home Planning & Installation'),
      description: t(
        'Vi planerar och installerar hela ditt smarta hem från grunden. Från den första konsultationen till färdig installation säkerställer vi att varje komponent fungerar sömlöst tillsammans.',
        'We plan and install your complete smart home from the ground up. From initial consultation to final installation, we ensure every component works seamlessly together.'
      ),
      features: [
        t('Hemanalys och planering', 'Home analysis and planning'),
        t('Komponentval och inköp', 'Component selection and procurement'),
        t('Professionell installation', 'Professional installation'),
        t('Systemkonfiguration', 'System configuration'),
        t('Användarutbildning', 'User training'),
      ],
      color: 'bg-primary-lighter/30 text-primary',
    },
    {
      id: 'home-assistant',
      icon: Settings,
      title: t('Home Assistant installation & dashboards', 'Home Assistant Setup & Dashboards'),
      description: t(
        'Home Assistant är hjärtat i ett riktigt smart hem. Vi installerar, konfigurerar och skapar anpassade dashboards som ger dig full kontroll över ditt hem.',
        'Home Assistant is the heart of a truly smart home. We set up, configure, and create custom dashboards that give you complete control over your home.'
      ),
      features: [
        t('Home Assistant-installation', 'Home Assistant installation'),
        t('Anpassade kontrollpaneler', 'Custom control dashboards'),
        t('Automatiseringsregler', 'Automation rules'),
        t('Integration med alla enheter', 'Integration with all devices'),
        t('Fjärråtkomst-konfiguration', 'Remote access configuration'),
      ],
      color: 'bg-energy/30 text-energy-darker',
    },
    {
      id: 'hardware',
      icon: Smartphone,
      title: t('Hårdvaruinstallation', 'Hardware Installation'),
      description: t(
        'Installation av sensorer, smarta lås, strömbrytare, termostater och alla andra smarta enheter. Vi ser till att allt är korrekt installerat och integrerat.',
        'Installation of sensors, smart locks, switches, thermostats, and all other smart devices. We ensure everything is properly installed and integrated.'
      ),
      features: [
        t('Temperatur- och fuktsensorer', 'Temperature & humidity sensors'),
        t('Rörelse- och närvarosensorer', 'Motion & presence sensors'),
        t('Smarta lås och dörrsensorer', 'Smart locks & door sensors'),
        t('Smarta strömbrytare och dimmers', 'Smart switches & dimmers'),
        t('Smarta termostater', 'Smart thermostats'),
      ],
      color: 'bg-warning/30 text-foreground',
    },
    {
      id: 'energy',
      icon: Zap,
      title: t('Energiövervakning & optimering', 'Energy Monitoring & Optimization'),
      description: t(
        'Fullständig insikt i din energiförbrukning med realtidsövervakning, historisk analys och smarta rekommendationer för att sänka dina elräkningar.',
        'Complete insight into your energy consumption with real-time monitoring, historical analysis, and smart recommendations to lower your electricity bills.'
      ),
      features: [
        t('Realtidsförbrukningsdata', 'Real-time consumption data'),
        t('Historisk analys och trender', 'Historical analysis and trends'),
        t('Kostnadsberäkningar', 'Cost calculations'),
        t('Automatiska optimeringsförslag', 'Automatic optimization suggestions'),
        t('Integration med elprisdata', 'Integration with electricity price data'),
      ],
      color: 'bg-energy/30 text-energy-darker',
    },
    {
      id: 'effektavgift',
      icon: TrendingDown,
      title: t('Effektavgift lastbalanseringsstrategi', 'Effektavgift Load-Balancing Strategy'),
      description: t(
        'Sveriges effektavgift kan bli kostsam. Vi hjälper dig att förstå och optimera din toppförbrukning genom intelligent lastbalansering och schemaläggning.',
        "Sweden's effektavgift can be costly. We help you understand and optimize your peak consumption through intelligent load balancing and scheduling."
      ),
      features: [
        t('Analys av effektmönster', 'Peak pattern analysis'),
        t('Automatisk lastbalansering', 'Automatic load balancing'),
        t('Schemaläggning av tunga laster', 'Scheduling of heavy loads'),
        t('Realtidsvarningar för höga toppar', 'Real-time high peak warnings'),
        t('Månatlig optimeringsrapport', 'Monthly optimization report'),
      ],
      color: 'bg-coral/20 text-foreground',
    },
    {
      id: 'network',
      icon: Wifi,
      title: t('Nätverk/WiFi-optimering', 'Network/WiFi Optimization'),
      description: t(
        'Ett smart hem kräver ett stabilt nätverk. Vi optimerar din WiFi-täckning och nätverkskonfiguration för att säkerställa tillförlitlig kommunikation mellan alla enheter.',
        'A smart home requires a stable network. We optimize your WiFi coverage and network configuration to ensure reliable communication between all devices.'
      ),
      features: [
        t('WiFi-täckningsanalys', 'WiFi coverage analysis'),
        t('Mesh-nätverksinstallation', 'Mesh network installation'),
        t('Nätverkssegmentering för IoT', 'Network segmentation for IoT'),
        t('Hastighets- och latensoptimering', 'Speed and latency optimization'),
        t('Säkerhetskonfiguration', 'Security configuration'),
      ],
      color: 'bg-primary-lighter/30 text-primary',
    },
    {
      id: 'software',
      icon: Code,
      title: t('Anpassad mjukvaruutveckling', 'Custom Software Development'),
      description: t(
        'Behöver du något speciellt? Vi utvecklar anpassade integrationer, automationer och lösningar som passar just dina behov.',
        'Need something special? We develop custom integrations, automations, and solutions that fit your specific needs.'
      ),
      features: [
        t('Anpassade Home Assistant-integrationer', 'Custom Home Assistant integrations'),
        t('API-integrationer', 'API integrations'),
        t('Avancerade automationsscenarier', 'Advanced automation scenarios'),
        t('Datainsamling och analys', 'Data collection and analysis'),
        t('Tredjepartsintegrationer', 'Third-party integrations'),
      ],
      color: 'bg-muted text-foreground',
    },
    {
      id: 'presence',
      icon: Shield,
      title: t('Närvarodetektering & larm', 'Presence Detection & Alarms'),
      description: t(
        'Säkerhet och komfort genom intelligent närvarodetektering. Automatisera baserat på vem som är hemma och få meddelanden om ovanlig aktivitet.',
        'Security and comfort through intelligent presence detection. Automate based on who is home and get notifications about unusual activity.'
      ),
      features: [
        t('Intelligent närvarodetektering', 'Intelligent presence detection'),
        t('Automatisering baserad på närvaro', 'Presence-based automation'),
        t('Säkerhetsnotifieringar', 'Security notifications'),
        t('Integration med smarta lås', 'Integration with smart locks'),
        t('Aktivitetsloggning', 'Activity logging'),
      ],
      color: 'bg-energy/30 text-energy-darker',
    },
    {
      id: 'support',
      icon: Users,
      title: t('Löpande support & underhåll', 'Ongoing Support & Maintenance'),
      description: t(
        'Vi är här för dig även efter installationen. Välj ett supportpaket som passar dina behov för kontinuerlig optimering och hjälp.',
        "We're here for you even after installation. Choose a support package that fits your needs for continuous optimization and assistance."
      ),
      features: [
        t('Teknisk support via telefon/mejl', 'Technical support via phone/email'),
        t('Fjärrfelsökning', 'Remote troubleshooting'),
        t('Regelbundna systemuppdateringar', 'Regular system updates'),
        t('Kvartalsvis optimeringsgenomgång', 'Quarterly optimization review'),
        t('Prioriterad servicerespons', 'Priority service response'),
      ],
      color: 'bg-primary-lighter/30 text-primary',
    },
  ];

  return (
    <Layout>
      {/* Hero */}
      <section className="py-16 md:py-24 hero-gradient">
        <div className="container mx-auto text-center">
          <h1 className="text-foreground mb-6">{t('Våra tjänster', 'Our Services')}</h1>
          <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
            {t(
              'Kompletta smarta hemlösningar från planering och installation till löpande optimering och support.',
              'Complete smart home solutions from planning and installation to ongoing optimization and support.'
            )}
          </p>
        </div>
      </section>

      {/* Services Grid */}
      <section className="py-16 md:py-24">
        <div className="container mx-auto">
          <div className="space-y-16">
            {services.map((service, index) => (
              <div 
                key={service.id}
                id={service.id}
                className={`grid lg:grid-cols-2 gap-12 items-center ${index % 2 === 1 ? 'lg:flex-row-reverse' : ''}`}
              >
                <div className={index % 2 === 1 ? 'lg:order-2' : ''}>
                  <div className={`icon-container ${service.color} mb-6`}>
                    <service.icon className="w-6 h-6" />
                  </div>
                  <h2 className="text-2xl md:text-3xl font-medium text-foreground mb-4">{service.title}</h2>
                  <p className="text-muted-foreground mb-6 leading-relaxed">{service.description}</p>
                  <ul className="space-y-3">
                    {service.features.map((feature, i) => (
                      <li key={i} className="flex items-center gap-3 text-sm">
                        <CheckCircle className="w-5 h-5 text-energy-dark flex-shrink-0" />
                        <span>{feature}</span>
                      </li>
                    ))}
                  </ul>
                </div>
                <div className={`hidden lg:flex ${service.color} rounded-2xl h-64 lg:h-80 items-center justify-center ${index % 2 === 1 ? 'lg:order-1' : ''}`}>
                  <service.icon className="w-24 h-24 opacity-30" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="py-16 md:py-24 bg-card">
        <div className="container mx-auto text-center">
          <h2 className="text-foreground mb-4">
            {t('Redo att komma igång?', 'Ready to Get Started?')}
          </h2>
          <p className="text-muted-foreground max-w-xl mx-auto mb-8">
            {t(
              'Boka en kostnadsfri konsultation så diskuterar vi hur vi kan hjälpa dig att optimera ditt hem.',
              "Book a free consultation and we'll discuss how we can help optimize your home."
            )}
          </p>
          <Button asChild size="lg">
            <Link to="/contact">{t('Kontakta oss', 'Contact Us')}</Link>
          </Button>
        </div>
      </section>
    </Layout>
  );
};

export default Services;
