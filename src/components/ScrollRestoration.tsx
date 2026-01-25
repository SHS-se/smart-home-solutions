import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

// Store scroll positions for each route
const scrollPositions = new Map<string, number>();

const ScrollRestoration = () => {
  const location = useLocation();

  useEffect(() => {
    // Create a unique key for the current location
    const key = location.key || location.pathname;

    // Check if we have a saved scroll position for this location
    const savedPosition = scrollPositions.get(key);
    
    if (savedPosition !== undefined) {
      // Restore scroll position (for back/forward navigation)
      window.scrollTo(0, savedPosition);
    }
    // Note: We don't scroll to top here - that's handled by ScrollToTopLink for forward navigation

    // Save scroll position before navigating away
    const saveScrollPosition = () => {
      scrollPositions.set(key, window.scrollY);
    };

    // Save position on scroll (debounced via passive listener)
    window.addEventListener('scroll', saveScrollPosition, { passive: true });

    return () => {
      // Save final position when leaving
      saveScrollPosition();
      window.removeEventListener('scroll', saveScrollPosition);
    };
  }, [location.key, location.pathname]);

  return null;
};

export default ScrollRestoration;
