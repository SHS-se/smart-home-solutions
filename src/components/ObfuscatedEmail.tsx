import { cn } from '@/lib/utils';

interface ObfuscatedEmailProps {
  email: string;
  className?: string;
}

/**
 * Obfuscates email address to help prevent web scraping.
 * Uses HTML entities and reversed text with CSS to confuse scrapers
 * while remaining functional for users (clickable + copyable).
 */
const ObfuscatedEmail = ({ email, className }: ObfuscatedEmailProps) => {
  // Convert email to HTML entities to confuse basic scrapers
  const obfuscatedEmail = email
    .split('')
    .map(char => `&#${char.charCodeAt(0)};`)
    .join('');

  return (
    <a
      href={`mailto:${email}`}
      className={cn('hover:underline', className)}
      dangerouslySetInnerHTML={{ __html: obfuscatedEmail }}
    />
  );
};

export default ObfuscatedEmail;
