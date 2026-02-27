import { createClient } from '@supabase/supabase-js';
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const CIRCLE_API_TOKEN = process.env.CIRCLE_API_TOKEN;
const CIRCLE_COMMUNITY_ID = process.env.CIRCLE_COMMUNITY_ID;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { token, memberEmail, addedByLeader } = req.body;
  if (!token || !memberEmail) {
    return res.status(400).json({ error: 'Token and email are required' });
  }

  // Look up the invite token
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

  // Check if this email is already an active member (ignore revoked records)
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

  // Add member to Circle and get their Circle ID
  const circleId = await addCircleMember(memberEmail);

  // Add member to Supabase
  await supabase.from('team_members').insert({
    team_id: team.id,
    member_email: memberEmail.toLowerCase(),
    member_circle_id: circleId,
    status: 'active',
    invite_status: addedByLeader ? 'invited' : 'active'
  });

  // Mark token as used (single-use tokens only — for shareable links we skip this)
  // await supabase.from('invite_tokens').update({ used: true, used_at: new Date().toISOString() }).eq('id', invite.id);

  return res.status(200).json({ success: true, message: 'You have been added to the team!' });
}

async function addCircleMember(email) {
  // Invite member to Circle community
  const inviteRes = await fetch(
    `https://app.circle.so/api/admin/v2/community_members`,
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
    console.log('Circle invite response:', JSON.stringify(inviteData));
  const circleId = inviteData?.community_member?.id 
      || inviteData?.records?.[0]?.id 
      || inviteData?.id;
    console.log('Circle member ID:', circleId);

  // Add TeamMember tag - Circle workflow will assign WSG Teams access group automatically
  if (circleId) {
    await fetch(
      `https://app.circle.so/api/admin/v2/community_members/${circleId}/member_tags`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${CIRCLE_API_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ tag_slugs: ['TeamMember'] })
      }
    );
  }

  return circleId || null;
}
