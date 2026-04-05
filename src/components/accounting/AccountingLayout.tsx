import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import {
  LayoutDashboard,
  Settings,
  Calendar,
  BookOpen,
  ShoppingCart,
  Users,
  CreditCard,
  BarChart3,
  FileText,
  Receipt,
  Shield,
  PenLine,
  Home,
} from 'lucide-react';
import { isTestEnvironment } from '@/lib/environment';
import UserMenu from '@/components/UserMenu';

interface AccountingLayoutProps {
  children: React.ReactNode;
}

interface NavItem {
  href: string;
  label: string;
  icon: React.ReactNode;
}

interface NavGroup {
  title: string;
  items: NavItem[];
}

const navGroups: NavGroup[] = [
  {
    title: 'KONTROLL',
    items: [
      { href: '/accounting/overview', label: 'Översikt', icon: <LayoutDashboard className="w-4 h-4" /> },
      { href: '/accounting/periods', label: 'Perioder', icon: <Calendar className="w-4 h-4" /> },
    ],
  },
  {
    title: 'BOKFÖRING',
    items: [
      { href: '/accounting/journal', label: 'Journal', icon: <BookOpen className="w-4 h-4" /> },
      { href: '/accounting/manual-verifications/new', label: 'Manuell verifikation', icon: <PenLine className="w-4 h-4" /> },
    ],
  },
  {
    title: 'INKÖP',
    items: [
      { href: '/accounting/purchases', label: 'Inköp', icon: <ShoppingCart className="w-4 h-4" /> },
      { href: '/accounting/suppliers', label: 'Leverantörer', icon: <Users className="w-4 h-4" /> },
    ],
  },
  {
    title: 'MOMS',
    items: [
      { href: '/accounting/vat-periods', label: 'Momsperioder', icon: <Receipt className="w-4 h-4" /> },
    ],
  },
];

const AccountingLayout: React.FC<AccountingLayoutProps> = ({ children }) => {
  const location = useLocation();

  const isActive = (path: string) => {
    if (path === '/accounting/overview') return location.pathname === '/accounting/overview' || location.pathname === '/accounting';
    return location.pathname === path || location.pathname.startsWith(path + '/');
  };

  return (
    <div className="min-h-screen bg-background flex">
      {isTestEnvironment() && (
        <div className="fixed top-0 left-0 right-0 z-50 bg-amber-500 text-black text-center text-sm py-1 font-medium">
          ⚠️ TESTMILJÖ – All data är endast för testning
        </div>
      )}

      {/* Sidebar */}
      <aside className={`fixed left-0 top-0 bottom-0 w-56 bg-card border-r border-border flex flex-col ${isTestEnvironment() ? 'pt-8' : ''}`}>
        {/* Logo */}
        <div className="px-4 py-5 flex items-center gap-2.5">
          <Link to="/accounting/overview" className="flex items-center gap-2.5">
            <Home className="w-5 h-5 text-primary" />
            <div>
              <div className="text-sm font-semibold text-foreground leading-tight">SHS</div>
              <div className="text-xs text-muted-foreground leading-tight">Accounting</div>
            </div>
          </Link>
        </div>

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto px-3 pb-4">
          {navGroups.map((group) => (
            <div key={group.title} className="mb-5">
              <div className="text-[10px] font-semibold text-muted-foreground tracking-wider px-2 mb-1.5">
                {group.title}
              </div>
              {group.items.map((item) => (
                <Link
                  key={item.href}
                  to={item.href}
                  className={`flex items-center gap-2.5 px-2.5 py-2 rounded-md text-sm transition-colors mb-0.5 ${
                    isActive(item.href)
                      ? 'bg-primary text-primary-foreground font-medium'
                      : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                  }`}
                >
                  {item.icon}
                  {item.label}
                </Link>
              ))}
            </div>
          ))}
        </nav>
      </aside>

      {/* Main */}
      <div className="flex-1 ml-56">
        {/* Top bar */}
        <header className={`sticky top-0 z-40 bg-card/95 backdrop-blur-sm border-b border-border h-14 flex items-center justify-end px-6 ${isTestEnvironment() ? 'mt-7' : ''}`}>
          <UserMenu />
        </header>

        {/* Content */}
        <main className="px-8 py-8">
          {children}
        </main>
      </div>
    </div>
  );
};

export default AccountingLayout;
