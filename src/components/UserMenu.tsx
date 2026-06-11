import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ChevronDown, CircleUser, Globe, LayoutDashboard, Loader2, LogOut } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useLanguage } from '@/contexts/LanguageContext';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

interface UserMenuProps {
  size?: 'sm' | 'default';
}

/**
 * Account-level actions only (identity, account page, site/portal switch,
 * logout). App navigation lives in the AppShell sidebar — not here.
 */
const UserMenu = ({ size = 'default' }: UserMenuProps) => {
  const { user, isStaff, customerData, signOut, loading } = useAuth();
  const { t } = useLanguage();
  const navigate = useNavigate();
  const location = useLocation();

  const handleSignOut = async () => {
    await signOut();
    navigate('/');
  };

  const displayName = isStaff
    ? user?.email?.split('@')[0] || t('Personal', 'Staff')
    : customerData?.name || user?.email?.split('@')[0] || t('Kund', 'Customer');
  const displayEmail = user?.email || '';

  const getInitials = (name: string) => {
    const parts = name.split(' ');
    if (parts.length >= 2) {
      return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
    }
    return name.slice(0, 2).toUpperCase();
  };

  const inApp = location.pathname.startsWith('/portal') || location.pathname.startsWith('/accounting');

  if (user && loading) {
    return (
      <Button variant="ghost" size={size} className="flex items-center gap-2 px-2" disabled>
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
        </div>
        <div className="hidden flex-col items-start sm:flex">
          <span className="text-sm font-medium">{t('Laddar...', 'Loading...')}</span>
        </div>
      </Button>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size={size} className="flex items-center gap-2 px-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-sm font-medium text-primary-foreground">
            {getInitials(displayName)}
          </div>
          <div className="hidden flex-col items-start sm:flex">
            <span className="text-sm font-medium">{displayName}</span>
          </div>
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60 border border-border bg-card shadow-lg z-50">
        <DropdownMenuLabel className="font-normal">
          <div className="flex flex-col space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <p className="truncate text-sm font-medium leading-none">{displayName}</p>
              <Badge variant={isStaff ? 'default' : 'secondary'} className="shrink-0 text-[10px]">
                {isStaff ? t('Personal', 'Staff') : t('Kund', 'Customer')}
              </Badge>
            </div>
            <p className="truncate text-xs leading-none text-muted-foreground">{displayEmail}</p>
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {!inApp && (
          <DropdownMenuItem asChild>
            <Link to="/portal" className="cursor-pointer">
              <LayoutDashboard className="mr-2 h-4 w-4" />
              {t('Till portalen', 'Go to portal')}
            </Link>
          </DropdownMenuItem>
        )}
        {!isStaff && (
          <DropdownMenuItem asChild>
            <Link to="/portal/account" className="cursor-pointer">
              <CircleUser className="mr-2 h-4 w-4" />
              {t('Konto', 'Account')}
            </Link>
          </DropdownMenuItem>
        )}
        {inApp && (
          <DropdownMenuItem asChild>
            <Link to="/" className="cursor-pointer">
              <Globe className="mr-2 h-4 w-4" />
              {t('Till webbplatsen', 'Go to website')}
            </Link>
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={handleSignOut}
          className="cursor-pointer text-destructive focus:text-destructive"
        >
          <LogOut className="mr-2 h-4 w-4" />
          {t('Logga ut', 'Logout')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export default UserMenu;
