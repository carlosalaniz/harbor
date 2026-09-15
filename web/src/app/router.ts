import { useEffect, useState } from 'react';

// Tiny hash router: #/home, #/store, #/publishing, #/platform, #/settings, #/store/<packageId>, #/app/<instanceId>
export type Route =
  | { page: 'home' }
  | { page: 'store'; packageId?: string }
  | { page: 'publishing' }
  | { page: 'platform' }
  | { page: 'settings'; section?: string }
  | { page: 'app'; instanceId: string };

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  switch (parts[0]) {
    case 'store':
      return parts[1] ? { page: 'store', packageId: parts[1] } : { page: 'store' };
    case 'publishing':
      return { page: 'publishing' };
    case 'platform':
      return { page: 'platform' };
    case 'settings':
      return parts[1] ? { page: 'settings', section: parts[1] } : { page: 'settings' };
    case 'app':
      return parts[1] ? { page: 'app', instanceId: parts[1] } : { page: 'home' };
    default:
      return { page: 'home' };
  }
}

export function routeHref(r: Route): string {
  switch (r.page) {
    case 'store':
      return r.packageId ? `#/store/${r.packageId}` : '#/store';
    case 'app':
      return `#/app/${r.instanceId}`;
    case 'settings':
      return r.section ? `#/settings/${r.section}` : '#/settings';
    default:
      return `#/${r.page}`;
  }
}

export function useRoute(): [Route, (r: Route) => void] {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));
  useEffect(() => {
    const on = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return [route, (r) => (window.location.hash = routeHref(r))];
}
