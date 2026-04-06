import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

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

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await verifyAdmin(req);
  if (auth.error) return res.status(auth.status).json({ error: auth.error });

  const { data: claims, error } = await supabase
    .from('legacy_claims')
    .select('token, leader_email, circle_paywall_id, seat_count, claimed, claimed_at, created_at, expires_at')
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) {
    console.error('Error fetching claims:', error);
    return res.status(500).json({ error: 'Failed to fetch claims' });
  }

  return res.status(200).json({ claims: claims || [] });
}
