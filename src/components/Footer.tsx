import { Link } from 'react-router-dom';
import { Home, Mail, MapPin, Phone } from 'lucide-react';
import { useLanguage } from '@/contexts/LanguageContext';
import ObfuscatedEmail from '@/components/ObfuscatedEmail';
const Footer = () => {
  const {
    t
  } = useLanguage();
  const serviceLinks = [{
    href: '/services#installation',
    label: t('Smart installation', 'Smart Installation')
  }, {
    href: '/services#energy',
    label: t('Energiövervakning', 'Energy Monitoring')
  }, {
    href: '/services#automation',
    label: t('Hemautomation', 'Home Automation')
  }, {
    href: '/services#support',
    label: t('Support', 'Support')
  }];
  const knowledgeLinks = [{
    href: '/knowledge/effektavgift',
    label: t('Vad är effektavgift?', 'What is Effektavgift?')
  }, {
    href: '/knowledge/load-balancing',
    label: t('Lastbalansering', 'Load Balancing Guide')
  }, {
    href: '/knowledge/sensors',
    label: t('Välja sensorer', 'Sensor Selection')
  }, {
    href: '/knowledge',
    label: t('Alla artiklar', 'All Articles')
  }];
  return <footer className="cta-section text-primary-foreground">
      {/* CTA Section */}
      <div className="container mx-auto pt-16 pb-12 text-center">
        <div className="w-12 h-12 rounded-full bg-primary-foreground/20 flex items-center justify-center mx-auto mb-6">
          <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
          </svg>
        </div>
        <h2 className="text-3xl md:text-4xl font-medium mb-4">
          {t('Redo att optimera din energi?', 'Ready to Optimize Your Energy?')}
        </h2>
        <p className="text-primary-foreground/80 max-w-xl mx-auto mb-8">
          {t('Boka en gratis konsultation med vårt lokala team. Vi analyserar ditt hem och skapar en personlig energioptimeringsplan.', "Get a free consultation with our local team. We'll analyze your home and create a personalized energy optimization plan.")}
        </p>
        <div className="flex flex-col sm:flex-row gap-4 justify-center">
          <Link to="/contact" className="inline-flex items-center justify-center gap-2 px-6 py-3 rounded-lg border border-primary-foreground/30 text-primary-foreground hover:bg-primary-foreground/10 transition-colors font-medium">
            {t('Kontakta oss', 'Contact Us')} →
          </Link>
          <Link to="/contact" className="inline-flex items-center justify-center gap-2 px-6 py-3 rounded-lg bg-primary-foreground text-primary hover:bg-primary-foreground/90 transition-colors font-medium">
            {t('Boka gratis konsultation', 'Schedule Free Consultation')}
          </Link>
        </div>
        <div className="flex flex-wrap justify-center gap-6 mt-8 text-sm text-primary-foreground/70">
          <span>• {t('Ingen förpliktelse', 'No commitment required')}</span>
          <span>• {t('Svar samma dag', 'Same-day response')}</span>
          <span className="">• {t('Lokala experter', 'Local experts')}</span>
        </div>
      </div>

      {/* Footer Links */}
      <div className="border-t border-primary-foreground/20">
        <div className="container mx-auto py-12">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-8">
            {/* Brand */}
            <div className="md:col-span-1">
              <Link to="/" className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 rounded-xl bg-primary-foreground/20 flex items-center justify-center">
                  <Home className="w-5 h-5" />
                </div>
                <span className="text-lg font-semibold">SHS</span>
              </Link>
              <p className="text-sm text-primary-foreground/70 leading-relaxed">
                {t('Smart hemenergioptimering för Täby och omgivande områden. Lokal expertis, professionell service.', 'Smart home energy optimization for Täby and surrounding areas. Local expertise, professional service.')}
              </p>
            </div>

            {/* Services */}
            <div>
              <h4 className="font-medium mb-4">{t('Tjänster', 'Services')}</h4>
              <ul className="space-y-2">
                {serviceLinks.map(link => <li key={link.href}>
                    <Link to={link.href} className="text-sm text-primary-foreground/70 hover:text-primary-foreground transition-colors">
                      {link.label}
                    </Link>
                  </li>)}
              </ul>
            </div>

            {/* Knowledge */}
            <div>
              <h4 className="font-medium mb-4">{t('Kunskapscenter', 'Knowledge')}</h4>
              <ul className="space-y-2">
                {knowledgeLinks.map(link => <li key={link.href}>
                    <Link to={link.href} className="text-sm text-primary-foreground/70 hover:text-primary-foreground transition-colors">
                      {link.label}
                    </Link>
                  </li>)}
              </ul>
            </div>

            {/* Contact */}
            <div>
              <h4 className="font-medium mb-4">{t('Kontakt', 'Contact')}</h4>
              <ul className="space-y-3">
                <li className="flex items-center gap-3 text-sm text-primary-foreground/70">
                  <MapPin className="w-4 h-4" />
                  <span>{t('Täby, Sverige', 'Täby, Sweden')}</span>
                </li>
                <li className="flex items-center gap-3 text-sm text-primary-foreground/70">
                  <Mail className="w-4 h-4" />
                  <ObfuscatedEmail address="sales" domain="smarthomesolutions.se" className="hover:text-primary-foreground transition-colors" />
                </li>
                <li className="flex items-center gap-3 text-sm text-primary-foreground/70">
                  <Phone className="w-4 h-4" />
                  <a className="hover:text-primary-foreground transition-colors" href="tel:+46702870814">
                    +46 70 287 08 14
                  </a>
                </li>
              </ul>
            </div>
          </div>
        </div>
      </div>

      {/* Copyright */}
      <div className="border-t border-primary-foreground/20">
        <div className="container mx-auto py-6">
          <div className="flex flex-col md:flex-row justify-between items-center gap-4 text-sm text-primary-foreground/60">
            <p>© 2025 SHS Smart Home Solutions. {t('Alla rättigheter förbehållna.', 'All rights reserved.')}</p>
            <div className="flex gap-6">
              <Link to="/privacy" className="hover:text-primary-foreground transition-colors">
                {t('Integritet', 'Privacy')}
              </Link>
              <Link to="/terms" className="hover:text-primary-foreground transition-colors">
                {t('Villkor', 'Terms')}
              </Link>
              <Link to="/cookies" className="hover:text-primary-foreground transition-colors">
                Cookies
              </Link>
            </div>
          </div>
        </div>
      </div>
    </footer>;
};
export default Footer;