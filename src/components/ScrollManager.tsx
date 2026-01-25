import { useLayoutEffect, useRef, useState, useEffect } from 'react';
import { useLocation, useNavigationType } from 'react-router-dom';

/**
 * Proper scroll management for SPAs.
 * 
 * The Problem:
 * React renders the new page content BEFORE we can scroll. Even useLayoutEffect
 * runs after the new DOM is committed, so there's a brief moment where the new
 * page is visible at the old scroll position.
 * 
 * The Solution:
 * We use CSS to hide content during the scroll transition, then reveal it
 * once scroll is at the correct position. This prevents any visible "jump".
 */
const scrollPositions = new Map<string, number>();

// Session-scoped persistence (per-tab) so back/forward after a hard reload can still restore.
// Using sessionStorage (not localStorage) prevents restoring scroll on a fresh new tab.
const STORAGE_PREFIX = "shs.scrollY:";

const readStoredScrollY = (key: string): number | undefined => {
  try {
    const raw = sessionStorage.getItem(`${STORAGE_PREFIX}${key}`);
    if (raw == null) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  } catch {
    return undefined;
  }
};

const writeStoredScrollY = (key: string, y: number) => {
  scrollPositions.set(key, y);
  try {
    sessionStorage.setItem(`${STORAGE_PREFIX}${key}`, String(y));
  } catch {
    // Ignore storage quota / privacy mode failures
  }
};

interface ScrollManagerProps {
  children: React.ReactNode;
}

const ScrollManager = ({ children }: ScrollManagerProps) => {
  const location = useLocation();
  const navigationType = useNavigationType();
  const previousKeyRef = useRef<string | null>(null);
  const isInitialMount = useRef(true);
  const [isScrolling, setIsScrolling] = useState(false);

  // Key by URL (reference implementation allows customizing getKey; this matches browser-ish behavior)
  // and avoids relying on location.key stability across environments.
  const currentKey = `${location.pathname}${location.search}`;

  // Disable browser's native scroll restoration
  useLayoutEffect(() => {
    if ('scrollRestoration' in window.history) {
      window.history.scrollRestoration = 'manual';
    }
  }, []);

  // Handle scroll synchronously before paint
  useLayoutEffect(() => {
    // Initial mount - just record the key, don't do anything
    if (isInitialMount.current) {
      isInitialMount.current = false;
      previousKeyRef.current = currentKey;

      // If this tab previously visited this URL (reload/back after hard nav), restore.
      const savedOnLoad = scrollPositions.get(currentKey) ?? readStoredScrollY(currentKey);
      if (savedOnLoad != null && savedOnLoad !== 0) {
        setIsScrolling(true);
        window.scrollTo({ left: 0, top: savedOnLoad, behavior: 'auto' });
        requestAnimationFrame(() => setIsScrolling(false));
      }
      return;
    }

    // Same route - no action needed
    if (previousKeyRef.current === currentKey) {
      return;
    }

    // Save the previous route's scroll position before we scroll away
    if (previousKeyRef.current) {
      writeStoredScrollY(previousKeyRef.current, window.scrollY);
    }

    // Hide content, scroll, then reveal
    setIsScrolling(true);

    if (navigationType === 'POP') {
      // Back/Forward: restore saved position
      const savedPosition = scrollPositions.get(currentKey) ?? readStoredScrollY(currentKey);
      // Force instant jump even if CSS sets `scroll-behavior: smooth`
      window.scrollTo({ left: 0, top: savedPosition ?? 0, behavior: 'auto' });
    } else {
      // PUSH/REPLACE: scroll to top
      // Force instant jump even if CSS sets `scroll-behavior: smooth`
      window.scrollTo({ left: 0, top: 0, behavior: 'auto' });
    }

    // Use requestAnimationFrame to ensure scroll has been applied before revealing
    requestAnimationFrame(() => {
      setIsScrolling(false);
    });

    previousKeyRef.current = currentKey;
  }, [currentKey, navigationType]);

  // Continuously save scroll position while on a page
  useEffect(() => {
    let rafId: number | null = null;

    const flush = () => {
      writeStoredScrollY(currentKey, window.scrollY);
    };

    const handleScroll = () => {
      if (rafId != null) return;
      rafId = window.requestAnimationFrame(() => {
        rafId = null;
        flush();
      });
    };

    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      // Save final scroll position when leaving
      if (rafId != null) {
        window.cancelAnimationFrame(rafId);
        rafId = null;
      }
      flush();
      window.removeEventListener('scroll', handleScroll);
    };
  }, [currentKey]);

  return (
    <div 
      style={{ 
        opacity: isScrolling ? 0 : 1,
        transition: 'none'
      }}
    >
      {children}
    </div>
  );
};

export default ScrollManager;
