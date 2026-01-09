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
                    'SHS grundades av en lokal Täby-bo med ett brinnande intresse för smart hemteknik och en frustration över höga elräkningar. Efter att ha optimerat sitt eget hem och sett dramatiska besparingar, blev nästa steg naturligt – att hjälpa grannar och vänner göra samma sak.',
                    'SHS was founded by a local Täby resident with a burning interest in smart home technology and a frustration with high electricity bills. After optimizing their own home and seeing dramatic savings, the next step was natural – helping neighbors and friends do the same.'
                  )}
                </p>
                <p>
                  {t(
                    'Idag har vi genomfört över 120 installationer i Täby och omgivande områden. Varje hem är unikt, och vi tar oss tid att förstå just dina behov innan vi rekommenderar lösningar.',
                    'Today we have completed over 120 installations in Täby and surrounding areas. Every home is unique, and we take time to understand your specific needs before recommending solutions.'
                  )}
                </p>
                <p>
                  {t(
                    'Vår filosofi är enkel: ingen överkomplicering, inga onödiga produkter, och alltid fokus på verkliga besparingar. Vi tror på att förklara tekniken på ett sätt som alla förstår.',
                    'Our philosophy is simple: no over-complication, no unnecessary products, and always focus on real savings. We believe in explaining technology in a way everyone understands.'
                  )}
                </p>
              </div>
            </div>
            <div className="bg-primary-lighter/30 rounded-2xl h-80 flex items-center justify-center">
              <MapPin className="w-24 h-24 text-primary opacity-30" />
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
