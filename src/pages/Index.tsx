import { Link } from 'react-router-dom';
import { 
  ArrowRight, 
  Home as HomeIcon, 
  Zap, 
  Wifi, 
  Settings, 
  Thermometer, 
  Users,
  TrendingDown,
  Clock,
  MapPin,
  Star,
  Play
} from 'lucide-react';
import { useLanguage } from '@/contexts/LanguageContext';
import Layout from '@/components/Layout';
import { Button } from '@/components/ui/button';
import heroImage from '@/assets/hero-smart-home.png';

const Index = () => {
  const { t } = useLanguage();

  const benefits = [
    {
      icon: TrendingDown,
      title: t('Sänk elräkningen', 'Reduce Electricity Bills'),
      description: t(
        'Undvik höglasttimmar och optimera din energiförbrukning med smart automation och realtidsövervakning.',
        'Avoid peak hours and optimize your energy consumption with smart automation and real-time monitoring.'
      ),
      color: 'bg-energy/30 text-energy-darker',
    },
    {
      icon: HomeIcon,
      title: t('Automatisera ditt hem', 'Automate Your Home'),
      description: t(
        'Komfort och säkerhet genom intelligent automation. Styr värme, belysning och apparater utan ansträngning.',
        'Comfort and safety through intelligent automation. Control heating, lighting, and appliances effortlessly.'
      ),
      color: 'bg-primary-lighter/50 text-primary',
    },
    {
      icon: Zap,
      title: t('Optimera effektavgift', 'Optimize Effektavgift'),
      description: t(
        'Hantera effektavgiften smart genom att balansera din energilast och minska toppförbrukningen.',
        'Handle the effektavgift smartly by balancing your energy load and reducing peak consumption.'
      ),
      color: 'bg-warning/30 text-foreground',
    },
    {
      icon: MapPin,
      title: t('Lokal Täby-expertis', 'Local Täby Expertise'),
      description: t(
        'Professionell installation och löpande support från experter som förstår svenska energisystem.',
        'Professional installation and ongoing support from experts who understand Swedish energy systems.'
      ),
      color: 'bg-accent text-primary',
    },
  ];

  const services = [
    { icon: HomeIcon, title: t('Smart installation', 'Smart Installation'), description: t('Professionell uppsättning av sensorer, smarta strömbrytare och automationssystem anpassade för ditt hem.', 'Professional setup of sensors, smart switches, and automation systems tailored to your home.') },
    { icon: Zap, title: t('Energiövervakning', 'Energy Monitoring'), description: t('Realtidsspårning av din elförbrukning med detaljerade insikter och rekommendationer.', 'Real-time tracking of your electricity usage with detailed insights and recommendations.') },
    { icon: TrendingDown, title: t('Effektavgift-balansering', 'Effektavgift Balancing'), description: t('Intelligent lasthantering för att minimera toppförbrukning och reducera effektavgifter.', 'Intelligent load management to minimize peak consumption and reduce effektavgift charges.') },
    { icon: Thermometer, title: t('Klimatstyrning', 'Climate Control'), description: t('Smart termostatinstallation för optimal komfort och energieffektivitet året runt.', 'Smart thermostat setup for optimal comfort and energy efficiency throughout the year.') },
    { icon: Wifi, title: t('Nätverksoptimering', 'Network Optimization'), description: t('WiFi- och nätverkskonfiguration för tillförlitlig anslutning för alla dina smarta enheter.', 'WiFi and network configuration to ensure reliable connectivity for all your smart devices.') },
    { icon: Settings, title: t('Home Assistant-design', 'Home Assistant Design'), description: t('Anpassad automationsdesign med Home Assistant för komplett smart hemintegration.', 'Custom automation design using Home Assistant for complete smart home integration.') },
    { icon: Users, title: t('Löpande support', 'Ongoing Support'), description: t('24/7 teknisk support och systemoptimering för att hålla ditt smarta hem igång perfekt.', '24/7 technical support and system optimization to keep your smart home running perfectly.') },
  ];

  const articles = [
    {
      category: t('Energigrunder', 'Energy Basics'),
      categoryColor: 'bg-primary-lighter',
      title: t('Vad är effektavgift?', 'What Is Effektavgift?'),
      description: t(
        'Förstå den svenska effektavgiften och hur den påverkar din elräkning.',
        'Understanding the Swedish peak power charge and how it affects your electricity bill.'
      ),
      readTime: '5 min',
    },
    {
      category: t('Automation', 'Automation'),
      categoryColor: 'bg-energy',
      title: t('Hur lastbalansering fungerar i ett smart hem', 'How Load Balancing Works in a Smart Home'),
      description: t(
        'Lär dig hur intelligent automation kan fördela energianvändningen och minska toppförbrukningen.',
        'Learn how intelligent automation can distribute energy usage and reduce peak consumption.'
      ),
      readTime: '7 min',
    },
    {
      category: t('Installation', 'Installation'),
      categoryColor: 'bg-muted',
      title: t('Välja sensorer för ditt Täby-hem', 'Choosing Sensors for Your Täby Home'),
      description: t(
        'En praktisk guide för att välja rätt temperatur-, rörelse- och energisensorer.',
        'A practical guide to selecting the right temperature, motion, and energy sensors.'
      ),
      readTime: '6 min',
    },
  ];

  return (
    <Layout>
      {/* Hero Section */}
      <section className="hero-gradient py-16 md:py-24 lg:py-32">
        <div className="container mx-auto">
          <div className="grid lg:grid-cols-2 gap-12 items-center">
            <div className="animate-fade-in-up">
              <h1 className="text-foreground mb-6">
                {t('Smartare energi för ditt Täby-hem', 'Smarter Energy for Your Täby Home')}
              </h1>
              <p className="text-lg text-muted-foreground mb-8 max-w-lg leading-relaxed">
                {t(
                  'Lokala experter på smart hemautomation och energioptimering. Sänk dina elräkningar och optimera din effektavgift med intelligent automation.',
                  'Local experts in smart-home automation and energy optimization. Reduce your electricity bills and optimize your effektavgift with intelligent automation.'
                )}
              </p>
              <div className="flex flex-col sm:flex-row gap-4 mb-12">
                <Button asChild size="lg" className="gap-2">
                  <Link to="/contact">
                    {t('Boka gratis konsultation', 'Book Free Consultation')}
                    <ArrowRight className="w-4 h-4" />
                  </Link>
                </Button>
                <Button asChild variant="outline" size="lg" className="gap-2">
                  <Link to="/services">
                    <Play className="w-4 h-4" />
                    {t('Lär dig hur det fungerar', 'Learn How It Works')}
                  </Link>
                </Button>
              </div>
              
              {/* Stats */}
              <div className="grid grid-cols-3 gap-6">
                <div>
                  <p className="stat-number">120+</p>
                  <p className="text-sm text-muted-foreground">{t('Installationer', 'Installations')}</p>
                </div>
                <div>
                  <p className="stat-number">5.0</p>
                  <p className="text-sm text-muted-foreground">{t('Snittbetyg', 'Average rating')}</p>
                </div>
                <div>
                  <p className="stat-number">Täby</p>
                  <p className="text-sm text-muted-foreground">{t('Lokala experter', 'Local experts')}</p>
                </div>
              </div>
            </div>
            
            <div className="animate-fade-in delay-200">
              <img 
                src={heroImage} 
                alt={t('Smart hem illustration', 'Smart home illustration')}
                className="w-full h-auto rounded-2xl shadow-soft"
              />
            </div>
          </div>
        </div>
      </section>

      {/* Benefits Section */}
      <section className="py-16 md:py-24 bg-card">
        <div className="container mx-auto">
          <div className="text-center mb-12">
            <h2 className="text-foreground mb-4">{t('Varför välja SHS?', 'Why Choose SHS?')}</h2>
            <p className="text-muted-foreground max-w-2xl mx-auto">
              {t(
                'Vi hjälper husägare i Täby att ta kontroll över sin energiförbrukning med smart teknologi',
                'We help Täby homeowners take control of their energy consumption with smart technology'
              )}
            </p>
          </div>
          
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-6">
            {benefits.map((benefit, index) => (
              <div 
                key={index} 
                className="service-card text-center animate-fade-in-up"
                style={{ animationDelay: `${index * 100}ms` }}
              >
                <div className={`icon-container ${benefit.color} mx-auto mb-4`}>
                  <benefit.icon className="w-6 h-6" />
                </div>
                <h3 className="text-lg font-medium mb-2">{benefit.title}</h3>
                <p className="text-sm text-muted-foreground leading-relaxed">{benefit.description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Energy Savings Section */}
      <section className="py-16 md:py-24">
        <div className="container mx-auto">
          <div className="grid lg:grid-cols-2 gap-12 items-center">
            <div>
              <span className="energy-badge mb-6">
                <Zap className="w-4 h-4" />
                {t('Energibesparingar', 'Energy Savings')}
              </span>
              <p className="stat-number text-5xl md:text-6xl mb-2">-34%</p>
              <p className="text-xl text-foreground mb-4">
                {t('Genomsnittlig energiminskning efter SHS-installation', 'Average energy reduction after SHS installation')}
              </p>
              <p className="text-sm text-muted-foreground mb-8">
                {t(
                  'Baserat på 120+ installationer i Täby och närliggande områden under de senaste 12 månaderna',
                  'Based on 120+ installations in Täby and nearby areas over the past 12 months'
                )}
              </p>
              <div className="grid grid-cols-2 gap-8">
                <div>
                  <p className="text-3xl font-light text-primary mb-1">2.3 {t('år', 'yrs')}</p>
                  <p className="text-sm text-muted-foreground">{t('Genomsnittlig återbetalningstid', 'Average payback period')}</p>
                </div>
                <div>
                  <p className="text-3xl font-light text-primary mb-1">15k kr</p>
                  <p className="text-sm text-muted-foreground">{t('Genomsnittlig årlig besparing', 'Avg. annual savings')}</p>
                </div>
              </div>
            </div>
            <div className="bg-card rounded-2xl p-8 border border-border">
              <h4 className="font-medium mb-2">{t('Typisk energiminskningstidslinje', 'Typical Energy Reduction Timeline')}</h4>
              <p className="text-sm text-muted-foreground mb-6">{t('Relativ energiförbrukning efter installation', 'Relative energy consumption after installation')}</p>
              <div className="space-y-4">
                {['100%', '85%', '70%', '66%'].map((value, index) => (
                  <div key={index} className="flex items-center gap-4">
                    <span className="text-sm text-muted-foreground w-12">{['Jan', 'Feb', 'Mar', 'Jun'][index]}</span>
                    <div className="flex-1 bg-muted rounded-full h-2">
                      <div 
                        className="bg-energy-dark h-2 rounded-full transition-all duration-500"
                        style={{ width: value }}
                      />
                    </div>
                    <span className="text-sm font-medium w-12">{value}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Services Preview */}
      <section className="py-16 md:py-24 bg-card">
        <div className="container mx-auto">
          <div className="text-center mb-12">
            <h2 className="text-foreground mb-4">{t('Våra tjänster', 'Our Services')}</h2>
            <p className="text-muted-foreground max-w-2xl mx-auto">
              {t(
                'Kompletta smarta hemlösningar från installation till löpande optimering',
                'Complete smart home solutions from installation to ongoing optimization'
              )}
            </p>
          </div>
          
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
            {services.slice(0, 4).map((service, index) => (
              <div 
                key={index} 
                className="service-card animate-fade-in-up"
                style={{ animationDelay: `${index * 100}ms` }}
              >
                <div className="icon-container bg-primary-lighter/30 text-primary mb-4">
                  <service.icon className="w-5 h-5" />
                </div>
                <h4 className="font-medium mb-2">{service.title}</h4>
                <p className="text-sm text-muted-foreground">{service.description}</p>
              </div>
            ))}
          </div>
          
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6 mb-8">
            {services.slice(4).map((service, index) => (
              <div 
                key={index} 
                className="service-card animate-fade-in-up"
                style={{ animationDelay: `${(index + 4) * 100}ms` }}
              >
                <div className="icon-container bg-energy/30 text-energy-darker mb-4">
                  <service.icon className="w-5 h-5" />
                </div>
                <h4 className="font-medium mb-2">{service.title}</h4>
                <p className="text-sm text-muted-foreground">{service.description}</p>
              </div>
            ))}
          </div>
          
          <div className="text-center">
            <Button asChild variant="outline">
              <Link to="/services">{t('Visa alla tjänster', 'View All Services')}</Link>
            </Button>
          </div>
        </div>
      </section>

      {/* Knowledge Center Preview */}
      <section className="py-16 md:py-24">
        <div className="container mx-auto">
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-12">
            <div>
              <h2 className="text-foreground mb-2">{t('Kunskapscenter', 'Knowledge Center')}</h2>
              <p className="text-muted-foreground">
                {t(
                  'Guider för energibesparingar, smart heminstallation och effektavgift-optimering',
                  'Guides for energy savings, smart home setup, and effektavgift optimization'
                )}
              </p>
            </div>
            <Link to="/knowledge" className="text-primary hover:underline flex items-center gap-2 mt-4 md:mt-0">
              {t('Bläddra bland alla artiklar', 'Browse all articles')} <ArrowRight className="w-4 h-4" />
            </Link>
          </div>
          
          <div className="grid md:grid-cols-3 gap-6">
            {articles.map((article, index) => (
              <Link 
                key={index} 
                to="/knowledge"
                className="knowledge-card group animate-fade-in-up"
                style={{ animationDelay: `${index * 100}ms` }}
              >
                <div className={`${article.categoryColor} h-32 flex items-center justify-center`}>
                  <span className="text-sm font-medium text-foreground/80 bg-card/90 px-3 py-1 rounded-full">
                    {article.category}
                  </span>
                </div>
                <div className="p-6 bg-card border border-border border-t-0 rounded-b-xl">
                  <h4 className="font-medium mb-2 group-hover:text-primary transition-colors">{article.title}</h4>
                  <p className="text-sm text-muted-foreground mb-4">{article.description}</p>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Clock className="w-3 h-3" />
                    <span>{article.readTime} {t('läsning', 'read')}</span>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* Testimonial */}
      <section className="py-16 md:py-24 bg-card">
        <div className="container mx-auto max-w-4xl text-center">
          <div className="w-16 h-16 rounded-full bg-primary-lighter/50 flex items-center justify-center mx-auto mb-8">
            <span className="text-3xl text-primary">"</span>
          </div>
          <blockquote className="testimonial-quote mb-8">
            {t(
              'Vår elräkning sjönk betydligt efter att SHS optimerade vårt hem. Installationen var sömlös och högst professionell. Vi har nu full kontroll över vår energianvändning och effektavgiften är inte längre ett problem.',
              'Our electricity bill dropped significantly after SHS optimized our home. The setup was seamless and highly professional. We now have complete control over our energy usage and the effektavgift is no longer a concern.'
            )}
          </blockquote>
          <div className="mb-4">
            <p className="font-medium text-foreground">Erik Lindström</p>
            <p className="text-sm text-muted-foreground">{t('Husägare i Täby', 'Täby homeowner')} · {t('Installerad april 2024', 'Installed April 2024')}</p>
          </div>
          <div className="flex justify-center gap-1">
            {[...Array(5)].map((_, i) => (
              <Star key={i} className="w-5 h-5 fill-warning text-warning" />
            ))}
          </div>
        </div>
      </section>
    </Layout>
  );
};

export default Index;
