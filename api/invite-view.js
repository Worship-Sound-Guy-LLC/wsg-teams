import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { token } = req.body;

  if (!token) {
    return res.status(400).json({ error: 'Token is required' });
  }

  // Find the invite token and get the team_id
  const { data: invite, error } = await supabase
    .from('invite_tokens')
    .select('team_id')
    .eq('token', token)
    .single();

  if (error || !invite) {
    return res.status(404).json({ error: 'Invalid token' });
  }

  // Update any 'invited' members on this team to 'viewed'
  // We update all invited members since we don't know which one clicked yet
  await supabase
    .from('team_members')
    .update({ invite_status: 'viewed' })
    .eq('team_id', invite.team_id)
    .eq('invite_status', 'invited');

  return res.status(200).json({ success: true });
}
