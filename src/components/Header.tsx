import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { Menu, X } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import LanguageToggle from "./LanguageToggle";
import { Button } from "./ui/button";

const ShsLogo = () => (
  <svg width="49" height="48" viewBox="0 0 98 96" fill="none" xmlns="http://www.w3.org/2000/svg" className="rounded-xl">
    <rect width="98" height="96" rx="12" fill="#2D5F8D"/>
    <path d="M21.6827 60.3225C19.8153 60.3225 18.1693 60.0214 16.7448 59.4191C15.3322 58.8044 14.207 57.9325 13.369 56.8033C12.543 55.6742 12.0762 54.338 11.9684 52.7949L11.9505 52.5314H15.1826L15.2185 52.7949C15.3502 53.6982 15.7033 54.4823 16.2779 55.1473C16.8525 55.7996 17.6126 56.3078 18.5583 56.6716C19.516 57.0229 20.6173 57.1985 21.8623 57.1985C23.1072 57.1985 24.1846 57.0166 25.0944 56.6528C26.0041 56.2764 26.7044 55.7432 27.1952 55.0532C27.698 54.3631 27.9494 53.5539 27.9494 52.6255V52.6067C27.9494 51.4148 27.5544 50.4613 26.7643 49.7462C25.9742 49.0311 24.6874 48.4665 22.9037 48.0525L20.0307 47.3939C17.5049 46.8042 15.6315 45.9009 14.4105 44.6839C13.2014 43.4544 12.5969 41.8485 12.5969 39.8663V39.8475C12.6089 38.3545 13.0039 37.0434 13.782 35.9143C14.5601 34.7726 15.6315 33.8819 16.9961 33.242C18.3728 32.5896 19.9469 32.2634 21.7186 32.2634C23.4065 32.2634 24.9148 32.5833 26.2436 33.2232C27.5723 33.8505 28.6317 34.7287 29.4218 35.8578C30.2238 36.987 30.6727 38.2918 30.7685 39.7722L30.7865 40.0545H27.5544L27.5185 39.791C27.3868 38.8626 27.0636 38.0722 26.5488 37.4198C26.0341 36.7674 25.3577 36.2656 24.5198 35.9143C23.6938 35.563 22.7301 35.3874 21.6288 35.3874C20.4796 35.3874 19.4741 35.5693 18.6122 35.9331C17.7503 36.297 17.0799 36.8051 16.6011 37.4575C16.1343 38.1098 15.9008 38.8751 15.9008 39.7534V39.7722C15.9008 40.8762 16.3018 41.7858 17.1039 42.5009C17.9059 43.216 19.1509 43.7681 20.8388 44.157L23.7117 44.8157C25.4834 45.2171 26.9199 45.7503 28.0212 46.4153C29.1345 47.0802 29.9485 47.9082 30.4633 48.8994C30.99 49.8779 31.2533 51.0573 31.2533 52.4373V52.4561C31.2533 54.062 30.8643 55.4546 30.0862 56.6339C29.3201 57.8133 28.2187 58.7228 26.7822 59.3627C25.3577 60.0025 23.6579 60.3225 21.6827 60.3225Z" fill="white"/>
    <path d="M38.7195 59.8708V32.7151H41.9516V44.4581H56.1729V32.7151H59.405V59.8708H56.1729V47.5068H41.9516V59.8708H38.7195Z" fill="white"/>
    <path d="M76.5854 60.3225C74.718 60.3225 73.072 60.0214 71.6475 59.4191C70.2349 58.8044 69.1097 57.9325 68.2717 56.8033C67.4457 55.6742 66.9789 54.338 66.8711 52.7949L66.8532 52.5314H70.0853L70.1212 52.7949C70.2529 53.6982 70.606 54.4823 71.1806 55.1473C71.7552 55.7996 72.5154 56.3078 73.4611 56.6716C74.4187 57.0229 75.52 57.1985 76.765 57.1985C78.0099 57.1985 79.0873 57.0166 79.9971 56.6528C80.9069 56.2764 81.6072 55.7432 82.098 55.0532C82.6007 54.3631 82.8521 53.5539 82.8521 52.6255V52.6067C82.8521 51.4148 82.4571 50.4613 81.667 49.7462C80.8769 49.0311 79.5901 48.4665 77.8064 48.0525L74.9335 47.3939C72.4076 46.8042 70.5342 45.9009 69.3132 44.6839C68.1041 43.4544 67.4996 41.8485 67.4996 39.8663V39.8475C67.5116 38.3545 67.9066 37.0434 68.6847 35.9143C69.4628 34.7726 70.5342 33.8819 71.8989 33.242C73.2755 32.5896 74.8497 32.2634 76.6213 32.2634C78.3092 32.2634 79.8175 32.5833 81.1463 33.2232C82.475 33.8505 83.5344 34.7287 84.3245 35.8578C85.1266 36.987 85.5755 38.2918 85.6712 39.7722L85.6892 40.0545H82.4571L82.4212 39.791C82.2895 38.8626 81.9663 38.0722 81.4515 37.4198C80.9368 36.7674 80.2604 36.2656 79.4225 35.9143C78.5965 35.563 77.6329 35.3874 76.5316 35.3874C75.3824 35.3874 74.3768 35.5693 73.5149 35.9331C72.653 36.297 71.9827 36.8051 71.5038 37.4575C71.037 38.1098 70.8035 38.8751 70.8035 39.7534V39.7722C70.8035 40.8762 71.2046 41.7858 72.0066 42.5009C72.8086 43.216 74.0536 43.7681 75.7415 44.157L78.6145 44.8157C80.3861 45.2171 81.8226 45.7503 82.9239 46.4153C84.0372 47.0802 84.8512 47.9082 85.366 48.8994C85.8927 49.8779 86.156 51.0573 86.156 52.4373V52.4561C86.156 54.062 85.767 55.4546 84.9889 56.6339C84.2228 57.8133 83.1215 58.7228 81.685 59.3627C80.2604 60.0025 78.5606 60.3225 76.5854 60.3225Z" fill="white"/>
    <path d="M54.1891 2.59433L1.5 32.9264V40.4716C1.5 48.7857 3.58824 57.178 9.28373 62.9652C18.6819 72.5149 31.6194 79.9179 43.4118 82.783V93.5943C66.0104 85.6139 75.4269 78.6875 87.1231 64.8904C93.3763 57.5139 96.5 47.8236 96.5 37.9564V32.9264L54.1891 14.0152V2.59433Z" stroke="white" strokeWidth="3"/>
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
