import { Suspense, lazy, useEffect } from "react";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, useNavigate, useLocation } from "react-router-dom";
import { LanguageProvider } from "@/contexts/LanguageContext";
import { AuthProvider } from "@/contexts/AuthContext";
import { ViewedCustomerProvider } from "@/contexts/ViewedCustomerContext";
import { supabase } from "@/integrations/supabase/client";
import ScrollManager from "./components/ScrollManager";

const Index = lazy(() => import("./pages/Index"));
const Services = lazy(() => import("./pages/Services"));
const Knowledge = lazy(() => import("./pages/Knowledge"));
const ArticleRouter = lazy(() => import("./pages/knowledge/ArticleRouter"));
const About = lazy(() => import("./pages/About"));
const Contact = lazy(() => import("./pages/Contact"));
const NotFound = lazy(() => import("./pages/NotFound"));
const Login = lazy(() => import("./pages/portal/Login"));
const ResetPassword = lazy(() => import("./pages/portal/ResetPassword"));
const Dashboard = lazy(() => import("./pages/portal/Dashboard"));
const Account = lazy(() => import("./pages/portal/Account"));
const Offers = lazy(() => import("./pages/portal/Offers"));
const OfferDetail = lazy(() => import("./pages/portal/OfferDetail"));
const Billing = lazy(() => import("./pages/portal/Billing"));
const TicketsList = lazy(() => import("./pages/portal/TicketsList"));
const NewTicket = lazy(() => import("./pages/portal/NewTicket"));
const TicketDetail = lazy(() => import("./pages/portal/TicketDetail"));
const Customers = lazy(() => import("./pages/portal/Customers"));
const Contacts = lazy(() => import("./pages/portal/Contacts"));
const ContactDetail = lazy(() => import("./pages/portal/ContactDetail"));
const SKUCatalog = lazy(() => import("./pages/portal/skus/SKUCatalog"));
const SKUImport = lazy(() => import("./pages/portal/skus/SKUImport"));
const CategoryManager = lazy(() => import("./pages/portal/skus/CategoryManager"));
const TemplatesList = lazy(() => import("./pages/portal/templates/TemplatesList"));
const TemplateDetail = lazy(() => import("./pages/portal/templates/TemplateDetail"));
const BOMsList = lazy(() => import("./pages/portal/boms/BOMsList"));
const BOMBuilder = lazy(() => import("./pages/portal/boms/BOMBuilder"));
const QuotesList = lazy(() => import("./pages/portal/quotes/QuotesList"));
const QuotePreparation = lazy(() => import("./pages/portal/quotes/QuotePreparation"));
const MarginSettings = lazy(() => import("./pages/portal/settings/MarginSettings"));
const QuestionnaireManager = lazy(() => import("./pages/portal/settings/QuestionnaireManager"));
const ERDiagram = lazy(() => import("./pages/portal/ERDiagram"));
const InvoicesList = lazy(() => import("./pages/portal/invoices/InvoicesList"));
const InvoiceDraftEditor = lazy(() => import("./pages/portal/invoices/InvoiceDraftEditor"));
const InvoiceDetail = lazy(() => import("./pages/portal/invoices/InvoiceDetail"));
const PublicQuotePage = lazy(() => import("./pages/portal/PublicQuotePage"));
const PublicInvoicePage = lazy(() => import("./pages/portal/PublicInvoicePage"));
const CustomerInvoicePage = lazy(() => import("./pages/portal/CustomerInvoicePage"));
const HomeProfile = lazy(() => import("./pages/portal/HomeProfile"));
const EnergyModeling = lazy(() => import("./pages/portal/EnergyModeling"));
const DeviceCatalog = lazy(() => import("./pages/portal/DeviceCatalog"));
const SetPassword = lazy(() => import("./pages/onboarding/SetPassword"));
const Verify = lazy(() => import("./pages/Verify"));
const CustomerViewDashboard = lazy(() => import("./pages/portal/customer-view/CustomerViewDashboard"));
const CustomerViewAccount = lazy(() => import("./pages/portal/customer-view/CustomerViewAccount"));
const CustomerViewBilling = lazy(() => import("./pages/portal/customer-view/CustomerViewBilling"));
const CustomerViewTickets = lazy(() => import("./pages/portal/customer-view/CustomerViewTickets"));
const CustomerViewTicketDetail = lazy(() => import("./pages/portal/customer-view/CustomerViewTicketDetail"));
const CustomerViewOffers = lazy(() => import("./pages/portal/customer-view/CustomerViewOffers"));
const CustomerViewOfferDetail = lazy(() => import("./pages/portal/customer-view/CustomerViewOfferDetail"));
const CustomerViewHomeProfile = lazy(() => import("./pages/portal/customer-view/CustomerViewHomeProfile"));
const CustomerViewEnergyModeling = lazy(() => import("./pages/portal/customer-view/CustomerViewEnergyModeling"));

// Accounting pages
const AccountingOverview = lazy(() => import("./pages/accounting/AccountingOverview"));
const AccountingPeriods = lazy(() => import("./pages/accounting/AccountingPeriods"));
const PurchasesList = lazy(() => import("./pages/accounting/PurchasesList"));
const PurchaseUpload = lazy(() => import("./pages/accounting/PurchaseUpload"));
const PurchaseDetail = lazy(() => import("./pages/accounting/PurchaseDetail"));
const AccountingJournal = lazy(() => import("./pages/accounting/AccountingJournal"));
const VatPeriodsList = lazy(() => import("./pages/accounting/VatPeriodsList"));
const VatDeclarationFlow = lazy(() => import("./pages/accounting/VatDeclarationFlow"));
const SuppliersList = lazy(() => import("./pages/accounting/SuppliersList"));

const queryClient = new QueryClient();

const RouteFallback = () => (
  <div className="min-h-screen flex items-center justify-center bg-background text-muted-foreground">
    Loading...
  </div>
);

const CustomerViewWrapper = ({ children }: { children: React.ReactNode }) => (
  <ViewedCustomerProvider>{children}</ViewedCustomerProvider>
);

const AuthCallbackHandler = () => {
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    const hashParams = new URLSearchParams(window.location.hash.substring(1));
    const type = hashParams.get('type');
    const accessToken = hashParams.get('access_token');

    if (type === 'recovery' && accessToken) {
      navigate('/reset-password' + window.location.hash, { replace: true });
      return;
    }

    if (type === 'magiclink' && accessToken) {
      navigate('/onboarding/set-password' + window.location.hash, { replace: true });
      return;
    }

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
              <Suspense fallback={<RouteFallback />}>
                <Routes>
                  <Route path="/" element={<Index />} />
                  <Route path="/services" element={<Services />} />
                  <Route path="/knowledge" element={<Knowledge />} />
                  <Route path="/knowledge/:slug" element={<ArticleRouter />} />
                  <Route path="/about" element={<About />} />
                  <Route path="/contact" element={<Contact />} />

                  <Route path="/login" element={<Login />} />
                  <Route path="/reset-password" element={<ResetPassword />} />
                  <Route path="/verify" element={<Verify />} />
                  <Route path="/onboarding/set-password" element={<SetPassword />} />
                  <Route path="/portal" element={<Dashboard />} />
                  <Route path="/portal/account" element={<Account />} />
                  <Route path="/portal/offers" element={<Offers />} />
                  <Route path="/portal/offers/:quoteId" element={<OfferDetail />} />
                  <Route path="/portal/billing" element={<Billing />} />
                  <Route path="/portal/tickets" element={<TicketsList />} />
                  <Route path="/portal/home-profile" element={<HomeProfile />} />
                  <Route path="/portal/energy-modeling" element={<EnergyModeling />} />
                  <Route path="/portal/device-catalog" element={<DeviceCatalog />} />
                  <Route path="/portal/tickets/new" element={<NewTicket />} />
                  <Route path="/portal/tickets/:ticketNumber" element={<TicketDetail />} />
                  <Route path="/portal/customers" element={<Customers />} />
                  <Route path="/portal/contacts" element={<Contacts />} />
                  <Route path="/portal/contacts/:id" element={<ContactDetail />} />

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
                  <Route path="/portal/invoice/:id" element={<PublicInvoicePage />} />
                  <Route path="/portal/invoices" element={<InvoicesList />} />
                  <Route path="/portal/billing/invoices/:id" element={<CustomerInvoicePage />} />
                  <Route path="/portal/invoices/new" element={<InvoiceDraftEditor />} />
                  <Route path="/portal/invoices/:id" element={<InvoiceDetail />} />
                  <Route path="/portal/settings/margins" element={<MarginSettings />} />
                  <Route path="/portal/erd" element={<ERDiagram />} />

                  <Route path="/portal/customers/:customerId/overview" element={<CustomerViewWrapper><CustomerViewDashboard /></CustomerViewWrapper>} />
                  <Route path="/portal/customers/:customerId/account" element={<CustomerViewWrapper><CustomerViewAccount /></CustomerViewWrapper>} />
                  <Route path="/portal/customers/:customerId/billing" element={<CustomerViewWrapper><CustomerViewBilling /></CustomerViewWrapper>} />
                  <Route path="/portal/customers/:customerId/tickets" element={<CustomerViewWrapper><CustomerViewTickets /></CustomerViewWrapper>} />
                  <Route path="/portal/customers/:customerId/tickets/:ticketNumber" element={<CustomerViewWrapper><CustomerViewTicketDetail /></CustomerViewWrapper>} />
                  <Route path="/portal/customers/:customerId/offers" element={<CustomerViewWrapper><CustomerViewOffers /></CustomerViewWrapper>} />
                  <Route path="/portal/customers/:customerId/offers/:quoteId" element={<CustomerViewWrapper><CustomerViewOfferDetail /></CustomerViewWrapper>} />
                  <Route path="/portal/customers/:customerId/home-profile" element={<CustomerViewWrapper><CustomerViewHomeProfile /></CustomerViewWrapper>} />
                  <Route path="/portal/customers/:customerId/energy-modeling" element={<CustomerViewWrapper><CustomerViewEnergyModeling /></CustomerViewWrapper>} />

                  {/* Accounting routes */}
                  <Route path="/accounting" element={<AccountingOverview />} />
                  <Route path="/accounting/overview" element={<AccountingOverview />} />
                  <Route path="/accounting/periods" element={<AccountingPeriods />} />
                  <Route path="/accounting/purchases" element={<PurchasesList />} />
                  <Route path="/accounting/purchases/upload" element={<PurchaseUpload />} />
                  <Route path="/accounting/purchases/:purchaseId" element={<PurchaseDetail />} />
                  <Route path="/accounting/journal" element={<AccountingJournal />} />
                  <Route path="/accounting/vat-periods" element={<VatPeriodsList />} />
                  <Route path="/accounting/vat-periods/:periodId" element={<VatDeclarationFlow />} />
                  <Route path="/accounting/suppliers" element={<SuppliersList />} />

                  <Route path="*" element={<NotFound />} />
                </Routes>
              </Suspense>
            </ScrollManager>
          </BrowserRouter>
        </TooltipProvider>
      </LanguageProvider>
    </AuthProvider>
  </QueryClientProvider>
);

export default App;
