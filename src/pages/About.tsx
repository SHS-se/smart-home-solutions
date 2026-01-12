import { Link } from 'react-router-dom';
import { MapPin, Heart, Lightbulb, Users, CheckCircle } from 'lucide-react';
import { useLanguage } from '@/contexts/LanguageContext';
import Layout from '@/components/Layout';
import { Button } from '@/components/ui/button';

const About = () => {
  const { t } = useLanguage();

  const values = [
    {
      icon: Heart,
      title: t('Lokalt engagemang', 'Local Commitment'),
      description: t(
        'Baserade i Täby med djup förståelse för svenska hem och energisystem.',
        'Based in Täby with deep understanding of Swedish homes and energy systems.'
      ),
    },
    {
      icon: Lightbulb,
      title: t('Praktisk expertis', 'Practical Expertise'),
      description: t(
        'Hands-on erfarenhet av hundratals installationer och optimeringar.',
        'Hands-on experience with hundreds of installations and optimizations.'
      ),
    },
    {
      icon: Users,
      title: t('Personlig service', 'Personal Service'),
      description: t(
        'Direkt kontakt med experter som bryr sig om ditt projekt.',
        'Direct contact with experts who care about your project.'
      ),
    },
  ];

  const approach = [
    t('Vi börjar alltid med att förstå dina behov och mål', 'We always start by understanding your needs and goals'),
    t('Inga onödiga produkter – bara det du faktiskt behöver', 'No unnecessary products – only what you actually need'),
    t('Ärliga rekommendationer baserade på verklig erfarenhet', 'Honest recommendations based on real experience'),
    t('Fokus på långsiktiga besparingar och hållbarhet', 'Focus on long-term savings and sustainability'),
    t('Support som finns där när du behöver den', 'Support that is there when you need it'),
  ];

  return (
    <Layout>
      {/* Hero */}
      <section className="py-16 md:py-24 hero-gradient">
        <div className="container mx-auto">
          <div className="max-w-3xl">
            <div className="flex items-center gap-2 text-primary mb-4">
              <MapPin className="w-5 h-5" />
              <span className="text-sm font-medium">{t('Täby, Sverige', 'Täby, Sweden')}</span>
            </div>
            <h1 className="text-foreground mb-6">{t('Om SHS', 'About SHS')}</h1>
            <p className="text-xl text-muted-foreground leading-relaxed">
              {t(
                'SHS – Smart Home Solutions är ett lokalt Täby-baserat företag som hjälper husägare att ta kontroll över sin energiförbrukning genom smart hemteknik.',
                'SHS – Smart Home Solutions is a local Täby-based company helping homeowners take control of their energy consumption through smart home technology.'
              )}
            </p>
          </div>
        </div>
      </section>

      {/* Our Story */}
      <section className="py-16 md:py-24">
        <div className="container mx-auto">
          <div className="grid lg:grid-cols-2 gap-12 items-center">
            <div>
              <h2 className="text-foreground mb-6">{t('Vår historia', 'Our Story')}</h2>
              <div className="space-y-4 text-muted-foreground leading-relaxed">
                <p>
                  {t(
                    'SHS grundades av en lokal Täby-bo med över 25 års erfarenhet inom IT och systemutveckling, med starkt fokus på att använda teknik för att lösa verkliga problem. Företaget startade med ett enkelt mål: minska onödig energiförbrukning och återta kontrollen över tekniken i hemmet.',
                    'SHS was founded by a local Täby resident with over 25 years of experience in IT and system development, and a strong focus on using technology to solve real-world problems. The company started with a simple goal: reduce unnecessary energy consumption and regain control over the technology in the home.'
                  )}
                </p>
                <p>
                  {t(
                    'Efter att ha optimerat sitt eget hem och uppnått betydande, mätbara minskningar av elkostnader tillsammans med förbättrad komfort och tillförlitlighet, skiftade fokus till att hjälpa grannar och lokala husägare uppnå liknande resultat.',
                    'After optimizing their own home and delivering significant, measurable reductions in electricity costs together with improved comfort and reliability, the focus shifted to helping neighbors and local homeowners achieve similar results.'
                  )}
                </p>
                <p>
                  {t(
                    'Varje hem är unikt. Därför tar SHS sig tid att förstå hur ditt hushåll faktiskt fungerar innan vi rekommenderar eller installerar något. Lösningar designas för att vara robusta, begripliga och underhållbara över tid. Teknik ska ge husägare kontroll, inte låsa in dem i komplexa eller ogenomskinliga system.',
                    'Every home is different. That\'s why SHS takes the time to understand how your household actually works before recommending or installing anything. Solutions are designed to be robust, understandable, and maintainable over time. Technology should empower homeowners, not lock them into complex or opaque systems.'
                  )}
                </p>
                <p className="font-medium text-foreground">
                  {t('Våra principer är enkla:', 'Our principles are simple:')}
                </p>
                <ul className="list-disc list-inside space-y-2">
                  <li>{t('Öppna system med lokal kontroll som du äger', 'Open systems with local control that you own')}</li>
                  <li>{t('Undvik beroende av proprietära plattformar eller tredjepartstjänster i molnet', 'Avoid dependency on proprietary platforms or third-party cloud services')}</li>
                  <li>{t('Frihet att utöka, modifiera eller underhålla systemet utan leverantörsinlåsning', 'Freedom to expand, modify, or maintain the system without vendor lock-in')}</li>
                  <li>{t('Ingen överkomplicering eller onödiga produkter', 'No over-complication or unnecessary products')}</li>
                  <li>{t('Fokus på tillförlitlighet, livslängd och verkliga, mätbara besparingar', 'Focus on reliability, longevity, and real, measurable savings')}</li>
                  <li>{t('Säkerhet, trygghet och bekvämlighet som du bestämmer', 'Security, safety and convenience that you decide')}</li>
                </ul>
                <p>
                  {t(
                    'Målet är enkelt: praktiska smarta hemlösningar som minskar kostnader, förbättrar vardagen och förblir under din kontroll.',
                    'The goal is simple: practical smart home solutions that reduce costs, improve everyday life, and remain under your control.'
                  )}
                </p>
              </div>
            </div>
            <div className="rounded-2xl h-80 overflow-hidden">
              <iframe
                src="https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d32505.89584853697!2d18.04!3d59.44!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1!3m3!1m2!1s0x465f9e5a5a5a5a5b%3A0x5a5a5a5a5a5a5a5a!2sT%C3%A4by%2C%20Sweden!5e0!3m2!1sen!2sse!4v1699999999999!5m2!1sen!2sse"
                width="100%"
                height="100%"
                style={{ border: 0 }}
                allowFullScreen
                loading="lazy"
                referrerPolicy="no-referrer-when-downgrade"
                title="SHS Location - Täby, Sweden"
              />
            </div>
          </div>
        </div>
      </section>

      {/* Values */}
      <section className="py-16 md:py-24 bg-card">
        <div className="container mx-auto">
          <h2 className="text-foreground text-center mb-12">
            {t('Vad vi står för', 'What We Stand For')}
          </h2>
          <div className="grid md:grid-cols-3 gap-8">
            {values.map((value, index) => (
              <div key={index} className="text-center">
                <div className="icon-container bg-primary-lighter/30 text-primary mx-auto mb-4">
                  <value.icon className="w-6 h-6" />
                </div>
                <h3 className="font-medium text-lg mb-2">{value.title}</h3>
                <p className="text-muted-foreground">{value.description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Our Approach */}
      <section className="py-16 md:py-24">
        <div className="container mx-auto">
          <div className="max-w-3xl mx-auto">
            <h2 className="text-foreground text-center mb-12">
              {t('Vårt arbetssätt', 'Our Approach')}
            </h2>
            <div className="space-y-4">
              {approach.map((item, index) => (
                <div key={index} className="flex items-start gap-4 p-4 rounded-xl bg-card border border-border">
                  <CheckCircle className="w-6 h-6 text-energy-dark flex-shrink-0 mt-0.5" />
                  <p className="text-foreground">{item}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Service Area */}
      <section className="py-16 md:py-24 bg-card">
        <div className="container mx-auto text-center">
          <h2 className="text-foreground mb-4">{t('Vårt serviceområde', 'Our Service Area')}</h2>
          <p className="text-muted-foreground max-w-2xl mx-auto mb-8">
            {t(
              'Vi är baserade i Täby och betjänar husägare och småföretag i hela norra Storstockholm, inklusive Danderyd, Vallentuna, Österåker, Sollentuna och Upplands Väsby.',
              'We are based in Täby and serve homeowners and small businesses throughout northern Greater Stockholm, including Danderyd, Vallentuna, Österåker, Sollentuna, and Upplands Väsby.'
            )}
          </p>
          <div className="flex flex-wrap justify-center gap-3">
            {['Täby', 'Danderyd', 'Vallentuna', 'Österåker', 'Sollentuna', 'Upplands Väsby'].map((area) => (
              <span key={area} className="px-4 py-2 bg-muted rounded-full text-sm">
                {area}
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="py-16 md:py-24">
        <div className="container mx-auto text-center">
          <h2 className="text-foreground mb-4">
            {t('Låt oss prata', "Let's Talk")}
          </h2>
          <p className="text-muted-foreground max-w-xl mx-auto mb-8">
            {t(
              'Vi börjar alltid med en kostnadsfri konsultation för att förstå dina behov. Ingen förpliktelse.',
              'We always start with a free consultation to understand your needs. No obligation.'
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

export default About;
