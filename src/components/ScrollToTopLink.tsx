import { Link, LinkProps } from 'react-router-dom';
import { forwardRef } from 'react';

interface ScrollToTopLinkProps extends LinkProps {
  children: React.ReactNode;
}

const ScrollToTopLink = forwardRef<HTMLAnchorElement, ScrollToTopLinkProps>(
  ({ children, onClick, ...props }, ref) => {
    const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
      window.scrollTo({ top: 0, behavior: 'instant' });
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
