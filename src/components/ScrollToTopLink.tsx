import { Link, LinkProps } from 'react-router-dom';
import { forwardRef } from 'react';
import { saveCurrentScrollPosition, getCurrentLocationKey } from './ScrollRestoration';

interface ScrollToTopLinkProps extends LinkProps {
  children: React.ReactNode;
}

const ScrollToTopLink = forwardRef<HTMLAnchorElement, ScrollToTopLinkProps>(
  ({ children, onClick, ...props }, ref) => {
    const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
      // Save current scroll position before navigating
      const currentKey = getCurrentLocationKey();
      if (currentKey) {
        saveCurrentScrollPosition(currentKey);
      }

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
