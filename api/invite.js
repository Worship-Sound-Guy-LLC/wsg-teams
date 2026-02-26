import { createClient } from '@supabase/supabase-js';
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { teamId, memberEmail } = req.body;
  if (!teamId || !memberEmail) {
    return res.status(400).json({ error: 'Team ID and member email are required' });
  }

  // Get the member record - filter by invite_status (not status)
  const { data: member, error } = await supabase
    .from('team_members')
    .select('id, member_circle_id')
    .eq('team_id', teamId)
    .eq('member_email', memberEmail.toLowerCase())
    .neq('invite_status', 'revoked')
    .single();

  if (error || !member) {
    return res.status(404).json({ error: 'Member not found' });
  }

  // NOTE: We intentionally do NOT delete from Circle.
  // Removed members keep their Circle account and free community access.
  // Full access revocation (access groups/subscriptions) to be implemented separately.

  // Update status in Supabase
  const { error: updateError } = await supabase
    .from('team_members')
    .update({ invite_status: 'revoked' })
    .eq('id', member.id);

  if (updateError) {
    return res.status(500).json({ error: 'Failed to remove member' });
  }

  return res.status(200).json({ success: true });
}
