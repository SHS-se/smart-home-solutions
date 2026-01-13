import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { Menu, X } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import LanguageToggle from "./LanguageToggle";
import { Button } from "./ui/button";

const ShieldLogo = ({ className }: { className?: string }) => (
  <svg width="40" height="38" viewBox="0 0 96 90" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <path d="M53.0798 2.53531L1.5 30.8674V37.9152C1.5 45.6811 3.54428 53.52 9.11986 58.9257C18.3202 67.8457 30.9853 74.7606 42.5294 77.4368V87.5353C64.6523 80.0811 73.8706 73.6114 85.3205 60.7239C91.442 53.8338 94.5 44.7824 94.5 35.5658V30.8674L53.0798 13.2032V2.53531Z" stroke="#2D5F8D" strokeWidth="3"/>
  </svg>
);

const SHSText = ({ className }: { className?: string }) => (
  <svg width="73" height="27" viewBox="0 0 73 27" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <path d="M10.0469 26.3125C7.78125 26.3125 5.79688 25.9531 4.09375 25.2344C2.40625 24.5 1.09375 23.4844 0.15625 22.1875L3.40625 18.6875C4.15625 19.6562 5.07812 20.4062 6.17188 20.9375C7.26562 21.4688 8.5 21.7344 9.875 21.7344C11.0938 21.7344 12.0312 21.5 12.6875 21.0312C13.3438 20.5625 13.6719 19.9375 13.6719 19.1562C13.6719 18.4375 13.3906 17.8594 12.8281 17.4219C12.2656 16.9844 11.5469 16.6094 10.6719 16.2969C9.8125 15.9844 8.875 15.6562 7.85938 15.3125C6.85938 14.9531 5.92188 14.5156 5.04688 14C4.1875 13.4688 3.47656 12.7969 2.91406 11.9844C2.35156 11.1562 2.07031 10.1094 2.07031 8.84375C2.07031 7.65625 2.35938 6.57812 2.9375 5.60938C3.53125 4.64062 4.40625 3.86719 5.5625 3.28906C6.71875 2.71094 8.15625 2.42188 9.875 2.42188C11.8438 2.42188 13.5469 2.78906 14.9844 3.52344C16.4219 4.24219 17.5312 5.17188 18.3125 6.3125L15.0625 9.8125C14.4531 9.01562 13.6875 8.40625 12.7656 7.98438C11.8594 7.5625 10.9062 7.35156 9.90625 7.35156C8.8125 7.35156 7.95312 7.57031 7.32812 8.00781C6.70312 8.44531 6.39062 9.03125 6.39062 9.76562C6.39062 10.4219 6.66406 10.9688 7.21094 11.4062C7.77344 11.8281 8.48438 12.1953 9.34375 12.5078C10.2188 12.8203 11.1562 13.1484 12.1562 13.4922C13.1719 13.8203 14.1094 14.2344 14.9688 14.7344C15.8438 15.2344 16.5547 15.8828 17.1016 16.6797C17.6641 17.4766 17.9453 18.4844 17.9453 19.7031C17.9453 21.5781 17.2266 23.1172 15.7891 24.3203C14.3672 25.5078 12.4531 26.3125 10.0469 26.3125ZM35.6562 26V15.9688H25.7656V26H21.3125V2.6875H25.7656V11.4375H35.6562V2.6875H40.1094V26H35.6562ZM53.3281 26.3125C51.0625 26.3125 49.0781 25.9531 47.375 25.2344C45.6875 24.5 44.375 23.4844 43.4375 22.1875L46.6875 18.6875C47.4375 19.6562 48.3594 20.4062 49.4531 20.9375C50.5469 21.4688 51.7812 21.7344 53.1562 21.7344C54.375 21.7344 55.3125 21.5 55.9688 21.0312C56.625 20.5625 56.9531 19.9375 56.9531 19.1562C56.9531 18.4375 56.6719 17.8594 56.1094 17.4219C55.5469 16.9844 54.8281 16.6094 53.9531 16.2969C53.0938 15.9844 52.1562 15.6562 51.1406 15.3125C50.1406 14.9531 49.2031 14.5156 48.3281 14C47.4688 13.4688 46.7578 12.7969 46.1953 11.9844C45.6328 11.1562 45.3516 10.1094 45.3516 8.84375C45.3516 7.65625 45.6406 6.57812 46.2188 5.60938C46.8125 4.64062 47.6875 3.86719 48.8438 3.28906C50 2.71094 51.4375 2.42188 53.1562 2.42188C55.125 2.42188 56.8281 2.78906 58.2656 3.52344C59.7031 4.24219 60.8125 5.17188 61.5938 6.3125L58.3438 9.8125C57.7344 9.01562 56.9688 8.40625 56.0469 7.98438C55.1406 7.5625 54.1875 7.35156 53.1875 7.35156C52.0938 7.35156 51.2344 7.57031 50.6094 8.00781C49.9844 8.44531 49.6719 9.03125 49.6719 9.76562C49.6719 10.4219 49.9453 10.9688 50.4922 11.4062C51.0547 11.8281 51.7656 12.1953 52.625 12.5078C53.5 12.8203 54.4375 13.1484 55.4375 13.4922C56.4531 13.8203 57.3906 14.2344 58.25 14.7344C59.125 15.2344 59.8359 15.8828 60.3828 16.6797C60.9453 17.4766 61.2266 18.4844 61.2266 19.7031C61.2266 21.5781 60.5078 23.1172 59.0703 24.3203C57.6484 25.5078 55.7344 26.3125 53.3281 26.3125Z" fill="#2D5F8D"/>
  </svg>
);

const Header = () => {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const { t } = useLanguage();
  const location = useLocation();
  const navLinks = [
    {
      href: "/services",
      label: t("Tjänster", "Services"),
    },
    {
      href: "/knowledge",
      label: t("Kunskapscenter", "Knowledge"),
    },
    {
      href: "/about",
      label: t("Om oss", "About"),
    },
  ];
  const isActive = (path: string) => location.pathname === path;
  return (
    <header className="fixed top-0 left-0 right-0 z-50 bg-card/95 backdrop-blur-md border-b border-border">
      <div className="container mx-auto">
        <div className="flex items-center justify-between h-16 md:h-20">
          {/* Logo */}
          <Link to="/" className="flex items-center gap-2 group">
            <div className="flex items-center gap-1 transition-transform duration-200 group-hover:scale-105">
              <ShieldLogo />
              <SHSText />
            </div>
            <span className="text-sm font-medium text-muted-foreground">Smart Home Solutions</span>
          </Link>

          {/* Desktop Navigation */}
          <nav className="hidden md:flex items-center gap-8">
            {navLinks.map((link) => (
              <Link
                key={link.href}
                to={link.href}
                className={`nav-link text-sm font-medium py-2 ${isActive(link.href) ? "text-primary" : ""}`}
              >
                {link.label}
              </Link>
            ))}
          </nav>

          {/* Desktop Actions */}
          <div className="hidden md:flex items-center gap-4">
            <LanguageToggle />
            <Button asChild>
              <Link to="/contact">{t("Kontakt", "Contact")}</Link>
            </Button>
          </div>

          {/* Mobile Menu Button */}
          <button
            onClick={() => setIsMenuOpen(!isMenuOpen)}
            className="md:hidden p-2 text-foreground"
            aria-label="Toggle menu"
          >
            {isMenuOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
          </button>
        </div>

        {/* Mobile Menu */}
        {isMenuOpen && (
          <div className="md:hidden py-4 border-t border-border animate-fade-in">
            <nav className="flex flex-col gap-2">
              {navLinks.map((link) => (
                <Link
                  key={link.href}
                  to={link.href}
                  onClick={() => setIsMenuOpen(false)}
                  className={`px-4 py-3 rounded-lg text-sm font-medium transition-colors ${isActive(link.href) ? "bg-primary/10 text-primary" : "text-foreground hover:bg-muted"}`}
                >
                  {link.label}
                </Link>
              ))}
              <div className="flex items-center justify-between px-4 pt-4 border-t border-border mt-2">
                <LanguageToggle />
                <Button asChild size="sm">
                  <Link to="/contact" onClick={() => setIsMenuOpen(false)}>
                    {t("Kontakt", "Contact")}
                  </Link>
                </Button>
              </div>
            </nav>
          </div>
        )}
      </div>
    </header>
  );
};
export default Header;
