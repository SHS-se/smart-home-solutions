import { Link, LinkProps } from 'react-router-dom';
import { forwardRef } from 'react';
import { markScrollToTop } from './ScrollRestoration';

interface ScrollToTopLinkProps extends LinkProps {
  children: React.ReactNode;
}

const ScrollToTopLink = forwardRef<HTMLAnchorElement, ScrollToTopLinkProps>(
  ({ children, onClick, ...props }, ref) => {
    const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
      // Mark that we should scroll to top on the next page (after navigation)
      markScrollToTop();
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
