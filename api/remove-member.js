import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const CIRCLE_API_TOKEN = process.env.CIRCLE_API_TOKEN;
const CIRCLE_COMMUNITY_ID = process.env.CIRCLE_COMMUNITY_ID;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { teamId, memberEmail } = req.body;

  if (!teamId || !memberEmail) {
    return res.status(400).json({ error: 'Team ID and member email are required' });
  }

  // Get the member record
  const { data: member, error } = await supabase
    .from('team_members')
    .select('id, member_circle_id')
    .eq('team_id', teamId)
    .eq('member_email', memberEmail.toLowerCase())
    .eq('status', 'active')
    .single();

  if (error || !member) {
    return res.status(404).json({ error: 'Member not found' });
  }

  // Remove from Circle
  if (member.member_circle_id) {
    await fetch(
      `https://app.circle.so/api/admin/v2/community_members/${member.member_circle_id}?community_id=${CIRCLE_COMMUNITY_ID}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${CIRCLE_API_TOKEN}` }
      }
    );
  }

  // Update status in Supabase
  await supabase
    .from('team_members')
    .update({ status: 'revoked' })
    .eq('id', member.id);

  return res.status(200).json({ success: true });
}
