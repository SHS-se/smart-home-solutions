import { Link } from 'react-router-dom';
import { Clock, ArrowRight, Zap, Home, Settings, Wifi, Thermometer, TrendingDown } from 'lucide-react';
import { useLanguage } from '@/contexts/LanguageContext';
import Layout from '@/components/Layout';

const Knowledge = () => {
  const { t } = useLanguage();

  const categories = [
    { id: 'energy', label: t('Energigrunder', 'Energy Basics'), color: 'bg-primary-lighter' },
    { id: 'automation', label: t('Automation', 'Automation'), color: 'bg-energy' },
    { id: 'installation', label: t('Installation', 'Installation'), color: 'bg-muted' },
    { id: 'effektavgift', label: t('Effektavgift', 'Effektavgift'), color: 'bg-warning/50' },
  ];

  const articles = [
    {
      slug: 'effektavgift',
      category: 'energy',
      categoryLabel: t('Energigrunder', 'Energy Basics'),
      categoryColor: 'bg-primary-lighter',
      icon: Zap,
      title: t('Vad är effektavgift?', 'What Is Effektavgift?'),
      description: t(
        'Den svenska effektavgiften baseras på din högsta effekttopp under månaden. Förstå hur den beräknas och varför den kan göra stor skillnad på din elräkning.',
        'The Swedish effektavgift is based on your highest power peak during the month. Understand how it is calculated and why it can make a big difference on your electricity bill.'
      ),
      readTime: '5 min',
      featured: true,
    },
    {
      slug: 'load-balancing',
      category: 'automation',
      categoryLabel: t('Automation', 'Automation'),
      categoryColor: 'bg-energy',
      icon: TrendingDown,
      title: t('Hur lastbalansering fungerar i ett smart hem', 'How Load Balancing Works in a Smart Home'),
      description: t(
        'Intelligent lastbalansering fördelar din energianvändning över tid för att undvika höga effekttoppar. Lär dig hur automation kan sänka din effektavgift.',
        'Intelligent load balancing distributes your energy usage over time to avoid high power peaks. Learn how automation can lower your effektavgift.'
      ),
      readTime: '7 min',
      featured: true,
    },
    {
      slug: 'sensors',
      category: 'installation',
      categoryLabel: t('Installation', 'Installation'),
      categoryColor: 'bg-muted',
      icon: Thermometer,
      title: t('Välja sensorer för ditt Täby-hem', 'Choosing Sensors for Your Täby Home'),
      description: t(
        'En praktisk guide för att välja rätt sensorer för ditt hem. Vi går igenom temperatur-, rörelse- och energisensorer.',
        'A practical guide to choosing the right sensors for your home. We cover temperature, motion, and energy sensors.'
      ),
      readTime: '6 min',
      featured: true,
    },
    {
      slug: 'home-assistant-intro',
      category: 'automation',
      categoryLabel: t('Automation', 'Automation'),
      categoryColor: 'bg-energy',
      icon: Settings,
      title: t('Introduktion till Home Assistant', 'Introduction to Home Assistant'),
      description: t(
        'Home Assistant är en kraftfull plattform för hemautomation. Lär dig grunderna och varför det är ett utmärkt val för ditt smarta hem.',
        'Home Assistant is a powerful home automation platform. Learn the basics and why it is an excellent choice for your smart home.'
      ),
      readTime: '8 min',
      featured: false,
    },
    {
      slug: 'smart-thermostats',
      category: 'installation',
      categoryLabel: t('Installation', 'Installation'),
      categoryColor: 'bg-muted',
      icon: Thermometer,
      title: t('Smarta termostater: Komplett guide', 'Smart Thermostats: Complete Guide'),
      description: t(
        'Allt du behöver veta om smarta termostater. Från val av rätt modell till installation och konfiguration.',
        'Everything you need to know about smart thermostats. From choosing the right model to installation and configuration.'
      ),
      readTime: '10 min',
      featured: false,
    },
    {
      slug: 'wifi-optimization',
      category: 'installation',
      categoryLabel: t('Installation', 'Installation'),
      categoryColor: 'bg-muted',
      icon: Wifi,
      title: t('WiFi-optimering för smarta hem', 'WiFi Optimization for Smart Homes'),
      description: t(
        'Ett stabilt nätverk är grunden för ett fungerande smart hem. Lär dig hur du optimerar din WiFi-täckning.',
        'A stable network is the foundation for a functioning smart home. Learn how to optimize your WiFi coverage.'
      ),
      readTime: '6 min',
      featured: false,
    },
    {
      slug: 'presence-detection',
      category: 'automation',
      categoryLabel: t('Automation', 'Automation'),
      categoryColor: 'bg-energy',
      icon: Home,
      title: t('Närvarodetektering: Teknik och tillämpningar', 'Presence Detection: Technology and Applications'),
      description: t(
        'Automatisera ditt hem baserat på vem som är hemma. Vi förklarar olika tekniker och hur du implementerar dem.',
        'Automate your home based on who is home. We explain different technologies and how to implement them.'
      ),
      readTime: '7 min',
      featured: false,
    },
    {
      slug: 'reduce-electricity',
      category: 'energy',
      categoryLabel: t('Energigrunder', 'Energy Basics'),
      categoryColor: 'bg-primary-lighter',
      icon: Zap,
      title: t('10 sätt att sänka elförbrukningen', '10 Ways to Reduce Electricity Usage'),
      description: t(
        'Praktiska tips för att minska din elförbrukning utan att kompromissa med komforten. Från enkla vanor till smart automation.',
        'Practical tips for reducing your electricity consumption without compromising comfort. From simple habits to smart automation.'
      ),
      readTime: '5 min',
      featured: false,
    },
  ];

  const featuredArticles = articles.filter(a => a.featured);
  const otherArticles = articles.filter(a => !a.featured);

  return (
    <Layout>
      {/* Hero */}
      <section className="py-16 md:py-24 hero-gradient">
        <div className="container mx-auto">
          <h1 className="text-foreground mb-4">{t('Kunskapscenter', 'Knowledge Center')}</h1>
          <p className="text-lg text-muted-foreground max-w-2xl">
            {t(
              'Guider och artiklar om energibesparingar, smart heminstallation och effektavgift-optimering.',
              'Guides and articles about energy savings, smart home setup, and effektavgift optimization.'
            )}
          </p>
        </div>
      </section>

      {/* Categories */}
      <section className="py-8 bg-card border-b border-border">
        <div className="container mx-auto">
          <div className="flex flex-wrap gap-3">
            {categories.map((cat) => (
              <button
                key={cat.id}
                className={`px-4 py-2 rounded-full text-sm font-medium transition-colors ${cat.color} text-foreground/80 hover:opacity-90`}
              >
                {cat.label}
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* Featured Articles */}
      <section className="py-16 md:py-24">
        <div className="container mx-auto">
          <h2 className="text-2xl font-medium text-foreground mb-8">
            {t('Utvalda artiklar', 'Featured Articles')}
          </h2>
          <div className="grid md:grid-cols-3 gap-6 mb-16">
            {featuredArticles.map((article, index) => (
              <Link
                key={article.slug}
                to={`/knowledge/${article.slug}`}
                className="knowledge-card group animate-fade-in-up"
                style={{ animationDelay: `${index * 100}ms` }}
              >
                <div className={`${article.categoryColor} h-40 flex items-center justify-center relative`}>
                  <article.icon className="w-16 h-16 opacity-20" />
                  <span className="absolute top-4 left-4 text-xs font-medium text-foreground/80 bg-card/90 px-3 py-1 rounded-full">
                    {article.categoryLabel}
                  </span>
                </div>
                <div className="p-6 bg-card border border-border border-t-0 rounded-b-xl">
                  <h3 className="font-medium text-lg mb-2 group-hover:text-primary transition-colors">
                    {article.title}
                  </h3>
                  <p className="text-sm text-muted-foreground mb-4 line-clamp-2">
                    {article.description}
                  </p>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Clock className="w-3 h-3" />
                    <span>{article.readTime} {t('läsning', 'read')}</span>
                  </div>
                </div>
              </Link>
            ))}
          </div>

          {/* All Articles */}
          <h2 className="text-2xl font-medium text-foreground mb-8">
            {t('Alla artiklar', 'All Articles')}
          </h2>
          <div className="grid md:grid-cols-2 gap-6">
            {otherArticles.map((article, index) => (
              <Link
                key={article.slug}
                to={`/knowledge/${article.slug}`}
                className="service-card flex gap-6 group"
              >
                <div className={`${article.categoryColor} w-24 h-24 rounded-xl flex items-center justify-center flex-shrink-0`}>
                  <article.icon className="w-8 h-8 opacity-40" />
                </div>
                <div className="flex-1 min-w-0">
                  <span className="text-xs font-medium text-muted-foreground">{article.categoryLabel}</span>
                  <h3 className="font-medium mb-2 group-hover:text-primary transition-colors">
                    {article.title}
                  </h3>
                  <p className="text-sm text-muted-foreground line-clamp-2 mb-2">
                    {article.description}
                  </p>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Clock className="w-3 h-3" />
                    <span>{article.readTime} {t('läsning', 'read')}</span>
                  </div>
                </div>
                <ArrowRight className="w-5 h-5 text-muted-foreground group-hover:text-primary transition-colors flex-shrink-0 self-center" />
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* Newsletter CTA */}
      <section className="py-16 md:py-24 bg-card">
        <div className="container mx-auto text-center max-w-2xl">
          <h2 className="text-foreground mb-4">
            {t('Vill du lära dig mer?', 'Want to Learn More?')}
          </h2>
          <p className="text-muted-foreground mb-8">
            {t(
              'Kontakta oss för en personlig konsultation så kan vi diskutera hur dessa koncept kan tillämpas på just ditt hem.',
              "Contact us for a personal consultation and we can discuss how these concepts can be applied to your specific home."
            )}
          </p>
          <Link
            to="/contact"
            className="inline-flex items-center gap-2 text-primary hover:underline font-medium"
          >
            {t('Boka en konsultation', 'Book a Consultation')} <ArrowRight className="w-4 h-4" />
          </Link>
        </div>
      </section>
    </Layout>
  );
};

export default Knowledge;
