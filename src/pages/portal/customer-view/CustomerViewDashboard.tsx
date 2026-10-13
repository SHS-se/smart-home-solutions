import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, Trash2 } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import EnergyClassPanel from '@/components/portal/energy-history/EnergyClassPanel';
import { DeleteCustomerDialog } from '@/components/portal/customers/DeleteCustomerDialog';
import { useAuth } from '@/contexts/AuthContext';
import { useViewedCustomer } from '@/contexts/ViewedCustomerContext';
import { useLanguage } from '@/contexts/LanguageContext';

const CustomerViewDashboard: React.FC = () => {
  const { user, isStaff, loading: authLoading } = useAuth();
  const { customerId, customerData, loading: customerLoading, error } = useViewedCustomer();
  const navigate = useNavigate();
  const { t } = useLanguage();
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);

  useEffect(() => {
    if (!authLoading && !user) navigate('/login');
    if (!authLoading && !isStaff) navigate('/portal');
  }, [user, isStaff, authLoading, navigate]);

  if (authLoading || customerLoading) {
    return (
      <>
        <div className="flex items-center justify-center min-h-[400px]">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
      </>
    );
  }

  if (error || !customerData) {
    return (
      <>
        <Alert variant="destructive">
          <AlertDescription>
            {error || t('Kunde inte hitta kunden.', 'Customer not found.')}
          </AlertDescription>
        </Alert>
      </>
    );
  }

  const basePath = `/portal/customers/${customerId}`;

  return (
    <>
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
          <h1 className="text-3xl font-medium">
            {customerData.name || t('Namnlös kund', 'Unnamed customer')}
          </h1>
          <Button variant="destructive" size="sm" onClick={() => setShowDeleteDialog(true)}>
            <Trash2 className="w-4 h-4 mr-2" />
            {t('Radera', 'Delete')}
          </Button>
        </div>

        {customerId && (
          <DeleteCustomerDialog
            open={showDeleteDialog}
            onOpenChange={setShowDeleteDialog}
            customerId={customerId}
            onDeleted={() => navigate('/portal/customers')}
          />
        )}

        {customerId && <EnergyClassPanel customerId={customerId} basePath={basePath} />}
      </div>
    </>
  );
};

export default CustomerViewDashboard;
