import { createClient } from '@supabase/supabase-js';
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const CIRCLE_API_TOKEN = process.env.CIRCLE_API_TOKEN;
const CIRCLE_COMMUNITY_ID = process.env.CIRCLE_COMMUNITY_ID;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { teamId } = req.body;
  if (!teamId) return res.status(400).json({ error: 'Team ID required' });

  const { data: members, error } = await supabase
    .from('team_members')
    .select('id, member_email, member_circle_id')
    .eq('team_id', teamId)
    .neq('invite_status', 'active');

  if (error) return res.status(500).json({ error: 'Failed to fetch members' });
  if (!members || members.length === 0) return res.status(200).json({ updated: 0 });

  let updated = 0;

  for (const member of members) {
    try {
      const circleRes = await fetch(
        `https://app.circle.so/api/admin/v2/community_members?community_id=${CIRCLE_COMMUNITY_ID}&email=${encodeURIComponent(member.member_email)}`,
        { headers: { Authorization: `Bearer ${CIRCLE_API_TOKEN}` } }
      );
      const circleData = await circleRes.json();
      
      // Log full response to help debug
      console.log('Circle response for', member.member_email, JSON.stringify(circleData));

      const circleMember = circleData?.community_members?.[0];
      if (!circleMember) continue;

      const inviteStatus = circleMember.invitation_status || '';
      const isFullMember = circleMember.role === 'member' && (inviteStatus === 'accepted' || inviteStatus === 'member' || !inviteStatus);
      const hasAccount = inviteStatus === 'account_created' || inviteStatus === 'account created' || circleMember.confirmed_at;

      let newStatus = null;
      if (isFullMember) newStatus = 'active';
      else if (hasAccount) newStatus = 'viewed';

      if (newStatus) {
        await supabase
          .from('team_members')
          .update({ invite_status: newStatus, member_circle_id: circleMember.id })
          .eq('id', member.id);
        updated++;
      }
    } catch (e) {
      console.error('Error syncing member', member.member_email, e);
    }
  }

  return res.status(200).json({ updated });
}
