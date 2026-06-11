import React from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';

const FullScreenLoader: React.FC = () => (
  <div className="flex min-h-screen items-center justify-center bg-background">
    <Loader2 className="h-8 w-8 animate-spin text-primary" />
  </div>
);

/** Route guard: requires a signed-in user, otherwise redirects to /login. */
export const RequireAuth: React.FC = () => {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) return <FullScreenLoader />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <Outlet />;
};

/** Route guard: requires staff permissions, otherwise redirects to the portal. */
export const RequireStaff: React.FC = () => {
  const { isStaff, loading } = useAuth();

  if (loading) return <FullScreenLoader />;
  if (!isStaff) return <Navigate to="/portal" replace />;
  return <Outlet />;
};
