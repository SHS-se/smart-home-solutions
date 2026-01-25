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

const readScrollYForKeys = (keys: string[]): number | undefined => {
  for (const key of keys) {
    const inMemory = scrollPositions.get(key);
    if (inMemory != null) return inMemory;
    const stored = readStoredScrollY(key);
    if (stored != null) return stored;
  }
  return undefined;
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

  // React Router's reference implementation restores by history entry key.
  // Keep a URL-based fallback only for resilience across hard reloads.
  const entryKey = location.key ?? `${location.pathname}${location.search}`;
  const urlKey = `${location.pathname}${location.search}`;
  const restoreKeys = entryKey === urlKey ? [entryKey] : [entryKey, urlKey];

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
      previousKeyRef.current = entryKey;

      // If this tab previously visited this URL (reload/back after hard nav), restore.
      const savedOnLoad = readScrollYForKeys(restoreKeys);
      if (savedOnLoad != null && savedOnLoad !== 0) {
        setIsScrolling(true);
        window.scrollTo({ left: 0, top: savedOnLoad, behavior: 'auto' });
        requestAnimationFrame(() => setIsScrolling(false));
      }
      return;
    }

    // Same route - no action needed
    if (previousKeyRef.current === entryKey) {
      return;
    }

    // Save the previous route's scroll position before we scroll away
    if (previousKeyRef.current) {
      // IMPORTANT: don't read from window.scrollY here (it may already be clamped/reset
      // due to the next page rendering). Use the last known value we have saved.
      const lastKnown = scrollPositions.get(previousKeyRef.current);
      if (lastKnown != null) {
        writeStoredScrollY(previousKeyRef.current, lastKnown);
      }
    }

    // Hide content, scroll, then reveal
    setIsScrolling(true);

    if (navigationType === 'POP') {
      // Back/Forward: restore saved position
      const savedPosition = readScrollYForKeys(restoreKeys);
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

    previousKeyRef.current = entryKey;
  }, [entryKey, navigationType]);

  // Continuously save scroll position while on a page
  useEffect(() => {
    let rafId: number | null = null;
    // Track last known scrollY for this specific history entry so cleanup doesn't
    // overwrite it after route transitions (when window.scrollY may already be 0).
    let lastKnownScrollY = scrollPositions.get(entryKey) ?? 0;

    const flush = () => {
      // Save under both keys: per-entry (correct for back/forward) and URL fallback.
      writeStoredScrollY(entryKey, lastKnownScrollY);
      if (urlKey !== entryKey) writeStoredScrollY(urlKey, lastKnownScrollY);
    };

    const handleScroll = () => {
      lastKnownScrollY = window.scrollY;
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
  }, [entryKey, urlKey]);

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
