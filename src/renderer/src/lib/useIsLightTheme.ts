import { useEffect, useState } from 'react';

const isLight = (): boolean => typeof document !== 'undefined' && document.documentElement.classList.contains('light');

/** Whether the light theme is active; follows the class the app puts on <html>, so it updates live. */
export function useIsLightTheme(): boolean {
  const [light, setLight] = useState(isLight);

  useEffect(() => {
    setLight(isLight());
    const observer = new MutationObserver(() => setLight(isLight()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  return light;
}
