import { handleRequest } from '../backend/server.mjs';

export default async function handler(req, res) {
  // vercel.json sends all /api/* paths here and passes the original path in
  // __route so the existing API router can keep its URL contract.
  const route = req.query?.__route || new URL(req.url || '/', 'https://vercel.invalid').searchParams.get('__route');
  if (typeof route === 'string' && route.startsWith('/api/')) {
    const incoming = new URL(req.url || '/', 'https://vercel.invalid');
    incoming.searchParams.delete('__route');
    const query = incoming.searchParams.toString();
    req.url = `${route}${query ? `?${query}` : ''}`;
  }
  return handleRequest(req, res);
}
