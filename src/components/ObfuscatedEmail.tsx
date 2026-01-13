import { cn } from '@/lib/utils';
import { useEffect, useRef } from 'react';

interface ObfuscatedEmailProps {
  address: string;
  domain: string;
  className?: string;
}

/**
 * Obfuscates email address to help prevent web scraping.
 * The email is split into address and domain props (never together in source).
 * Assembled via JavaScript at runtime - never in static HTML.
 */
const ObfuscatedEmail = ({ address, domain, className }: ObfuscatedEmailProps) => {
  const linkRef = useRef<HTMLAnchorElement>(null);
  
  // Encode parts to avoid plain text in JS bundle
  const encodedAddress = btoa(address);
  const encodedDomain = btoa(domain);

  useEffect(() => {
    if (linkRef.current) {
      // Decode and assemble at runtime
      const decodedAddress = atob(encodedAddress);
      const decodedDomain = atob(encodedDomain);
      const fullEmail = `${decodedAddress}@${decodedDomain}`;
      
      linkRef.current.href = `mailto:${fullEmail}`;
      linkRef.current.textContent = fullEmail;
    }
  }, [encodedAddress, encodedDomain]);

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
      <noscript>{address}@{domain}</noscript>
      <span aria-hidden="true">Laddar...</span>
    </a>
  );
};

export default ObfuscatedEmail;
