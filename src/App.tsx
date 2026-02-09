import { useEffect } from "react";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, useNavigate, useLocation } from "react-router-dom";
import { LanguageProvider } from "@/contexts/LanguageContext";
import { AuthProvider } from "@/contexts/AuthContext";
import { ViewedCustomerProvider } from "@/contexts/ViewedCustomerContext";
import { supabase } from "@/integrations/supabase/client";
import Index from "./pages/Index";
import Services from "./pages/Services";
import Knowledge from "./pages/Knowledge";
import ArticleRouter from "./pages/knowledge/ArticleRouter";
import About from "./pages/About";
import Contact from "./pages/Contact";
import NotFound from "./pages/NotFound";
import ScrollManager from "./components/ScrollManager";

// Portal pages
import Login from "./pages/portal/Login";
import ResetPassword from "./pages/portal/ResetPassword";
import Dashboard from "./pages/portal/Dashboard";
import Account from "./pages/portal/Account";
import Offers from "./pages/portal/Offers";
import OfferDetail from "./pages/portal/OfferDetail";
import Billing from "./pages/portal/Billing";
import TicketsList from "./pages/portal/TicketsList";
import NewTicket from "./pages/portal/NewTicket";
import TicketDetail from "./pages/portal/TicketDetail";
import Customers from "./pages/portal/Customers";
import Contacts from "./pages/portal/Contacts";
import ContactDetail from "./pages/portal/ContactDetail";

// Staff Offerter & Material pages
import SKUCatalog from "./pages/portal/skus/SKUCatalog";
import SKUImport from "./pages/portal/skus/SKUImport";
import CategoryManager from "./pages/portal/skus/CategoryManager";
import TemplatesList from "./pages/portal/templates/TemplatesList";
import TemplateDetail from "./pages/portal/templates/TemplateDetail";
import BOMsList from "./pages/portal/boms/BOMsList";
import BOMBuilder from "./pages/portal/boms/BOMBuilder";
import QuotesList from "./pages/portal/quotes/QuotesList";
import QuotePreparation from "./pages/portal/quotes/QuotePreparation";
import MarginSettings from "./pages/portal/settings/MarginSettings";
import QuestionnaireManager from "./pages/portal/settings/QuestionnaireManager";
import ERDiagram from "./pages/portal/ERDiagram";
import InvoicesList from "./pages/portal/invoices/InvoicesList";
import InvoiceDraftEditor from "./pages/portal/invoices/InvoiceDraftEditor";
import InvoiceDetail from "./pages/portal/invoices/InvoiceDetail";
import PublicQuotePage from "./pages/portal/PublicQuotePage";
import HomeProfile from "./pages/portal/HomeProfile";

// Staff customer view pages
import CustomerViewDashboard from "./pages/portal/customer-view/CustomerViewDashboard";
import CustomerViewAccount from "./pages/portal/customer-view/CustomerViewAccount";
import CustomerViewBilling from "./pages/portal/customer-view/CustomerViewBilling";
import CustomerViewTickets from "./pages/portal/customer-view/CustomerViewTickets";
import CustomerViewTicketDetail from "./pages/portal/customer-view/CustomerViewTicketDetail";
import CustomerViewOffers from "./pages/portal/customer-view/CustomerViewOffers";
import CustomerViewOfferDetail from "./pages/portal/customer-view/CustomerViewOfferDetail";
import CustomerViewHomeProfile from "./pages/portal/customer-view/CustomerViewHomeProfile";

const queryClient = new QueryClient();

// Wrapper component to provide ViewedCustomerProvider with route params
const CustomerViewWrapper = ({ children }: { children: React.ReactNode }) => (
  <ViewedCustomerProvider>{children}</ViewedCustomerProvider>
);

// Component that handles auth callbacks (password recovery links, etc.)
const AuthCallbackHandler = () => {
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    // Check URL hash for auth tokens (Supabase puts tokens in hash fragments)
    const hashParams = new URLSearchParams(window.location.hash.substring(1));
    const type = hashParams.get('type');
    const accessToken = hashParams.get('access_token');

    // If this is a recovery link, redirect to reset-password page
    if (type === 'recovery' && accessToken) {
      navigate('/reset-password' + window.location.hash, { replace: true });
      return;
    }

    // Listen for auth state changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY') {
        navigate('/reset-password', { replace: true });
      }
    });

    return () => subscription.unsubscribe();
  }, [navigate, location]);

  return null;
};

const App = () => (
  <QueryClientProvider client={queryClient}>
    <AuthProvider>
      <LanguageProvider>
        <TooltipProvider>
          <Toaster />
          <Sonner />
          <BrowserRouter>
            <ScrollManager>
              <AuthCallbackHandler />
              <Routes>
                {/* Public website */}
                <Route path="/" element={<Index />} />
                <Route path="/services" element={<Services />} />
                <Route path="/knowledge" element={<Knowledge />} />
                <Route path="/knowledge/:slug" element={<ArticleRouter />} />
                <Route path="/about" element={<About />} />
                <Route path="/contact" element={<Contact />} />
                
                {/* Customer Portal */}
                <Route path="/login" element={<Login />} />
                <Route path="/reset-password" element={<ResetPassword />} />
                <Route path="/portal" element={<Dashboard />} />
                <Route path="/portal/account" element={<Account />} />
                <Route path="/portal/offers" element={<Offers />} />
                <Route path="/portal/offers/:quoteId" element={<OfferDetail />} />
                <Route path="/portal/billing" element={<Billing />} />
                <Route path="/portal/tickets" element={<TicketsList />} />
                <Route path="/portal/home-profile" element={<HomeProfile />} />
                <Route path="/portal/tickets/new" element={<NewTicket />} />
                <Route path="/portal/tickets/:ticketNumber" element={<TicketDetail />} />
                <Route path="/portal/customers" element={<Customers />} />
                <Route path="/portal/contacts" element={<Contacts />} />
                <Route path="/portal/contacts/:id" element={<ContactDetail />} />
                
                {/* Staff Offerter & Material */}
                <Route path="/portal/skus" element={<SKUCatalog />} />
                <Route path="/portal/skus/import" element={<SKUImport />} />
                <Route path="/portal/skus/categories" element={<CategoryManager />} />
                <Route path="/portal/customers/questionnaire" element={<QuestionnaireManager />} />
                <Route path="/portal/templates" element={<TemplatesList />} />
                <Route path="/portal/templates/:id" element={<TemplateDetail />} />
                <Route path="/portal/boms" element={<BOMsList />} />
                <Route path="/portal/boms/:id" element={<BOMBuilder />} />
                <Route path="/portal/quotes" element={<QuotesList />} />
                <Route path="/portal/quotes/:id" element={<QuotePreparation />} />
                <Route path="/portal/quote/:id" element={<PublicQuotePage />} />
                <Route path="/portal/invoices" element={<InvoicesList />} />
                <Route path="/portal/invoices/new" element={<InvoiceDraftEditor />} />
                <Route path="/portal/invoices/:id" element={<InvoiceDetail />} />
                <Route path="/portal/settings/margins" element={<MarginSettings />} />
                <Route path="/portal/erd" element={<ERDiagram />} />
                
                {/* Staff viewing customer portal */}
                <Route path="/portal/customers/:customerId/overview" element={<CustomerViewWrapper><CustomerViewDashboard /></CustomerViewWrapper>} />
                <Route path="/portal/customers/:customerId/account" element={<CustomerViewWrapper><CustomerViewAccount /></CustomerViewWrapper>} />
                <Route path="/portal/customers/:customerId/billing" element={<CustomerViewWrapper><CustomerViewBilling /></CustomerViewWrapper>} />
                <Route path="/portal/customers/:customerId/tickets" element={<CustomerViewWrapper><CustomerViewTickets /></CustomerViewWrapper>} />
                <Route path="/portal/customers/:customerId/tickets/:ticketNumber" element={<CustomerViewWrapper><CustomerViewTicketDetail /></CustomerViewWrapper>} />
                <Route path="/portal/customers/:customerId/offers" element={<CustomerViewWrapper><CustomerViewOffers /></CustomerViewWrapper>} />
                <Route path="/portal/customers/:customerId/offers/:quoteId" element={<CustomerViewWrapper><CustomerViewOfferDetail /></CustomerViewWrapper>} />
                <Route path="/portal/customers/:customerId/home-profile" element={<CustomerViewWrapper><CustomerViewHomeProfile /></CustomerViewWrapper>} />
                
                {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
                <Route path="*" element={<NotFound />} />
              </Routes>
            </ScrollManager>
          </BrowserRouter>
        </TooltipProvider>
      </LanguageProvider>
    </AuthProvider>
  </QueryClientProvider>
);

export default App;
