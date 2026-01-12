import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Menu, X } from 'lucide-react';
import { useLanguage } from '@/contexts/LanguageContext';
import LanguageToggle from './LanguageToggle';
import { Button } from './ui/button';
import shsLogo from '@/assets/shs-logo.png';

const Header = () => {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const {
    t
  } = useLanguage();
  const location = useLocation();
  const navLinks = [{
    href: '/services',
    label: t('Tjänster', 'Services')
  }, {
    href: '/knowledge',
    label: t('Kunskapscenter', 'Knowledge')
  }, {
    href: '/about',
    label: t('Om oss', 'About')
  }];
  const isActive = (path: string) => location.pathname === path;
  return <header className="fixed top-0 left-0 right-0 z-50 bg-card/95 backdrop-blur-md border-b border-border">
      <div className="container mx-auto">
        <div className="flex items-center justify-between h-16 md:h-20">
          {/* Logo */}
          <Link to="/" className="flex items-center gap-3 group">
            <img 
              src={shsLogo} 
              alt="SHS Logo" 
              className="w-10 h-10 rounded-xl transition-transform duration-200 group-hover:scale-105"
            />
            <span className="text-sm font-medium text-muted-foreground">Smart Home Solutions</span>
          </Link>

          {/* Desktop Navigation */}
          <nav className="hidden md:flex items-center gap-8">
            {navLinks.map(link => <Link key={link.href} to={link.href} className={`nav-link text-sm font-medium py-2 ${isActive(link.href) ? 'text-primary' : ''}`}>
                {link.label}
              </Link>)}
          </nav>

          {/* Desktop Actions */}
          <div className="hidden md:flex items-center gap-4">
            <LanguageToggle />
            <Button asChild>
              <Link to="/contact">{t('Kontakt', 'Contact')}</Link>
            </Button>
          </div>

          {/* Mobile Menu Button */}
          <button onClick={() => setIsMenuOpen(!isMenuOpen)} className="md:hidden p-2 text-foreground" aria-label="Toggle menu">
            {isMenuOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
          </button>
        </div>

        {/* Mobile Menu */}
        {isMenuOpen && <div className="md:hidden py-4 border-t border-border animate-fade-in">
            <nav className="flex flex-col gap-2">
              {navLinks.map(link => <Link key={link.href} to={link.href} onClick={() => setIsMenuOpen(false)} className={`px-4 py-3 rounded-lg text-sm font-medium transition-colors ${isActive(link.href) ? 'bg-primary/10 text-primary' : 'text-foreground hover:bg-muted'}`}>
                  {link.label}
                </Link>)}
              <div className="flex items-center justify-between px-4 pt-4 border-t border-border mt-2">
                <LanguageToggle />
                <Button asChild size="sm">
                  <Link to="/contact" onClick={() => setIsMenuOpen(false)}>
                    {t('Kontakt', 'Contact')}
                  </Link>
                </Button>
              </div>
            </nav>
          </div>}
      </div>
    </header>;
};
export default Header;