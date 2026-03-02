import { createClient } from '@supabase/supabase-js';
import { verifySession } from './auth-helper.js';
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const CIRCLE_API_TOKEN = process.env.CIRCLE_API_TOKEN;
const CIRCLE_COMMUNITY_ID = process.env.CIRCLE_COMMUNITY_ID;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { memberEmail } = req.body;
  if (!memberEmail) {
    return res.status(400).json({ error: 'Member email is required' });
  }

  // Verify the session — no teamId check here since resend only needs
  // the caller to be a valid authenticated leader
  const auth = await verifySession(req, null);
  if (auth.error) {
    return res.status(auth.status).json({ error: auth.error });
  }

  // Verify this member exists and is active in Supabase
  const { data: member, error } = await supabase
    .from('team_members')
    .select('id, invite_status')
    .eq('member_email', memberEmail.toLowerCase())
    .eq('status', 'active')
    .in('invite_status', ['invited', 'opened'])
    .single();

  if (error || !member) {
    return res.status(404).json({ error: 'Member not found or already enrolled' });
  }

  // POST to Circle with skip_invitation: false
  // For existing members this returns 'already a member' but should still
  // trigger a new invite email. Needs verification in testing.
  const circleRes = await fetch(
    'https://app.circle.so/api/admin/v2/community_members',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${CIRCLE_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        community_id: parseInt(CIRCLE_COMMUNITY_ID),
        email: memberEmail.toLowerCase(),
        skip_invitation: false
      })
    }
  );

  const circleData = await circleRes.json();
  console.log('Circle resend invite response:', JSON.stringify(circleData));

  if (!circleRes.ok) {
    console.error('Circle resend failed:', circleData);
    return res.status(500).json({ error: 'Failed to resend invite via Circle' });
  }

  return res.status(200).json({ success: true });
}
