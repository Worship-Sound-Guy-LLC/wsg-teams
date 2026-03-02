import { createClient } from '@supabase/supabase-js';
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const CIRCLE_API_TOKEN = process.env.CIRCLE_API_TOKEN;
const CIRCLE_COMMUNITY_ID = process.env.CIRCLE_COMMUNITY_ID;

const TEAMS_MEMBER_TAG_ID = 227713;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { token, memberEmail, addedByLeader } = req.body;
  if (!token || !memberEmail) {
    return res.status(400).json({ error: 'Token and email are required' });
  }

  const { data: invite, error: inviteError } = await supabase
    .from('invite_tokens')
    .select('*, teams(*)')
    .eq('token', token)
    .eq('used', false)
    .single();

  if (inviteError || !invite) {
    return res.status(400).json({ error: 'Invalid or expired invite token' });
  }

  const team = invite.teams;
  if (team.status !== 'active') {
    return res.status(400).json({ error: 'This team subscription is no longer active' });
  }

  // Check seat limit - only count non-revoked members
  const { count } = await supabase
    .from('team_members')
    .select('id', { count: 'exact' })
    .eq('team_id', team.id)
    .neq('status', 'revoked');

  if (count >= team.seat_limit) {
    return res.status(400).json({ error: 'This team is full. The team leader needs to contact support to add more seats.' });
  }

  // Check if this email is already an active (non-revoked) member
  const { data: existingMember } = await supabase
    .from('team_members')
    .select('id, status')
    .eq('team_id', team.id)
    .eq('member_email', memberEmail.toLowerCase())
    .neq('status', 'revoked')
    .single();

  if (existingMember) {
    return res.status(400).json({ error: 'This email is already a member of this team' });
  }

  // Add to Circle and apply TeamsMember tag
  const { circleId, alreadyMember } = await addCircleMember(memberEmail);

  const inviteStatus = alreadyMember ? 'active' : (addedByLeader ? 'invited' : 'active');

  // Check for a revoked record — reactivate instead of inserting a duplicate
  const { data: revokedMember } = await supabase
    .from('team_members')
    .select('id')
    .eq('team_id', team.id)
    .eq('member_email', memberEmail.toLowerCase())
    .eq('status', 'revoked')
    .single();

  if (revokedMember) {
    const { error: updateError } = await supabase
      .from('team_members')
      .update({
        status: 'active',
        invite_status: inviteStatus,
        member_circle_id: circleId
      })
      .eq('id', revokedMember.id);

    if (updateError) {
      return res.status(500).json({ error: 'Failed to re-add member' });
    }
  } else {
    const { error: insertError } = await supabase
      .from('team_members')
      .insert({
        team_id: team.id,
        member_email: memberEmail.toLowerCase(),
        member_circle_id: circleId,
        status: 'active',
        invite_status: inviteStatus
      });

    if (insertError) {
      return res.status(500).json({ error: 'Failed to add member' });
    }
  }

  return res.status(200).json({ success: true, message: 'You have been added to the team!' });
}

async function addCircleMember(email) {
  const inviteRes = await fetch(
    'https://app.circle.so/api/admin/v2/community_members',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${CIRCLE_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        community_id: parseInt(CIRCLE_COMMUNITY_ID),
        email: email,
        skip_invitation: false
      })
    }
  );

  const inviteData = await inviteRes.json();
  console.log('Circle invite response message:', inviteData?.message);

  const circleId = inviteData?.community_member?.id || null;
  const alreadyMember = inviteData?.message?.includes('already a member');

  console.log('Circle member ID:', circleId, '| Already member:', alreadyMember);

  if (circleId) {
    await addCircleTag(circleId, TEAMS_MEMBER_TAG_ID);
  }

  return { circleId, alreadyMember };
}

// Safely add a tag by fetching existing tags first and merging.
// Required because PATCH member_tag_ids REPLACES all tags.
async function addCircleTag(memberId, tagId) {
  const getRes = await fetch(
    `https://app.circle.so/api/admin/v2/community_members/${memberId}`,
    { headers: { Authorization: `Bearer ${CIRCLE_API_TOKEN}` } }
  );
  const member = await getRes.json();
  const existingTagIds = (member.member_tags || []).map(t => t.id);

  console.log('Existing Circle tags:', existingTagIds);

  if (existingTagIds.includes(tagId)) {
    console.log(`Tag ${tagId} already present on member ${memberId}, skipping`);
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
      body: JSON.stringify({ member_tag_ids: [...existingTagIds, tagId] })
    }
  );
  console.log(`Add tag ${tagId} to member ${memberId} - PATCH status:`, patchRes.status);
}
