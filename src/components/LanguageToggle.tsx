import { useLanguage } from '@/contexts/LanguageContext';
import { Globe } from 'lucide-react';

const LanguageToggle = () => {
  const { language, toggleLanguage } = useLanguage();

  return (
    <button
      onClick={toggleLanguage}
      className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-all duration-200"
      aria-label="Toggle language"
    >
      <Globe className="w-4 h-4" />
      <span className="uppercase">{language === 'sv' ? 'EN' : 'SV'}</span>
    </button>
  );
};

export default LanguageToggle;
