import { useEffect, useLayoutEffect } from 'react';
import { useLocation, useNavigationType } from 'react-router-dom';

/**
 * Standard web scroll behavior:
 * - New navigations (PUSH): scroll to top
 * - Back/Forward (POP): restore previous scroll position
 *
 * Uses the browser's native scroll restoration with manual control
 * to ensure React Router transitions work correctly.
 */
const scrollPositions = new Map<string, number>();

const ScrollManager = () => {
  const location = useLocation();
  const navigationType = useNavigationType();

  // Disable browser's native scroll restoration (we handle it manually)
  useLayoutEffect(() => {
    if ('scrollRestoration' in window.history) {
      window.history.scrollRestoration = 'manual';
    }
  }, []);

  // Handle scroll on navigation
  useLayoutEffect(() => {
    const key = location.key || location.pathname;

    if (navigationType === 'POP') {
      // Back/Forward navigation: restore saved position
      const savedPosition = scrollPositions.get(key);
      window.scrollTo(0, savedPosition ?? 0);
    } else {
      // PUSH or REPLACE: new navigation, scroll to top
      window.scrollTo(0, 0);
    }
  }, [location.key, location.pathname, navigationType]);

  // Save scroll position on scroll
  useEffect(() => {
    const key = location.key || location.pathname;

    const handleScroll = () => {
      scrollPositions.set(key, window.scrollY);
    };

    // Save immediately (in case we navigate away before scrolling)
    handleScroll();

    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      // Save final position before cleanup
      handleScroll();
      window.removeEventListener('scroll', handleScroll);
    };
  }, [location.key, location.pathname]);

  return null;
};

export default ScrollManager;
