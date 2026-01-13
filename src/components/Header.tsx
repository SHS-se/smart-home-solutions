import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { Menu, X } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import LanguageToggle from "./LanguageToggle";
import { Button } from "./ui/button";

const ShsLogo = () => (
  <svg width="48" height="46" viewBox="0 0 111 105" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect width="111" height="105" rx="25" fill="#2D5F8D"/>
    <path d="M28.1827 65.7281C26.3153 65.7281 24.6693 65.427 23.2448 64.8248C21.8322 64.2101 20.707 63.3381 19.869 62.209C19.043 61.0798 18.5762 59.7437 18.4684 58.2006L18.4505 57.9371H21.6826L21.7185 58.2006C21.8502 59.1039 22.2033 59.888 22.7779 60.5529C23.3525 61.2053 24.1127 61.7134 25.0583 62.0773C26.016 62.4285 27.1173 62.6042 28.3623 62.6042C29.6072 62.6042 30.6846 62.4223 31.5944 62.0584C32.5042 61.6821 33.2045 61.1489 33.6953 60.4588C34.198 59.7688 34.4494 58.9596 34.4494 58.0312V58.0124C34.4494 56.8205 34.0544 55.867 33.2643 55.1519C32.4742 54.4368 31.1874 53.8722 29.4037 53.4582L26.5308 52.7995C24.0049 52.2099 22.1315 51.3065 20.9105 50.0896C19.7014 48.8601 19.0969 47.2542 19.0969 45.2719V45.2531C19.1089 43.7602 19.5039 42.4491 20.282 41.32C21.0601 40.1783 22.1315 39.2875 23.4962 38.6477C24.8728 37.9953 26.447 37.6691 28.2186 37.6691C29.9065 37.6691 31.4148 37.989 32.7436 38.6289C34.0723 39.2562 35.1317 40.1344 35.9218 41.2635C36.7239 42.3926 37.1728 43.6974 37.2685 45.1778L37.2865 45.4601H34.0544L34.0185 45.1967C33.8868 44.2683 33.5636 43.4779 33.0488 42.8255C32.5341 42.1731 31.8577 41.6713 31.0198 41.32C30.1938 40.9687 29.2302 40.793 28.1288 40.793C26.9797 40.793 25.9741 40.975 25.1122 41.3388C24.2503 41.7026 23.58 42.2107 23.1011 42.8631C22.6343 43.5155 22.4008 44.2808 22.4008 45.159V45.1778C22.4008 46.2819 22.8019 47.1915 23.6039 47.9066C24.4059 48.6217 25.6509 49.1737 27.3388 49.5627L30.2118 50.2213C31.9834 50.6228 33.4199 51.156 34.5212 51.8209C35.6345 52.4859 36.4485 53.3139 36.9633 54.305C37.49 55.2836 37.7533 56.4629 37.7533 57.843V57.8618C37.7533 59.4677 37.3643 60.8603 36.5862 62.0396C35.8201 63.2189 34.7188 64.1285 33.2823 64.7684C31.8577 65.4082 30.1579 65.7281 28.1827 65.7281Z" fill="white"/>
    <path d="M45.2195 65.2765V38.1207H48.4516V49.8638H62.6729V38.1207H65.905V65.2765H62.6729V52.9124H48.4516V65.2765H45.2195Z" fill="white"/>
    <path d="M83.0854 65.7281C81.218 65.7281 79.572 65.427 78.1475 64.8248C76.7349 64.2101 75.6097 63.3381 74.7717 62.209C73.9458 61.0798 73.4789 59.7437 73.3712 58.2006L73.3532 57.9371H76.5853L76.6212 58.2006C76.7529 59.1039 77.106 59.888 77.6806 60.5529C78.2552 61.2053 79.0154 61.7134 79.9611 62.0773C80.9187 62.4285 82.02 62.6042 83.265 62.6042C84.51 62.6042 85.5873 62.4223 86.4971 62.0584C87.4069 61.6821 88.1072 61.1489 88.598 60.4588C89.1007 59.7688 89.3521 58.9596 89.3521 58.0312V58.0124C89.3521 56.8205 88.9571 55.867 88.167 55.1519C87.377 54.4368 86.0901 53.8722 84.3065 53.4582L81.4335 52.7995C78.9076 52.2099 77.0342 51.3065 75.8132 50.0896C74.6042 48.8601 73.9996 47.2542 73.9996 45.2719V45.2531C74.0116 43.7602 74.4066 42.4491 75.1847 41.32C75.9628 40.1783 77.0342 39.2875 78.3989 38.6477C79.7755 37.9953 81.3497 37.6691 83.1214 37.6691C84.8092 37.6691 86.3175 37.989 87.6463 38.6289C88.9751 39.2562 90.0345 40.1344 90.8245 41.2635C91.6266 42.3926 92.0755 43.6974 92.1712 45.1778L92.1892 45.4601H88.9571L88.9212 45.1967C88.7895 44.2683 88.4663 43.4779 87.9516 42.8255C87.4368 42.1731 86.7605 41.6713 85.9225 41.32C85.0965 40.9687 84.1329 40.793 83.0316 40.793C81.8824 40.793 80.8768 40.975 80.0149 41.3388C79.153 41.7026 78.4827 42.2107 78.0038 42.8631C77.537 43.5155 77.3036 44.2808 77.3036 45.159V45.1778C77.3036 46.2819 77.7046 47.1915 78.5066 47.9066C79.3087 48.6217 80.5536 49.1737 82.2415 49.5627L85.1145 50.2213C86.8862 50.6228 88.3226 51.156 89.424 51.8209C90.5372 52.4859 91.3512 53.3139 91.866 54.305C92.3927 55.2836 92.6561 56.4629 92.6561 57.843V57.8618C92.6561 59.4677 92.267 60.8603 91.4889 62.0396C90.7228 63.2189 89.6215 64.1285 88.185 64.7684C86.7605 65.4082 85.0606 65.7281 83.0854 65.7281Z" fill="white"/>
    <path d="M60.6891 8L8 38.332V45.8773C8 54.1913 10.0882 62.5836 15.7837 68.3709C25.1819 77.9205 38.1194 85.3236 49.9118 88.1886V99C72.5104 91.0196 81.9269 84.0932 93.6231 70.296C99.8763 62.9196 103 53.2293 103 43.362V38.332L60.6891 19.4209V8Z" stroke="white" strokeWidth="3"/>
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
