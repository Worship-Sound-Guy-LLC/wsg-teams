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

  // Remove TeamsMember tag from Circle safely (preserving all other tags)
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
  // Circle v2 returns records[], not community_members[]
  return data?.records?.[0]?.id || null;
}

// Safely remove a tag by fetching existing tags first and patching without target tag
async function removeCircleTag(email, tagId) {
  const memberId = await getCircleMemberId(email);
  if (!memberId) {
    console.log(`Circle member not found for email: ${email}`);
    return;
  }

  // Fetch current member to get existing tags
  const getRes = await fetch(
    `https://app.circle.so/api/admin/v2/community_members/${memberId}`,
    { headers: { Authorization: `Bearer ${CIRCLE_API_TOKEN}` } }
  );
  const member = await getRes.json();
  const existingTagIds = (member.member_tags || []).map(t => t.id);

  console.log('Existing Circle tags before removal:', existingTagIds);

  if (!existingTagIds.includes(tagId)) {
    console.log(`Tag ${tagId} not present on member ${memberId}, skipping`);
    return;
  }

  // PATCH with tag filtered out - preserves all other existing tags
  const remainingTagIds = existingTagIds.filter(id => id !== tagId);

  const patchRes = await fetch(
    `https://app.circle.so/api/admin/v2/community_members/${memberId}`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${CIRCLE_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ member_tag_ids: remainingTagIds })
    }
  );
  console.log(`Remove tag ${tagId} from member ${memberId} - PATCH status:`, patchRes.status);
}
