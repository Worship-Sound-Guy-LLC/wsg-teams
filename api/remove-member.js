import { createClient } from '@supabase/supabase-js';
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const CIRCLE_API_TOKEN = process.env.CIRCLE_API_TOKEN;
const CIRCLE_COMMUNITY_ID = process.env.CIRCLE_COMMUNITY_ID;

const FREE_ACCESS_TAG_ID = 228295; // Triggers Circle automation to downgrade member

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

  // Apply FreeAccess tag to trigger Circle automation.
  // Circle workflow detects this tag, removes Teams access group,
  // adds Free tier access group, then removes TeamsMember tag after 1hr.
  // We do NOT attempt to remove TeamsMember directly — Circle automation handles it.
  await applyFreeAccessTag(memberEmail, member.member_circle_id);

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
  // Circle v2 returns records[], not community_members[]
  return data?.records?.[0]?.id || null;
}

// Apply FreeAccess tag — overwrites all tags with just FreeAccess.
// Circle automation "Team Member Removed" handles the rest.
async function applyFreeAccessTag(email, circleIdFromDb) {
  // Prefer the stored Circle ID, fall back to lookup by email
  const memberId = circleIdFromDb || await getCircleMemberId(email);
  if (!memberId) {
    console.log(`Circle member not found for email: ${email}`);
    return;
  }

  const patchRes = await fetch(
    `https://app.circle.so/api/admin/v2/community_members/${memberId}`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${CIRCLE_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ member_tag_ids: [FREE_ACCESS_TAG_ID] })
    }
  );
  console.log(`Applied FreeAccess tag to member ${memberId} (${email}) - PATCH status:`, patchRes.status);
}
