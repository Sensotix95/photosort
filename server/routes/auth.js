const router = require('express').Router();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const jwt = require('jsonwebtoken');

// In-memory store for pending JWT exchanges.
// Keyed by Stripe session ID; set by webhook, consumed once by /token endpoint.
const pendingTokens = new Map();

function signToken(session) {
  return jwt.sign(
    {
      paid: true,
      email: session.customer_details?.email ?? null,
      customerId: session.customer ?? null,
    },
    process.env.JWT_SECRET
    // No expiry — lifetime license. Add { expiresIn: '365d' } if you want annual renewal.
  );
}

// GET /api/auth/config — return Stripe publishable key (safe to expose)
router.get('/config', (_req, res) => {
  res.json({ publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '' });
});

// POST /api/auth/checkout-popup — create Stripe Checkout session for popup flow
// success_url points to /payment-complete which postMessages back to the opener
router.post('/checkout-popup', async (_req, res) => {
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      mode: 'payment',
      success_url: `${process.env.FRONTEND_URL}/payment-complete?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${process.env.FRONTEND_URL}/`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe checkout-popup error:', err.message);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// POST /api/auth/checkout — create Stripe Checkout session (redirect flow, kept as fallback)
router.post('/checkout', async (_req, res) => {
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      mode: 'payment',
      success_url: `${process.env.FRONTEND_URL}/?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL}/`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe checkout error:', err.message);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// POST /api/auth/checkout-embedded — create embedded Stripe Checkout session
router.post('/checkout-embedded', async (_req, res) => {
  try {
    const session = await stripe.checkout.sessions.create({
      ui_mode: 'embedded',
      payment_method_types: ['card'],
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      mode: 'payment',
      return_url: `${process.env.FRONTEND_URL}/payment-complete?session_id={CHECKOUT_SESSION_ID}`,
    });
    res.json({ clientSecret: session.client_secret });
  } catch (err) {
    console.error('Stripe embedded checkout error:', err.message);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// POST /api/auth/webhook — Stripe sends payment confirmation here
// Note: raw body parsing is configured in server/index.js before this route is mounted.
router.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return res.status(400).json({ error: `Webhook error: ${err.message}` });
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const token = signToken(session);
    pendingTokens.set(session.id, token);
    // Auto-clean after 1 hour (user should exchange within seconds of redirect)
    setTimeout(() => pendingTokens.delete(session.id), 3_600_000);
    console.log('Payment confirmed for session:', session.id);
  }

  res.json({ received: true });
});

// GET /api/auth/token?session_id=xxx — exchange Stripe session ID for a JWT
router.get('/token', async (req, res) => {
  const { session_id } = req.query;
  if (!session_id) return res.status(400).json({ error: 'Missing session_id' });

  // Preferred path: webhook already fired and pre-signed the token
  if (pendingTokens.has(session_id)) {
    const token = pendingTokens.get(session_id);
    pendingTokens.delete(session_id); // one-time use
    return res.json({ token });
  }

  // Fallback: verify directly with Stripe (covers webhook race conditions)
  try {
    const session = await stripe.checkout.sessions.retrieve(session_id);
    if (session.payment_status !== 'paid') {
      return res.status(402).json({ error: 'Payment not completed' });
    }
    return res.json({ token: signToken(session) });
  } catch (err) {
    console.error('Token exchange error:', err.message);
    return res.status(404).json({ error: 'Session not found' });
  }
});

// POST /api/auth/verify — check if a stored JWT is still valid
router.post('/verify', (req, res) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ valid: false });
  try {
    const payload = jwt.verify(auth.slice(7), process.env.JWT_SECRET);
    res.json({ valid: true, email: payload.email });
  } catch {
    res.status(401).json({ valid: false });
  }
});

// POST /api/auth/test-login — password-based access for testing (no payment required)
router.post('/test-login', (req, res) => {
  const { password } = req.body;
  if (!password || password !== process.env.TEST_PASSWORD) {
    return res.status(401).json({ error: 'Wrong password' });
  }
  const token = jwt.sign({ paid: true, email: 'test@local', customerId: 'test' }, process.env.JWT_SECRET);
  res.json({ token });
});

// GET /api/auth/dev-token — issues a test token for the /patrick dev page (no password, security by obscurity)
router.get('/dev-token', (req, res) => {
  const token = jwt.sign({ paid: true, email: 'test@local', customerId: 'test' }, process.env.JWT_SECRET);
  res.json({ token });
});

module.exports = router;
