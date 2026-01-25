import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';

// Store scroll positions for each route
const scrollPositions = new Map<string, number>();

// Track if we should scroll to top on next navigation (set by ScrollToTopLink)
let shouldScrollToTop = false;

export const markScrollToTop = () => {
  shouldScrollToTop = true;
};

const ScrollRestoration = () => {
  const location = useLocation();
  const previousKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const currentKey = location.key || location.pathname;
    const previousKey = previousKeyRef.current;

    // Save the scroll position for the previous page before doing anything
    if (previousKey && previousKey !== currentKey) {
      // This position was already saved by the scroll listener, but ensure it's captured
    }

    // Check if we should scroll to top (forward navigation via ScrollToTopLink)
    if (shouldScrollToTop) {
      window.scrollTo(0, 0);
      shouldScrollToTop = false;
    } else {
      // Check if we have a saved scroll position for this location (back/forward nav)
      const savedPosition = scrollPositions.get(currentKey);
      if (savedPosition !== undefined) {
        // Small delay to ensure the page has rendered
        requestAnimationFrame(() => {
          window.scrollTo(0, savedPosition);
        });
      }
      // If no saved position and not marked for scroll-to-top, leave scroll as-is
    }

    // Update the previous key reference
    previousKeyRef.current = currentKey;

    // Save scroll position on scroll
    const saveScrollPosition = () => {
      scrollPositions.set(currentKey, window.scrollY);
    };

    window.addEventListener('scroll', saveScrollPosition, { passive: true });

    return () => {
      // Save final position when leaving this route
      scrollPositions.set(currentKey, window.scrollY);
      window.removeEventListener('scroll', saveScrollPosition);
    };
  }, [location.key, location.pathname]);

  return null;
};

export default ScrollRestoration;
