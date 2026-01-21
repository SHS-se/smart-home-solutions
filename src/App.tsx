import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { LanguageProvider } from "@/contexts/LanguageContext";
import { AuthProvider } from "@/contexts/AuthContext";
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

const queryClient = new QueryClient();

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
