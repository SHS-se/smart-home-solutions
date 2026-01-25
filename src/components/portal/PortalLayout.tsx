import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Building2, FileText, MessageSquare, Users, LayoutDashboard, Contact2 } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useLanguage } from '@/contexts/LanguageContext';
import Header from '@/components/Header';

interface PortalLayoutProps {
  children: React.ReactNode;
}

const PortalLayout: React.FC<PortalLayoutProps> = ({ children }) => {
  const { isStaff } = useAuth();
  const location = useLocation();
  const { t } = useLanguage();

  const customerNavItems = [
    { href: '/portal', label: t('Översikt', 'Dashboard'), icon: LayoutDashboard },
    { href: '/portal/account', label: t('Konto', 'Account'), icon: Building2 },
    { href: '/portal/billing', label: t('Fakturor', 'Billing'), icon: FileText },
    { href: '/portal/tickets', label: t('Ärenden', 'Tickets'), icon: MessageSquare },
  ];

  const staffNavItems = [
    { href: '/portal', label: t('Översikt', 'Dashboard'), icon: LayoutDashboard },
    { href: '/portal/customers', label: t('Kunder', 'Customers'), icon: Users },
    { href: '/portal/contacts', label: t('Kontakter', 'Contacts'), icon: Contact2 },
    { href: '/portal/tickets', label: t('Alla ärenden', 'All Tickets'), icon: MessageSquare },
  ];

  const navItems = isStaff ? staffNavItems : customerNavItems;

  const isActive = (path: string) => {
    if (path === '/portal') {
      return location.pathname === '/portal';
    }
    return location.pathname.startsWith(path);
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Use shared Header component */}
      <Header />

      {/* Mobile bottom nav for portal-specific navigation */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 z-50 bg-card border-t border-border">
        <div className="flex items-center justify-around h-16">
          {navItems.map(item => {
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                to={item.href}
                className={`flex flex-col items-center justify-center flex-1 h-full text-xs font-medium transition-colors ${
                  isActive(item.href) ? 'text-primary' : 'text-muted-foreground'
                }`}
              >
                <Icon className="w-5 h-5 mb-1" />
                {item.label}
              </Link>
            );
          })}
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
