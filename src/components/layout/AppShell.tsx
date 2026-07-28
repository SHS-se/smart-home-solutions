import React, { useEffect, useState } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard,
  BarChart3,
  Home,
  Zap,
  FileCheck,
  Receipt,
  MessageSquare,
  CircleUser,
  Building2,
  Users,
  FileText,
  Package,
  Box,
  Cpu,
  Calendar,
  BookOpen,
  ShoppingCart,
  Truck,
  TrendingUp,
  Wallet,
  CreditCard,
  ShieldCheck,
  Settings,
  Landmark,
  ClipboardList,
  Database,
  UserCog,
  ChevronDown,
  Eye,
  X,
  type LucideIcon,
} from 'lucide-react';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from '@/components/ui/sidebar';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Separator } from '@/components/ui/separator';
import { Button } from '@/components/ui/button';
import ShsLogo from '@/components/ShsLogo';
import LanguageToggle from '@/components/LanguageToggle';
import UserMenu from '@/components/UserMenu';
import CustomerSwitcher from '@/components/layout/CustomerSwitcher';
import StaffWeatherSyncAlert from '@/components/layout/StaffWeatherSyncAlert';
import { useAuth } from '@/contexts/AuthContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { isTestEnvironment } from '@/lib/environment';
import {
  findActiveNavMatch,
  getCustomerNavGroups,
  getCustomerViewBasePath,
  getNavGroupsForRole,
  isNavItemActive,
  type AppNavGroup,
  type AppNavItem,
  type NavIcon,
} from '@/lib/navigation';

const navIcons: Record<NavIcon, LucideIcon> = {
  overview: LayoutDashboard,
  'home-profile': Home,
  'energy-history': BarChart3,
  energy: Zap,
  offers: FileCheck,
  billing: Receipt,
  tickets: MessageSquare,
  account: CircleUser,
  customers: Building2,
  contacts: Users,
  quotes: FileCheck,
  invoices: Receipt,
  boms: FileText,
  skus: Package,
  templates: Box,
  devices: Cpu,
  'acc-overview': LayoutDashboard,
  'acc-periods': Calendar,
  'acc-journal': BookOpen,
  'acc-purchases': ShoppingCart,
  'acc-suppliers': Truck,
  'acc-sales': TrendingUp,
  'acc-receivables': Wallet,
  'acc-payments': CreditCard,
  'acc-vat': Receipt,
  'acc-integrity': ShieldCheck,
  margins: Settings,
  business: Landmark,
  questionnaire: ClipboardList,
  erd: Database,
  staff: UserCog,
};

export interface CustomerViewInfo {
  customerId: string;
  customerName: string | null;
  loading: boolean;
}

interface AppShellProps {
  /** Set when staff is viewing one specific customer's portal. */
  customerView?: CustomerViewInfo;
  children?: React.ReactNode;
}

const NavMenuLink: React.FC<{ item: AppNavItem }> = ({ item }) => {
  const { language } = useLanguage();
  const location = useLocation();
  const { isMobile, setOpenMobile } = useSidebar();
  const Icon = navIcons[item.icon];
  const active = isNavItemActive(item, location.pathname);

  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={active}>
        <Link to={item.path} onClick={() => isMobile && setOpenMobile(false)}>
          <Icon />
          <span>{language === 'sv' ? item.labelSv : item.labelEn}</span>
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
};

const NavGroup: React.FC<{ group: AppNavGroup }> = ({ group }) => {
  const { t, language } = useLanguage();
  const { isAdmin } = useAuth();
  const location = useLocation();
  const items = group.items.filter((item) => !item.adminOnly || isAdmin);
  const groupHasActive = items.some((item) => isNavItemActive(item, location.pathname));
  const [open, setOpen] = useState(groupHasActive);

  useEffect(() => {
    if (groupHasActive) setOpen(true);
  }, [groupHasActive]);

  if (items.length === 0) return null;

  const label = group.labelSv !== null ? (language === 'sv' ? group.labelSv : group.labelEn) : null;

  if (group.collapsible) {
    return (
      <Collapsible open={open} onOpenChange={setOpen}>
        <SidebarGroup>
          <SidebarGroupLabel asChild>
            <CollapsibleTrigger className="w-full">
              {label}
              <ChevronDown
                className={`ml-auto h-4 w-4 transition-transform ${open ? '' : '-rotate-90'}`}
              />
            </CollapsibleTrigger>
          </SidebarGroupLabel>
          <CollapsibleContent>
            <SidebarGroupContent>
              <SidebarMenu>
                {items.map((item) => (
                  <NavMenuLink key={item.path} item={item} />
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </CollapsibleContent>
        </SidebarGroup>
      </Collapsible>
    );
  }

  return (
    <SidebarGroup>
      {label && <SidebarGroupLabel>{label}</SidebarGroupLabel>}
      <SidebarGroupContent>
        <SidebarMenu>
          {items.map((item) => (
            <NavMenuLink key={item.path} item={item} />
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
};

/** Persistent banner shown on every staff customer-view page. */
const CustomerViewBanner: React.FC<{ customerView: CustomerViewInfo }> = ({ customerView }) => {
  const { t } = useLanguage();
  const navigate = useNavigate();
  const displayName = customerView.loading
    ? t('Laddar…', 'Loading…')
    : customerView.customerName || t('Namnlös kund', 'Unnamed customer');

  return (
    <div className="sticky top-14 z-30 border-b border-primary/20 bg-primary/10 backdrop-blur-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2 md:px-6">
        <div className="flex min-w-0 items-center gap-2 text-sm">
          <Eye className="h-4 w-4 shrink-0 text-primary" />
          <span className="font-medium text-primary">{t('Kundvy', 'Customer view')}:</span>
          <span className="truncate font-medium">{displayName}</span>
          <span className="hidden text-muted-foreground sm:inline">
            — {t('du ser kundens portal som personal', "you are viewing this customer's portal as staff")}
          </span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <CustomerSwitcher currentCustomerId={customerView.customerId} />
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-muted-foreground hover:text-foreground"
            onClick={() => navigate('/portal/customers')}
          >
            <X className="mr-1 h-4 w-4" />
            {t('Avsluta kundvy', 'Exit customer view')}
          </Button>
        </div>
      </div>
    </div>
  );
};

const AppShell: React.FC<AppShellProps> = ({ customerView, children }) => {
  const { isStaff } = useAuth();
  const { t, language } = useLanguage();
  const location = useLocation();

  const inCustomerView = !!customerView;
  const navGroups = inCustomerView
    ? getCustomerNavGroups(getCustomerViewBasePath(customerView.customerId))
    : getNavGroupsForRole(isStaff ? 'staff' : 'customer');

  const areaLabel = inCustomerView
    ? t('Kundvy', 'Customer view')
    : isStaff
      ? t('Personal', 'Staff')
      : t('Kundportal', 'Customer portal');

  const activeMatch = findActiveNavMatch(navGroups, location.pathname);
  const activeLabel = activeMatch
    ? language === 'sv'
      ? activeMatch.item.labelSv
      : activeMatch.item.labelEn
    : null;

  const customerViewName = customerView?.customerName || (customerView?.loading ? '…' : null);

  return (
    <SidebarProvider>
      <Sidebar>
        <SidebarHeader>
          <Link to="/portal" className="flex items-center gap-2.5 px-2 py-1.5">
            <ShsLogo size={36} />
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold leading-tight text-sidebar-foreground">
                Smart Home Solutions
              </div>
              <div className="truncate text-xs leading-tight text-muted-foreground">{areaLabel}</div>
            </div>
          </Link>
        </SidebarHeader>
        <SidebarContent>
          {inCustomerView && (
            <SidebarGroup>
              <div className="mx-2 rounded-md border border-primary/20 bg-primary/10 px-3 py-2">
                <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-primary">
                  <Eye className="h-3.5 w-3.5" />
                  {t('Kundvy', 'Customer view')}
                </div>
                <div className="mt-0.5 truncate text-sm font-medium text-sidebar-foreground">
                  {customerViewName || t('Namnlös kund', 'Unnamed customer')}
                </div>
              </div>
            </SidebarGroup>
          )}
          {navGroups.map((group) => (
            <NavGroup key={group.id} group={group} />
          ))}
        </SidebarContent>
        {inCustomerView && (
          <SidebarFooter>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton asChild>
                  <Link to="/portal/customers">
                    <X />
                    <span>{t('Avsluta kundvy', 'Exit customer view')}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarFooter>
        )}
      </Sidebar>

      <SidebarInset>
        {isTestEnvironment() && (
          <div className="bg-amber-500 py-1 text-center text-sm font-medium text-black">
            ⚠️ {t('TESTMILJÖ - All data är endast för testning', 'TEST ENVIRONMENT - All data is for testing only')}
          </div>
        )}

        <header className="sticky top-0 z-40 flex h-14 items-center gap-2 border-b border-border bg-background/95 px-4 backdrop-blur-sm md:px-6">
          <SidebarTrigger />
          <Separator orientation="vertical" className="h-5" />
          <nav className="flex min-w-0 items-center gap-1.5 text-sm" aria-label="Breadcrumb">
            {inCustomerView ? (
              <>
                <Link
                  to="/portal/customers"
                  className="text-muted-foreground transition-colors hover:text-foreground"
                >
                  {t('Kunder', 'Customers')}
                </Link>
                <span className="text-muted-foreground">/</span>
                <span className="truncate font-medium">
                  {customerViewName || t('Kund', 'Customer')}
                </span>
                {activeLabel && (
                  <>
                    <span className="text-muted-foreground">/</span>
                    <span className="truncate text-muted-foreground">{activeLabel}</span>
                  </>
                )}
              </>
            ) : (
              <>
                <span className="font-medium">{areaLabel}</span>
                {activeLabel && (
                  <>
                    <span className="text-muted-foreground">/</span>
                    <span className="truncate text-muted-foreground">{activeLabel}</span>
                  </>
                )}
              </>
            )}
          </nav>
          <div className="ml-auto flex items-center gap-1.5">
            <LanguageToggle />
            <UserMenu />
          </div>
        </header>

        {inCustomerView && <CustomerViewBanner customerView={customerView} />}
        {isStaff && <StaffWeatherSyncAlert />}

        <main className="flex-1">
          <div className="container mx-auto px-4 py-8">{children ?? <Outlet />}</div>
        </main>

        <footer className="border-t border-border py-4">
          <p className="text-center text-xs text-muted-foreground">
            © {new Date().getFullYear()} Smart Home Solutions. {t('Täby, Sverige.', 'Täby, Sweden.')}
          </p>
        </footer>
      </SidebarInset>
    </SidebarProvider>
  );
};

export default AppShell;
