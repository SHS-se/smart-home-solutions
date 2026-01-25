import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Building2, FileText, MessageSquare, LayoutDashboard } from 'lucide-react';
import { useViewedCustomer } from '@/contexts/ViewedCustomerContext';
import { useLanguage } from '@/contexts/LanguageContext';
import Header from '@/components/Header';

interface CustomerViewLayoutProps {
  children: React.ReactNode;
}

const CustomerViewLayout: React.FC<CustomerViewLayoutProps> = ({ children }) => {
  const { customerId } = useViewedCustomer();
  const location = useLocation();
  const { t } = useLanguage();

  const baseUrl = `/portal/customers/${customerId}`;

  const navItems = [
    { href: `${baseUrl}/overview`, label: t('Översikt', 'Overview'), icon: LayoutDashboard },
    { href: `${baseUrl}/account`, label: t('Konto', 'Account'), icon: Building2 },
    { href: `${baseUrl}/billing`, label: t('Fakturor', 'Invoices'), icon: FileText },
    { href: `${baseUrl}/tickets`, label: t('Ärenden', 'Tickets'), icon: MessageSquare },
  ];

  const isActive = (path: string) => {
    return location.pathname === path || location.pathname.startsWith(path + '/');
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Use shared Header component */}
      <Header />

      {/* Mobile bottom nav for customer view navigation */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 z-50 bg-card border-t border-border">
        <div className="flex items-center justify-around h-16">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                to={item.href}
                className={`flex flex-col items-center justify-center flex-1 h-full text-xs font-medium transition-colors ${
                  isActive(item.href)
                    ? 'text-primary'
                    : 'text-muted-foreground'
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

export default CustomerViewLayout;
