import { useEffect, useState } from 'react';

import { matchRoute, type Route } from './routes.js';

export function currentRoute(): Route {
  return matchRoute(globalThis.location.pathname);
}

export function navigate(path: string): void {
  globalThis.history.pushState({}, '', path);
  globalThis.dispatchEvent(new Event('popstate'));
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(currentRoute);

  useEffect(() => {
    const onChange = (): void => {
      setRoute(currentRoute());
    };

    globalThis.addEventListener('popstate', onChange);

    return (): void => {
      globalThis.removeEventListener('popstate', onChange);
    };
  }, []);

  return route;
}
