import { Link, LinkProps } from 'react-router-dom';
import { forwardRef } from 'react';
import { saveCurrentScrollPosition, getCurrentLocationKey } from './ScrollRestoration';

interface ScrollToTopLinkProps extends LinkProps {
  children: React.ReactNode;
}

const ScrollToTopLink = forwardRef<HTMLAnchorElement, ScrollToTopLinkProps>(
  ({ children, onClick, ...props }, ref) => {
    const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
      // Save current scroll position BEFORE scrolling to top
      const currentKey = getCurrentLocationKey();
      if (currentKey) {
        saveCurrentScrollPosition(currentKey);
      }
      
      // Scroll to top immediately (no visible jump on new page)
      window.scrollTo(0, 0);
      
      onClick?.(e);
    };

    return (
      <Link ref={ref} onClick={handleClick} {...props}>
        {children}
      </Link>
    );
  }
);

ScrollToTopLink.displayName = 'ScrollToTopLink';

export default ScrollToTopLink;
