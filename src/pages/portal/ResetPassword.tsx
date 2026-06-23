import React, { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, Loader2, Lock, CheckCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/integrations/supabase/client';
import { useLanguage } from '@/contexts/LanguageContext';
import LanguageToggle from '@/components/LanguageToggle';

const ResetPassword: React.FC = () => {
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [hasSession, setHasSession] = useState(false);
  const { toast } = useToast();
  const navigate = useNavigate();
  const { t } = useLanguage();

  useEffect(() => {
    // Check if user has a valid session from the reset link
    const checkSession = async () => {
      const { data: { session } } = await supabase.auth.getSession();
      setHasSession(!!session);
    };
    checkSession();

    // Listen for auth state changes (when user clicks reset link)
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY') {
        setHasSession(true);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (password !== confirmPassword) {
      toast({
        title: t('Fel', 'Error'),
        description: t('Lösenorden matchar inte.', 'Passwords do not match.'),
        variant: 'destructive',
      });
      return;
    }

    if (password.length < 8) {
      toast({
        title: t('Fel', 'Error'),
        description: t('Lösenordet måste vara minst 8 tecken.', 'Password must be at least 8 characters.'),
        variant: 'destructive',
      });
      return;
    }

    setIsLoading(true);

    try {
      const { error } = await supabase.auth.updateUser({ password });

      if (error) throw error;

      setSuccess(true);
      toast({
        title: t('Lösenord uppdaterat!', 'Password updated!'),
        description: t('Du kan nu logga in med ditt nya lösenord.', 'You can now log in with your new password.'),
      });

      // Sign out and redirect to login
      await supabase.auth.signOut();
      setTimeout(() => navigate('/login'), 2000);
    } catch (error) {
      toast({
        title: t('Fel', 'Error'),
        description: error.message || t('Det gick inte att uppdatera lösenordet.', 'Failed to update password.'),
        variant: 'destructive',
      });
    } finally {
      setIsLoading(false);
    }
  };

  if (!hasSession && !success) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-background p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <CardTitle className="text-2xl">{t('Ogiltig länk', 'Invalid link')}</CardTitle>
            <CardDescription>
              {t('Återställningslänken är ogiltig eller har gått ut.', 'The reset link is invalid or has expired.')}
            </CardDescription>
          </CardHeader>
          <CardContent className="text-center">
            <Link to="/login">
              <Button variant="outline">
                <ArrowLeft className="w-4 h-4 mr-2" />
                {t('Tillbaka till inloggning', 'Back to login')}
              </Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-background p-4">
      <div className="absolute top-4 right-4">
        <LanguageToggle />
      </div>

      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">{t('Nytt lösenord', 'New password')}</CardTitle>
          <CardDescription>
            {t('Ange ditt nya lösenord nedan.', 'Enter your new password below.')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {success ? (
            <div className="text-center py-8">
              <CheckCircle className="w-12 h-12 mx-auto text-primary mb-4" />
              <h3 className="text-lg font-medium mb-2">{t('Lösenord uppdaterat!', 'Password updated!')}</h3>
              <p className="text-muted-foreground mb-6">
                {t('Du omdirigeras till inloggningen...', 'Redirecting to login...')}
              </p>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="password">{t('Nytt lösenord', 'New password')}</Label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <Input
                    id="password"
                    type="password"
                    placeholder="••••••••"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="pl-10"
                    required
                    disabled={isLoading}
                    minLength={8}
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="confirmPassword">{t('Bekräfta lösenord', 'Confirm password')}</Label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <Input
                    id="confirmPassword"
                    type="password"
                    placeholder="••••••••"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    className="pl-10"
                    required
                    disabled={isLoading}
                    minLength={8}
                  />
                </div>
              </div>

              <Button type="submit" className="w-full" disabled={isLoading}>
                {isLoading && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                {t('Uppdatera lösenord', 'Update password')}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>

      <Link
        to="/login"
        className="mt-8 flex items-center gap-2 text-sm text-primary hover:underline"
      >
        <ArrowLeft className="w-4 h-4" />
        {t('Tillbaka till inloggning', 'Back to login')}
      </Link>
    </div>
  );
};

export default ResetPassword;
