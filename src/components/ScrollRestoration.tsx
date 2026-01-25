import { useEffect, useLayoutEffect, useRef } from 'react';
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
      window.scrollTo(0, savedPosition);
    }
    // If no saved position, page will be at top (where ScrollToTopLink left it)
  }, [location.key, location.pathname]);

  // Save scroll position continuously
  useEffect(() => {
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
