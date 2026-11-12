// Keep application routes independent of the deployment directory.
export const basePath = import.meta.env.BASE_URL;

export function publicPath(path: string): string {
  return `${basePath}${path.replace(/^\/+/, '')}`;
}

export function appPath(pathname: string): string {
  const prefix = basePath.replace(/\/$/, '');
  const local = prefix && (pathname === prefix || pathname.startsWith(`${prefix}/`))
    ? pathname.slice(prefix.length)
    : pathname;
  return local.replace(/\/+$/, '') || '/';
}
