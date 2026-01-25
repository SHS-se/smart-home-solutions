import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useLanguage } from '@/contexts/LanguageContext';
import Header from '@/components/Header';

interface PortalLayoutProps {
  children: React.ReactNode;
}

const PortalLayout: React.FC<PortalLayoutProps> = ({ children }) => {
  const location = useLocation();
  const { t } = useLanguage();

  const navLinks = [
    { href: "/services", label: t("Tjänster", "Services") },
    { href: "/knowledge", label: t("Kunskapscenter", "Knowledge") },
    { href: "/about", label: t("Om oss", "About") },
  ];

  const isActive = (path: string) => location.pathname === path;

  return (
    <div className="min-h-screen bg-background">
      {/* Use shared Header component */}
      <Header />

      {/* Mobile bottom nav - same as home page */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 z-50 bg-card/95 backdrop-blur-md border-t border-border">
        <div className="container mx-auto">
          <div className="flex items-center justify-around h-14">
            {navLinks.map(link => (
              <Link
                key={link.href}
                to={link.href}
                className={`flex-1 flex items-center justify-center py-3 text-sm font-medium transition-colors ${
                  isActive(link.href) ? "text-primary" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {link.label}
              </Link>
            ))}
          </div>
        </div>
      </nav>

      {/* Main content */}
      <main className="pt-16 pb-20 md:pt-20 md:pb-8">
        <div className="container mx-auto px-4 py-8">
          {children}
        </div>
      </main>

      {/* Footer */}
      <footer className="hidden md:block border-t border-border py-6">
        <div className="container mx-auto px-4">
          <p className="text-center text-sm text-muted-foreground">
            © {new Date().getFullYear()} Smart Home Solutions. {t('Täby, Sverige.', 'Täby, Sweden.')}
          </p>
        </div>
      </footer>
    </div>
  );
};

export default PortalLayout;
