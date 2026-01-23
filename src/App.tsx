import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { LanguageProvider } from "@/contexts/LanguageContext";
import { AuthProvider } from "@/contexts/AuthContext";
import { ViewedCustomerProvider } from "@/contexts/ViewedCustomerContext";
import Index from "./pages/Index";
import Services from "./pages/Services";
import Knowledge from "./pages/Knowledge";
import About from "./pages/About";
import Contact from "./pages/Contact";
import NotFound from "./pages/NotFound";

// Portal pages
import Login from "./pages/portal/Login";
import Dashboard from "./pages/portal/Dashboard";
import Account from "./pages/portal/Account";
import Billing from "./pages/portal/Billing";
import TicketsList from "./pages/portal/TicketsList";
import NewTicket from "./pages/portal/NewTicket";
import TicketDetail from "./pages/portal/TicketDetail";
import Customers from "./pages/portal/Customers";
import Contacts from "./pages/portal/Contacts";
import ContactDetail from "./pages/portal/ContactDetail";

// Staff customer view pages
import CustomerViewDashboard from "./pages/portal/customer-view/CustomerViewDashboard";
import CustomerViewAccount from "./pages/portal/customer-view/CustomerViewAccount";
import CustomerViewBilling from "./pages/portal/customer-view/CustomerViewBilling";
import CustomerViewTickets from "./pages/portal/customer-view/CustomerViewTickets";
import CustomerViewTicketDetail from "./pages/portal/customer-view/CustomerViewTicketDetail";

const queryClient = new QueryClient();

// Wrapper component to provide ViewedCustomerProvider with route params
const CustomerViewWrapper = ({ children }: { children: React.ReactNode }) => (
  <ViewedCustomerProvider>{children}</ViewedCustomerProvider>
);

const App = () => (
  <QueryClientProvider client={queryClient}>
    <AuthProvider>
      <LanguageProvider>
        <TooltipProvider>
          <Toaster />
          <Sonner />
          <BrowserRouter>
            <Routes>
              {/* Public website */}
              <Route path="/" element={<Index />} />
              <Route path="/services" element={<Services />} />
              <Route path="/knowledge" element={<Knowledge />} />
              <Route path="/knowledge/:slug" element={<Knowledge />} />
              <Route path="/about" element={<About />} />
              <Route path="/contact" element={<Contact />} />
              
              {/* Customer Portal */}
              <Route path="/login" element={<Login />} />
              <Route path="/portal" element={<Dashboard />} />
              <Route path="/portal/account" element={<Account />} />
              <Route path="/portal/billing" element={<Billing />} />
              <Route path="/portal/tickets" element={<TicketsList />} />
              <Route path="/portal/tickets/new" element={<NewTicket />} />
              <Route path="/portal/tickets/:id" element={<TicketDetail />} />
              <Route path="/portal/customers" element={<Customers />} />
              <Route path="/portal/contacts" element={<Contacts />} />
              <Route path="/portal/contacts/:id" element={<ContactDetail />} />
              
              {/* Staff viewing customer portal */}
              <Route path="/portal/customers/:customerId/overview" element={<CustomerViewWrapper><CustomerViewDashboard /></CustomerViewWrapper>} />
              <Route path="/portal/customers/:customerId/account" element={<CustomerViewWrapper><CustomerViewAccount /></CustomerViewWrapper>} />
              <Route path="/portal/customers/:customerId/billing" element={<CustomerViewWrapper><CustomerViewBilling /></CustomerViewWrapper>} />
              <Route path="/portal/customers/:customerId/tickets" element={<CustomerViewWrapper><CustomerViewTickets /></CustomerViewWrapper>} />
              <Route path="/portal/customers/:customerId/tickets/:id" element={<CustomerViewWrapper><CustomerViewTicketDetail /></CustomerViewWrapper>} />
              
              {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
              <Route path="*" element={<NotFound />} />
            </Routes>
          </BrowserRouter>
        </TooltipProvider>
      </LanguageProvider>
    </AuthProvider>
  </QueryClientProvider>
);

export default App;
