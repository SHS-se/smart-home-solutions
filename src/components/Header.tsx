import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { Menu, X } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import LanguageToggle from "./LanguageToggle";
import { Button } from "./ui/button";

const ShsLogo = () => (
  <svg width="48" height="46" viewBox="0 0 115 110" fill="none" xmlns="http://www.w3.org/2000/svg">
    <ellipse cx="57.5" cy="55" rx="57.5" ry="55" fill="#2D5F8D"/>
    <path d="M30.1827 68.7281C28.3153 68.7281 26.6693 68.427 25.2448 67.8248C23.8322 67.2101 22.707 66.3381 21.869 65.209C21.043 64.0799 20.5762 62.7437 20.4684 61.2006L20.4505 60.9371H23.6826L23.7185 61.2006C23.8502 62.1039 24.2033 62.888 24.7779 63.5529C25.3525 64.2053 26.1126 64.7134 27.0583 65.0773C28.016 65.4285 29.1173 65.6042 30.3623 65.6042C31.6072 65.6042 32.6846 65.4223 33.5944 65.0584C34.5041 64.6821 35.2044 64.1489 35.6952 63.4588C36.198 62.7688 36.4494 61.9596 36.4494 61.0312V61.0124C36.4494 59.8205 36.0544 58.867 35.2643 58.1519C34.4742 57.4368 33.1874 56.8722 31.4037 56.4582L28.5307 55.7995C26.0049 55.2099 24.1315 54.3066 22.9105 53.0896C21.7014 51.8601 21.0969 50.2542 21.0969 48.2719V48.2531C21.1089 46.7602 21.5039 45.4491 22.282 44.32C23.0601 43.1783 24.1315 42.2875 25.4961 41.6477C26.8728 40.9953 28.4469 40.6691 30.2186 40.6691C31.9065 40.6691 33.4148 40.989 34.7436 41.6289C36.0723 42.2562 37.1317 43.1344 37.9218 44.2635C38.7238 45.3927 39.1727 46.6974 39.2685 48.1779L39.2865 48.4601H36.0544L36.0185 48.1967C35.8868 47.2683 35.5636 46.4779 35.0488 45.8255C34.5341 45.1731 33.8577 44.6713 33.0198 44.32C32.1938 43.9687 31.2301 43.793 30.1288 43.793C28.9796 43.793 27.9741 43.975 27.1122 44.3388C26.2503 44.7026 25.5799 45.2107 25.1011 45.8631C24.6343 46.5155 24.4008 47.2808 24.4008 48.159V48.1779C24.4008 49.2819 24.8018 50.1915 25.6039 50.9066C26.4059 51.6217 27.6509 52.1737 29.3388 52.5627L32.2117 53.2213C33.9834 53.6228 35.4199 54.156 36.5212 54.8209C37.6345 55.4859 38.4485 56.3139 38.9633 57.305C39.49 58.2836 39.7533 59.4629 39.7533 60.843V60.8618C39.7533 62.4677 39.3643 63.8603 38.5862 65.0396C37.8201 66.2189 36.7187 67.1285 35.2822 67.7684C33.8577 68.4082 32.1579 68.7281 30.1827 68.7281Z" fill="white"/>
    <path d="M47.2195 68.2765V41.1208H50.4516V52.8638H64.6729V41.1208H67.905V68.2765H64.6729V55.9124H50.4516V68.2765H47.2195Z" fill="white"/>
    <path d="M85.0854 68.7281C83.218 68.7281 81.572 68.427 80.1475 67.8248C78.7349 67.2101 77.6097 66.3381 76.7717 65.209C75.9457 64.0799 75.4789 62.7437 75.3711 61.2006L75.3532 60.9371H78.5853L78.6212 61.2006C78.7529 62.1039 79.106 62.888 79.6806 63.5529C80.2552 64.2053 81.0154 64.7134 81.9611 65.0773C82.9187 65.4285 84.02 65.6042 85.265 65.6042C86.5099 65.6042 87.5873 65.4223 88.4971 65.0584C89.4069 64.6821 90.1072 64.1489 90.598 63.4588C91.1007 62.7688 91.3521 61.9596 91.3521 61.0312V61.0124C91.3521 59.8205 90.9571 58.867 90.167 58.1519C89.3769 57.4368 88.0901 56.8722 86.3064 56.4582L83.4335 55.7995C80.9076 55.2099 79.0342 54.3066 77.8132 53.0896C76.6041 51.8601 75.9996 50.2542 75.9996 48.2719V48.2531C76.0116 46.7602 76.4066 45.4491 77.1847 44.32C77.9628 43.1783 79.0342 42.2875 80.3989 41.6477C81.7755 40.9953 83.3497 40.6691 85.1213 40.6691C86.8092 40.6691 88.3175 40.989 89.6463 41.6289C90.975 42.2562 92.0344 43.1344 92.8245 44.2635C93.6266 45.3927 94.0755 46.6974 94.1712 48.1779L94.1892 48.4601H90.9571L90.9212 48.1967C90.7895 47.2683 90.4663 46.4779 89.9515 45.8255C89.4368 45.1731 88.7604 44.6713 87.9225 44.32C87.0965 43.9687 86.1329 43.793 85.0316 43.793C83.8824 43.793 82.8768 43.975 82.0149 44.3388C81.153 44.7026 80.4827 45.2107 80.0038 45.8631C79.537 46.5155 79.3035 47.2808 79.3035 48.159V48.1779C79.3035 49.2819 79.7046 50.1915 80.5066 50.9066C81.3086 51.6217 82.5536 52.1737 84.2415 52.5627L87.1145 53.2213C88.8861 53.6228 90.3226 54.156 91.4239 54.8209C92.5372 55.4859 93.3512 56.3139 93.866 57.305C94.3927 58.2836 94.656 59.4629 94.656 60.843V60.8618C94.656 62.4677 94.267 63.8603 93.4889 65.0396C92.7228 66.2189 91.6215 67.1285 90.185 67.7684C88.7604 68.4082 87.0606 68.7281 85.0854 68.7281Z" fill="white"/>
    <path d="M62.6891 11L10 41.332V48.8773C10 57.1913 12.0882 65.5836 17.7837 71.3709C27.1819 80.9205 40.1194 88.3236 51.9118 91.1886V102C74.5104 94.0196 83.9269 87.0932 95.6231 73.296C101.876 65.9196 105 56.2293 105 46.362V41.332L62.6891 22.4209V11Z" stroke="white" strokeWidth="3"/>
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
          <Link to="/" className="flex items-center gap-3 group">
            <div className="transition-transform duration-200 group-hover:scale-105">
              <ShsLogo />
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
