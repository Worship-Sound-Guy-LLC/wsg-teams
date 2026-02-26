import { createClient } from '@supabase/supabase-js';
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const CIRCLE_API_TOKEN = process.env.CIRCLE_API_TOKEN;
const CIRCLE_COMMUNITY_ID = process.env.CIRCLE_COMMUNITY_ID;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { teamId } = req.body;
  if (!teamId) return res.status(400).json({ error: 'Team ID required' });

  // Only sync members who are active (not revoked) and not yet enrolled
  const { data: members, error } = await supabase
    .from('team_members')
    .select('id, member_email, member_circle_id')
    .eq('team_id', teamId)
    .eq('status', 'active')
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

      // Circle v2 returns records[], not community_members[]
      const circleMember = circleData?.records?.[0];
      if (!circleMember) continue;

      // Circle v2 fields:
      // active + accepted_invitation = fully enrolled (profile complete)
      // accepted_invitation only = clicked link, profile not done yet
      // neither = hasn't touched invite yet
      let newStatus = null;

      if (circleMember.active === true && circleMember.profile_confirmed_at) {
        newStatus = 'active'; // Enrolled - profile complete
      } else if (circleMember.accepted_invitation) {
        newStatus = 'opened'; // Clicked invite link but not finished
      }
      // Otherwise leave as 'invited'

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
