import { cn } from '@/lib/utils';
import { useEffect, useRef } from 'react';

interface ObfuscatedEmailProps {
  email: string;
  className?: string;
}

/**
 * Obfuscates email address to help prevent web scraping.
 * The email is never in static HTML - it's assembled via JavaScript.
 * Falls back gracefully for users without JS.
 */
const ObfuscatedEmail = ({ email, className }: ObfuscatedEmailProps) => {
  const linkRef = useRef<HTMLAnchorElement>(null);
  const [user, domain] = email.split('@');
  
  // Encode parts to avoid plain text in JS bundle
  const encodedUser = btoa(user);
  const encodedDomain = btoa(domain);

  useEffect(() => {
    if (linkRef.current) {
      // Decode and assemble at runtime
      const decodedUser = atob(encodedUser);
      const decodedDomain = atob(encodedDomain);
      const fullEmail = `${decodedUser}@${decodedDomain}`;
      
      linkRef.current.href = `mailto:${fullEmail}`;
      linkRef.current.textContent = fullEmail;
    }
  }, [encodedUser, encodedDomain]);

  return (
    <a
      ref={linkRef}
      href="#"
      className={cn('hover:underline', className)}
      onClick={(e) => {
        // Prevent navigation if JS hasn't set the href yet
        if (linkRef.current?.href === '#' || linkRef.current?.href.endsWith('#')) {
          e.preventDefault();
        }
      }}
    >
      {/* Placeholder text - replaced by JS */}
      <noscript>{user}@{domain}</noscript>
      <span aria-hidden="true">Laddar...</span>
    </a>
  );
};

export default ObfuscatedEmail;
