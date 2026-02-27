import { createClient } from '@supabase/supabase-js';
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const CIRCLE_API_TOKEN = process.env.CIRCLE_API_TOKEN;
const CIRCLE_COMMUNITY_ID = process.env.CIRCLE_COMMUNITY_ID;

const TEAMS_MEMBER_TAG_ID = 227713;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { teamId, memberEmail } = req.body;
  if (!teamId || !memberEmail) {
    return res.status(400).json({ error: 'Team ID and member email are required' });
  }

  // Get the member record - only non-revoked members
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

  // Remove TeamsMember tag from Circle using tag ID
  // Circle workflow will automatically remove WSG Teams access group
  // and add Free Access access group
  await removeCircleTag(memberEmail, TEAMS_MEMBER_TAG_ID);

  // Update status in Supabase
  const { error: updateError } = await supabase
    .from('team_members')
    .update({ status: 'revoked' })
    .eq('id', member.id);

  if (updateError) {
    return res.status(500).json({ error: 'Failed to remove member' });
  }

  return res.status(200).json({ success: true });
}

async function getCircleMemberId(email) {
  const res = await fetch(
    `https://app.circle.so/api/admin/v2/community_members?email=${encodeURIComponent(email)}&community_id=${CIRCLE_COMMUNITY_ID}`,
    { headers: { Authorization: `Bearer ${CIRCLE_API_TOKEN}` } }
  );
  const data = await res.json();
  return data?.records?.[0]?.id || null;
}

async function removeCircleTag(email, tagId) {
  const memberId = await getCircleMemberId(email);
  if (!memberId) {
    console.log(`Circle member not found for email: ${email}`);
    return;
  }

  const res = await fetch(
    `https://app.circle.so/api/admin/v2/community_members/${memberId}/member_tags/${tagId}`,
    {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${CIRCLE_API_TOKEN}`,
        'Content-Type': 'application/json'
      }
    }
  );
  console.log(`Tag ${tagId} removal status for ${email}:`, res.status);
}
