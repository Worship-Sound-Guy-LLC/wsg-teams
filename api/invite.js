import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const CIRCLE_API_TOKEN = process.env.CIRCLE_API_TOKEN;
const CIRCLE_COMMUNITY_ID = process.env.CIRCLE_COMMUNITY_ID;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { token, memberEmail } = req.body;

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

  // Check seat limit
  const { count } = await supabase
    .from('team_members')
    .select('id', { count: 'exact' })
    .eq('team_id', team.id)
    .eq('status', 'active');

  if (count >= team.seat_limit) {
    return res.status(400).json({ error: 'This team is full. The team leader needs to contact support to add more seats.' });
  }

  // Check if this email is already a member
  const { data: existingMember } = await supabase
    .from('team_members')
    .select('id')
    .eq('team_id', team.id)
    .eq('member_email', memberEmail.toLowerCase())
    .single();

  if (existingMember) {
    return res.status(400).json({ error: 'This email is already a member of this team' });
  }

  // Add member to Circle and get their Circle ID
  const circleId = await addCircleMember(memberEmail, team.access_type);

  // Add member to Supabase
await supabase.from('team_members').insert({
  team_id: team.id,
  member_email: memberEmail.toLowerCase(),
  member_circle_id: circleId,
  status: 'active',
  invite_status: req.body.addedByLeader ? 'invited' : 'active'
});

  // Mark token as used (single-use tokens only — for shareable links we skip this)
  // await supabase.from('invite_tokens').update({ used: true, used_at: new Date().toISOString() }).eq('id', invite.id);

  return res.status(200).json({ success: true, message: 'You have been added to the team!' });
}

async function addCircleMember(email, accessType) {
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
  const circleId = inviteData?.community_member?.id;

  // Tag them appropriately
  if (circleId) {
    const tagSlug = accessType === 'subscription' ? 'team-member-subscription' : 'team-member-course';
    await fetch(
      `https://app.circle.so/api/admin/v2/community_members/${circleId}/member_tags`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${CIRCLE_API_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ tag_slugs: [tagSlug] })
      }
    );
  }

  return circleId || null;
}
