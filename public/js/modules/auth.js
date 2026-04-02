// Client-side auth — JWT storage, Stripe checkout redirect, gate check.

const TOKEN_KEY = 'photosorter_token';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function saveToken(token) {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

export function getAuthHeaders() {
  const token = getToken();
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}

// Returns { valid, email } — calls server to verify token
export async function verifyToken() {
  const token = getToken();
  if (!token) return { valid: false };
  try {
    const res = await fetch('/api/auth/verify', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) { clearToken(); return { valid: false }; }
    return res.json();
  } catch {
    // Network error — optimistically allow if token exists
    return { valid: true };
  }
}

// Called when Stripe redirects back with ?session_id=xxx
export async function exchangeSessionId(sessionId) {
  const res = await fetch(`/api/auth/token?session_id=${encodeURIComponent(sessionId)}`);
  if (!res.ok) throw new Error('Payment verification failed');
  const { token } = await res.json();
  saveToken(token);
  return token;
}

// Start Stripe checkout
export async function startCheckout() {
  const res = await fetch('/api/auth/checkout', { method: 'POST' });
  if (!res.ok) throw new Error('Failed to create checkout session');
  const { url } = await res.json();
  window.location.href = url;
}
