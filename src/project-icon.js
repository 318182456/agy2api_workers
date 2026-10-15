// Shared vector mark for the browser tab, login screen and navigation.
export const projectIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64" aria-hidden="true" focusable="false">
  <rect x="1" y="1" width="62" height="62" rx="18" fill="#4263e9"/>
  <path d="M40 21a15 15 0 1 0 5 19v-8H32" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="m49 10 2.2 5.8L57 18l-5.8 2.2L49 26l-2.2-5.8L41 18l5.8-2.2Z" fill="#a8edff"/>
</svg>`;

export function iconResponse(request) {
  const headers = {
    'content-type': 'image/svg+xml; charset=utf-8',
    'cache-control': 'public, max-age=86400',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'",
  };
  return new Response(request.method === 'HEAD' ? null : projectIcon, { headers });
}
