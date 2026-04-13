import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const COURSE_OPTIONS = {
  '144287': { name: 'Sound Guy Essentials' },
  '144288': { name: 'X32 Masterclass' },
  '144291': { name: 'Drums Masterclass' },
  '144292': { name: 'EQ Secrets Masterclass' },
};

function verifyAdminToken(req) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) return false;

  const token = authHeader.split(' ')[1];
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) return false;

  try {
    const decoded = Buffer.from(token, 'base64').toString('utf8');
    const [payload, sig] = decoded.split('.');
    const expectedSig = crypto.createHmac('sha256', adminPassword).update(payload).digest('hex');
    if (sig !== expectedSig) return false;

    const expires = parseInt(payload);
    if (Date.now() > expires) return false;

    return true;
  } catch {
    return false;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  if (!verifyAdminToken(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'email is required' });

  const { data: purchases, error } = await supabase
    .from('legacy_purchases')
    .select('customer_name, customer_email, circle_paywall_id, order_count')
    .eq('customer_email', email.toLowerCase().trim());

  if (error) {
    console.error('Error looking up purchases:', error);
    return res.status(500).json({ error: 'Failed to look up purchases' });
  }

  // Also check if claims already exist for any of these courses
  const { data: existingClaims } = await supabase
    .from('legacy_claims')
    .select('circle_paywall_id, claimed')
    .eq('leader_email', email.toLowerCase().trim());

  const claimedPaywallIds = new Set(
    (existingClaims || []).filter(c => c.claimed).map(c => c.circle_paywall_id)
  );
  const pendingPaywallIds = new Set(
    (existingClaims || []).filter(c => !c.claimed).map(c => c.circle_paywall_id)
  );

  const results = (purchases || []).map(p => ({
    customerName: p.customer_name,
    circlePaywallId: p.circle_paywall_id,
    courseName: COURSE_OPTIONS[p.circle_paywall_id]?.name || p.circle_paywall_id,
    orderCount: p.order_count,
    seatCount: p.order_count * 5,
    alreadyClaimed: claimedPaywallIds.has(p.circle_paywall_id),
    claimPending: pendingPaywallIds.has(p.circle_paywall_id),
  }));

  return res.status(200).json({
    email: email.toLowerCase().trim(),
    found: results.length > 0,
    purchases: results
  });
}
