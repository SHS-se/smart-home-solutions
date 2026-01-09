import { ReactNode } from 'react';
import { useLanguage } from '@/contexts/LanguageContext';
import Header from './Header';
import Footer from './Footer';

interface LayoutProps {
  children: ReactNode;
}

const Layout = ({ children }: LayoutProps) => {
  const { language } = useLanguage();

  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main 
        key={language} 
        className="flex-1 pt-16 md:pt-20 lang-transition animate-fade-in"
      >
        {children}
      </main>
      <Footer />
    </div>
  );
};

export default Layout;
