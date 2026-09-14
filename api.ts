const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem('yc_token');
}

export function setToken(token: string) {
  window.localStorage.setItem('yc_token', token);
}

export function clearToken() {
  window.localStorage.removeItem('yc_token');
}

async function request(path: string, options?: RequestInit) {
  const token = getToken();
  const res = await fetch(`${API_URL}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...options,
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export const api = {
  register: (email: string, password: string) =>
    request('/auth/register', { method: 'POST', body: JSON.stringify({ email, password }) }),
  login: (email: string, password: string) =>
    request('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),

  getMyWallet: () => request('/wallet/me'),
  getMyHistory: () => request('/wallet/me/history'),

  buy: (ycAmount: string) => request('/economy/buy', { method: 'POST', body: JSON.stringify({ ycAmount }) }),
  transfer: (toUserId: string, ycAmount: string) =>
    request('/economy/transfer', { method: 'POST', body: JSON.stringify({ toUserId, ycAmount }) }),
  burn: (ycAmount: string) => request('/economy/burn', { method: 'POST', body: JSON.stringify({ ycAmount }) }),
  redeem: (ycAmount: string, payoutMethod: 'CASH' | 'CHECK') =>
    request('/economy/redeem', { method: 'POST', body: JSON.stringify({ ycAmount, payoutMethod }) }),
};
