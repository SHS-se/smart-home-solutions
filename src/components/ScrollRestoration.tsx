import { useLayoutEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';

// Store scroll positions for each route
const scrollPositions = new Map<string, number>();

// Save current scroll position for the current location key
export const saveCurrentScrollPosition = (locationKey: string) => {
  scrollPositions.set(locationKey, window.scrollY);
};

// Get the current location key (for use before navigation)
let currentLocationKey: string | null = null;

export const getCurrentLocationKey = () => currentLocationKey;

const ScrollRestoration = () => {
  const location = useLocation();
  const isFirstRender = useRef(true);

  // Update the current location key
  currentLocationKey = location.key || location.pathname;

  // Disable browser's native scroll restoration
  useLayoutEffect(() => {
    if ('scrollRestoration' in window.history) {
      window.history.scrollRestoration = 'manual';
    }
  }, []);

  // Use useLayoutEffect to restore scroll position synchronously before paint
  useLayoutEffect(() => {
    const key = location.key || location.pathname;

    // Skip restoration on first render (let browser handle initial load)
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }

    // Check if we have a saved scroll position for this location (back/forward nav)
    const savedPosition = scrollPositions.get(key);
    if (savedPosition !== undefined) {
      // Restore saved position (back/forward navigation)
      window.scrollTo(0, savedPosition);
    } else {
      // No saved position means this is a new navigation - start at top
      window.scrollTo(0, 0);
    }
  }, [location.key, location.pathname]);

  // Save scroll position continuously.
  // IMPORTANT: Use useLayoutEffect so that the previous route's scroll listener is
  // removed *before* the next route's layout effects run (which may call scrollTo).
  // If we used useEffect here, the old listener could still be active when the new
  // route scrolls to top, overwriting the previous page's saved position with 0.
  useLayoutEffect(() => {
    const key = location.key || location.pathname;

    const saveScrollPosition = () => {
      scrollPositions.set(key, window.scrollY);
    };

    window.addEventListener('scroll', saveScrollPosition, { passive: true });

    return () => {
      // Save final position when unmounting
      scrollPositions.set(key, window.scrollY);
      window.removeEventListener('scroll', saveScrollPosition);
    };
  }, [location.key, location.pathname]);

  return null;
};

export default ScrollRestoration;
