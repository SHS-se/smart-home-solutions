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

interface ScrollManagerProps {
  children: React.ReactNode;
}

const ScrollManager = ({ children }: ScrollManagerProps) => {
  const location = useLocation();
  const navigationType = useNavigationType();
  const previousKeyRef = useRef<string | null>(null);
  const isInitialMount = useRef(true);
  const [isScrolling, setIsScrolling] = useState(false);

  const currentKey = location.key || location.pathname;

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
      return;
    }

    // Same route - no action needed
    if (previousKeyRef.current === currentKey) {
      return;
    }

    // Save the previous route's scroll position before we scroll away
    if (previousKeyRef.current) {
      scrollPositions.set(previousKeyRef.current, window.scrollY);
    }

    // Hide content, scroll, then reveal
    setIsScrolling(true);

    if (navigationType === 'POP') {
      // Back/Forward: restore saved position
      const savedPosition = scrollPositions.get(currentKey);
      window.scrollTo(0, savedPosition ?? 0);
    } else {
      // PUSH/REPLACE: scroll to top
      window.scrollTo(0, 0);
    }

    // Use requestAnimationFrame to ensure scroll has been applied before revealing
    requestAnimationFrame(() => {
      setIsScrolling(false);
    });

    previousKeyRef.current = currentKey;
  }, [currentKey, navigationType]);

  // Continuously save scroll position while on a page
  useEffect(() => {
    const handleScroll = () => {
      scrollPositions.set(currentKey, window.scrollY);
    };

    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      // Save final scroll position when leaving
      handleScroll();
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
