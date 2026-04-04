import { useLayoutEffect, useRef, useEffect } from 'react';
import { useLocation, useNavigationType } from 'react-router-dom';

const scrollPositions = new Map<string, number>();
const STORAGE_PREFIX = 'shs.scrollY:';

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
    // Ignore storage failures
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

  const entryKey = location.key ?? `${location.pathname}${location.search}`;
  const urlKey = `${location.pathname}${location.search}`;
  const restoreKeys = entryKey === urlKey ? [entryKey] : [entryKey, urlKey];

  useLayoutEffect(() => {
    if ('scrollRestoration' in window.history) {
      window.history.scrollRestoration = 'manual';
    }
  }, []);

  useLayoutEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false;
      previousKeyRef.current = entryKey;

      const savedOnLoad = readScrollYForKeys(restoreKeys);
      if (savedOnLoad != null && savedOnLoad !== 0) {
        window.scrollTo({ left: 0, top: savedOnLoad, behavior: 'auto' });
      }
      return;
    }

    if (previousKeyRef.current === entryKey) {
      return;
    }

    if (previousKeyRef.current) {
      const lastKnown = scrollPositions.get(previousKeyRef.current);
      if (lastKnown != null) {
        writeStoredScrollY(previousKeyRef.current, lastKnown);
      }
    }

    if (navigationType === 'POP') {
      const savedPosition = readScrollYForKeys(restoreKeys);
      window.scrollTo({ left: 0, top: savedPosition ?? 0, behavior: 'auto' });
    } else {
      window.scrollTo({ left: 0, top: 0, behavior: 'auto' });
    }

    previousKeyRef.current = entryKey;
  }, [entryKey, navigationType, restoreKeys]);

  useEffect(() => {
    let rafId: number | null = null;
    let lastKnownScrollY = scrollPositions.get(entryKey) ?? 0;

    const flush = () => {
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
      if (rafId != null) {
        window.cancelAnimationFrame(rafId);
        rafId = null;
      }
      flush();
      window.removeEventListener('scroll', handleScroll);
    };
  }, [entryKey, urlKey]);

  return <>{children}</>;
};

export default ScrollManager;

