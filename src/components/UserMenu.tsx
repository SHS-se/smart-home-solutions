import { Link, useNavigate } from "react-router-dom";
import { ChevronDown } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { useLanguage } from "@/contexts/LanguageContext";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";

interface UserMenuProps {
  size?: "sm" | "default";
}

const UserMenu = ({ size = "default" }: UserMenuProps) => {
  const { user, isStaff, isCustomer, customerData, signOut } = useAuth();
  const { t } = useLanguage();
  const navigate = useNavigate();

  const handleSignOut = async () => {
    await signOut();
    navigate('/');
  };

  // Get display name and email
  const displayName = isStaff 
    ? user?.email?.split('@')[0] || t("Personal", "Staff")
    : customerData?.org_name || user?.email?.split('@')[0] || t("Kund", "Customer");
  const displayEmail = user?.email || "";

  // Get initials for avatar
  const getInitials = (name: string) => {
    const parts = name.split(' ');
    if (parts.length >= 2) {
      return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
    }
    return name.slice(0, 2).toUpperCase();
  };

  // Staff CRM navigation items
  const staffCRMItems = [
    { href: "/portal", label: t("Översikt", "Overview") },
    { href: "/portal/customers", label: t("Kunder", "Customers") },
    { href: "/portal/contacts", label: t("Kontakter", "Contacts") },
    { href: "/portal/tickets", label: t("Alla ärenden", "All Tickets") },
  ];

  // Staff Operations navigation items
  const staffOperationsItems = [
    { href: "/portal/skus", label: t("SKU-katalog", "SKU Catalog") },
    { href: "/portal/templates", label: t("Mallar", "Templates") },
    { href: "/portal/boms", label: t("Materiallistor", "BOMs") },
    { href: "/portal/quotes", label: t("Offerter", "Quotes") },
    { href: "/portal/invoices", label: t("Fakturor", "Invoices") },
    { href: "/portal/settings/margins", label: t("Marginalregler", "Margin Rules") },
    { href: "/portal/erd", label: t("Databas ERD", "Database ERD") },
  ];

  const customerNavItems = [
    { href: "/portal", label: t("Översikt", "Overview") },
    { href: "/portal/account", label: t("Konto", "Account") },
    { href: "/portal/offers", label: t("Offerter", "Offers") },
    { href: "/portal/billing", label: t("Fakturor", "Billing") },
    { href: "/portal/tickets", label: t("Mina ärenden", "My Tickets") },
  ];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button 
          variant="ghost" 
          size={size}
          className="flex items-center gap-2 px-2"
        >
          <div className="flex items-center justify-center w-8 h-8 rounded-full bg-primary text-primary-foreground text-sm font-medium">
            {getInitials(displayName)}
          </div>
          <div className="hidden sm:flex flex-col items-start">
            <span className="text-sm font-medium">{displayName}</span>
            {isCustomer && customerData?.is_test && (
              <span className="text-xs font-semibold text-destructive leading-none">TEST</span>
            )}
          </div>
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56 bg-card border border-border shadow-lg z-50">
        <DropdownMenuLabel className="font-normal">
          <div className="flex flex-col space-y-1">
            <p className="text-sm font-medium leading-none">{displayName}</p>
            <p className="text-xs leading-none text-muted-foreground">{displayEmail}</p>
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {isStaff ? (
          <>
            {staffCRMItems.map((item) => (
              <DropdownMenuItem key={item.href} asChild>
                <Link to={item.href} className="cursor-pointer">
                  {item.label}
                </Link>
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs text-muted-foreground font-normal px-2 py-1">
              {t("Offerter & Material", "Quotes & Materials")}
            </DropdownMenuLabel>
            {staffOperationsItems.map((item) => (
              <DropdownMenuItem key={item.href} asChild>
                <Link to={item.href} className="cursor-pointer">
                  {item.label}
                </Link>
              </DropdownMenuItem>
            ))}
          </>
        ) : (
          customerNavItems.map((item) => (
            <DropdownMenuItem key={item.href} asChild>
              <Link to={item.href} className="cursor-pointer">
                {item.label}
              </Link>
            </DropdownMenuItem>
          ))
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={handleSignOut}
          className="text-destructive focus:text-destructive cursor-pointer"
        >
          {t("Logga ut", "Logout")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export default UserMenu;
