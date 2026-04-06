import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const COURSE_OPTIONS = {
  '144287': { name: 'Sound Guy Essentials', circleSpaceId: 2092678 },
  '144288': { name: 'X32 Masterclass', circleSpaceId: 2092835 },
  '144289': { name: 'Sunday Vocal Formula', circleSpaceId: 2331083 },
  '144291': { name: 'Drums Masterclass', circleSpaceId: 2092837 },
  '144292': { name: 'EQ Secrets Masterclass', circleSpaceId: 2092710 },
};

// Verify the request is from an approved admin email via Supabase Bearer token
async function verifyAdmin(req) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { error: 'Unauthorized', status: 401 };
  }

  const accessToken = authHeader.split(' ')[1];
  const supabaseAuth = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
  const { data: { user }, error } = await supabaseAuth.auth.getUser(accessToken);

  if (error || !user) {
    return { error: 'Unauthorized', status: 401 };
  }

  const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase());
  if (!adminEmails.includes(user.email.toLowerCase())) {
    return { error: 'Forbidden', status: 403 };
  }

  return { user };
}

function generateToken() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 12 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await verifyAdmin(req);
  if (auth.error) return res.status(auth.status).json({ error: auth.error });

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

  // Check if an unclaimed claim already exists for this email + course
  const { data: existing } = await supabase
    .from('legacy_claims')
    .select('id, token')
    .eq('leader_email', leaderEmail.toLowerCase())
    .eq('circle_paywall_id', String(circlePaywallId))
    .eq('claimed', false)
    .single();

  if (existing) {
    // Return the existing claim link rather than creating a duplicate
    const claimUrl = `${process.env.SITE_URL}/claim?token=${existing.token}`;
    return res.status(200).json({ success: true, claimUrl, note: 'Existing unclaimed claim returned' });
  }

  const token = generateToken();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days

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

  const claimUrl = `${process.env.SITE_URL}/claim?token=${token}`;
  console.log('Legacy claim created for', leaderEmail, '— course:', course.name, '— seats:', seatCount, '— token:', token);

  return res.status(200).json({ success: true, claimUrl });
}
