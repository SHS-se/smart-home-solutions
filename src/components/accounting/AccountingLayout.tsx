import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useLanguage } from '@/contexts/LanguageContext';
import {
  LayoutDashboard,
  Calendar,
  BookOpen,
  ShoppingCart,
  Users,
  Receipt,
  PenLine,
} from 'lucide-react';
import UserMenu from '@/components/UserMenu';
import LanguageToggle from '@/components/LanguageToggle';
import ShsLogo from '@/components/ShsLogo';
import { useAuth } from '@/contexts/AuthContext';

interface AccountingLayoutProps {
  children: React.ReactNode;
}

interface NavItem {
  href: string;
  labelSv: string;
  labelEn: string;
  icon: React.ReactNode;
}

interface NavGroup {
  titleSv: string;
  titleEn: string;
  items: NavItem[];
}

const navGroups: NavGroup[] = [
  {
    titleSv: 'KONTROLL',
    titleEn: 'CONTROL',
    items: [
      { href: '/accounting/overview', labelSv: 'Översikt', labelEn: 'Overview', icon: <LayoutDashboard className="w-4 h-4" /> },
      { href: '/accounting/periods', labelSv: 'Perioder', labelEn: 'Periods', icon: <Calendar className="w-4 h-4" /> },
    ],
  },
  {
    titleSv: 'BOKFÖRING',
    titleEn: 'ACCOUNTING',
    items: [
      { href: '/accounting/journal', labelSv: 'Journal', labelEn: 'Journal', icon: <BookOpen className="w-4 h-4" /> },
      { href: '/accounting/manual-verifications/new', labelSv: 'Manuell verifikation', labelEn: 'Manual entry', icon: <PenLine className="w-4 h-4" /> },
    ],
  },
  {
    titleSv: 'INKÖP',
    titleEn: 'PURCHASES',
    items: [
      { href: '/accounting/purchases', labelSv: 'Inköp', labelEn: 'Purchases', icon: <ShoppingCart className="w-4 h-4" /> },
      { href: '/accounting/suppliers', labelSv: 'Leverantörer', labelEn: 'Suppliers', icon: <Users className="w-4 h-4" /> },
    ],
  },
  {
    titleSv: 'MOMS',
    titleEn: 'VAT',
    items: [
      { href: '/accounting/vat-periods', labelSv: 'Momsperioder', labelEn: 'VAT periods', icon: <Receipt className="w-4 h-4" /> },
    ],
  },
];

const AccountingLayout: React.FC<AccountingLayoutProps> = ({ children }) => {
  const location = useLocation();
  const { t } = useLanguage();
  const { isAdmin } = useAuth();
  const resolvedNavGroups = isAdmin
    ? [
        ...navGroups,
        {
          titleSv: 'INTEGRITET',
          titleEn: 'INTEGRITY',
          items: [
            { href: '/accounting/integrity/currency-repair', labelSv: 'Valutareparation', labelEn: 'Currency repair', icon: <Receipt className="w-4 h-4" /> },
          ],
        },
      ]
    : navGroups;

  const isActive = (path: string) => {
    if (path === '/accounting/overview') return location.pathname === '/accounting/overview' || location.pathname === '/accounting';
    return location.pathname === path || location.pathname.startsWith(path + '/');
  };

  return (
    <div className="min-h-screen bg-background flex">
      {/* Sidebar */}
      <aside className="fixed left-0 top-0 bottom-0 w-56 bg-card border-r border-border flex flex-col">
        {/* Logo */}
        <div className="px-4 py-5 flex items-center gap-2.5">
          <Link to="/accounting/overview" className="flex items-center gap-2.5">
            <ShsLogo size={36} />
            <div>
              <div className="text-sm font-semibold text-foreground leading-tight">Smart Home Solutions</div>
              <div className="text-xs text-muted-foreground leading-tight">{t('Bokföring', 'Accounting')}</div>
            </div>
          </Link>
        </div>

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto px-3 pb-4">
          {resolvedNavGroups.map((group) => (
            <div key={group.titleSv} className="mb-5">
              <div className="text-[10px] font-semibold text-muted-foreground tracking-wider px-2 mb-1.5">
                {t(group.titleSv, group.titleEn)}
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
                  {t(item.labelSv, item.labelEn)}
                </Link>
              ))}
            </div>
          ))}
        </nav>
      </aside>

      {/* Main */}
      <div className="flex-1 ml-56">
        {/* Top bar */}
        <header className="sticky top-0 z-40 bg-card/95 backdrop-blur-sm border-b border-border h-14 flex items-center justify-end px-6 gap-2">
          <LanguageToggle />
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
