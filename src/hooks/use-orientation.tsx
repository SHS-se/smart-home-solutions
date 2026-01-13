import * as React from "react";

const MOBILE_BREAKPOINT = 768;

export function useIsPortrait() {
  const [isPortrait, setIsPortrait] = React.useState<boolean>(false);
  const [isMobile, setIsMobile] = React.useState<boolean>(false);

  React.useEffect(() => {
    const checkOrientation = () => {
      const isPortraitMode = window.innerHeight > window.innerWidth;
      const isMobileWidth = window.innerWidth < MOBILE_BREAKPOINT;
      setIsPortrait(isPortraitMode);
      setIsMobile(isMobileWidth);
    };

    checkOrientation();
    
    window.addEventListener("resize", checkOrientation);
    window.addEventListener("orientationchange", checkOrientation);
    
    return () => {
      window.removeEventListener("resize", checkOrientation);
      window.removeEventListener("orientationchange", checkOrientation);
    };
  }, []);

  return { isPortrait, isMobile, isMobilePortrait: isMobile && isPortrait };
}
