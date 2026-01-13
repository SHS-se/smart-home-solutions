import { ReactNode } from 'react';
import { useLanguage } from '@/contexts/LanguageContext';
import { useIsPortrait } from '@/hooks/use-orientation';
import Header from './Header';
import Footer from './Footer';

interface LayoutProps {
  children: ReactNode;
}

const Layout = ({ children }: LayoutProps) => {
  const { language } = useLanguage();
  const { isMobilePortrait } = useIsPortrait();

  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main 
        key={language} 
        className={`flex-1 lang-transition animate-fade-in ${
          isMobilePortrait ? 'pt-14 pb-14' : 'pt-16 md:pt-20'
        }`}
      >
        {children}
      </main>
      <Footer />
    </div>
  );
};

export default Layout;
