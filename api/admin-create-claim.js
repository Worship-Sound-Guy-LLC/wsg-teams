import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const COURSE_OPTIONS = {
  '144287': { name: 'Sound Guy Essentials', circleSpaceId: 2092678 },
  '144288': { name: 'X32 Masterclass', circleSpaceId: 2092835 },
  '144289': { name: 'Sunday Vocal Formula', circleSpaceId: 2331083 },
  '144291': { name: 'Drums Masterclass', circleSpaceId: 2092837 },
  '144292': { name: 'EQ Secrets Masterclass', circleSpaceId: 2092710 },
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

function generateToken() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 12 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!verifyAdminToken(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { leaderEmail, circlePaywallId, seatCount } = req.body;

  if (!leaderEmail || !circlePaywallId || !seatCount) {
    return res.status(400).json({ error: 'leaderEmail, circlePaywallId, and seatCount are required' });
  }

  const course = COURSE_OPTIONS[String(circlePaywallId)];
  if (!course) {
    return res.status(400).json({ error: 'Invalid course selection' });
  }

  if (seatCount < 1 || seatCount > 500) {
    return res.status(400).json({ error: 'Seat count must be between 1 and 500' });
  }

  // Check purchase record against legacy_purchases table
  const { data: purchaseRecord } = await supabase
    .from('legacy_purchases')
    .select('customer_name, order_count')
    .eq('customer_email', leaderEmail.toLowerCase())
    .eq('circle_paywall_id', String(circlePaywallId))
    .single();

  // purchaseVerified: true if found, false if not — admin can override either way
  const purchaseVerified = !!purchaseRecord;

  // If override not explicitly confirmed and no purchase record found, return warning
  const { override } = req.body;
  if (!purchaseVerified && !override) {
    return res.status(200).json({
      success: false,
      purchaseNotFound: true,
      warning: `No purchase record found for ${leaderEmail} on ${course.name}. If you are sure this is valid, resubmit with override: true.`
    });
  }

  // Check if an unclaimed claim already exists for this email + course
  const { data: existing } = await supabase
    .from('legacy_claims')
    .select('id, token')
    .eq('leader_email', leaderEmail.toLowerCase())
    .eq('circle_paywall_id', String(circlePaywallId))
    .eq('claimed', false)
    .single();

  if (existing) {
    const claimUrl = `${process.env.SITE_URL}/claim.html?token=${existing.token}`;
    return res.status(200).json({ success: true, claimUrl, purchaseVerified, note: 'Existing unclaimed claim returned' });
  }

  const token = generateToken();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  const { error } = await supabase.from('legacy_claims').insert({
    token,
    leader_email: leaderEmail.toLowerCase(),
    course_id: course.circleSpaceId,
    circle_paywall_id: String(circlePaywallId),
    seat_count: parseInt(seatCount),
    expires_at: expiresAt
  });

  if (error) {
    console.error('Error creating legacy claim:', error);
    return res.status(500).json({ error: 'Failed to create claim' });
  }

  const claimUrl = `${process.env.SITE_URL}/claim.html?token=${token}`;
  console.log('Legacy claim created for', leaderEmail, '— course:', course.name, '— seats:', seatCount, '— verified:', purchaseVerified);

  return res.status(200).json({ success: true, claimUrl, purchaseVerified });
}
