import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const CIRCLE_API_TOKEN = process.env.CIRCLE_API_TOKEN;
const CIRCLE_COMMUNITY_ID = process.env.CIRCLE_COMMUNITY_ID;

export default async function handler(req, res) {
  // GET — look up claim details by token (for the claim page to display)
  if (req.method === 'GET') {
    const { token } = req.query;
    if (!token) return res.status(400).json({ error: 'Token is required' });

    const { data: claim, error } = await supabase
      .from('legacy_claims')
      .select('*')
      .eq('token', token)
      .single();

    if (error || !claim) return res.status(404).json({ error: 'Claim not found' });
    if (claim.claimed) return res.status(400).json({ error: 'This claim has already been used' });
    if (new Date(claim.expires_at) < new Date()) return res.status(400).json({ error: 'This claim link has expired' });

    const COURSE_NAMES = {
      2092678: 'Sound Guy Essentials',
      2092835: 'X32 Masterclass',
      2092837: 'Drums Masterclass',
      2092710: 'EQ Secrets Masterclass',
      2331083: 'Sunday Vocal Formula'
    };

    return res.status(200).json({
      valid: true,
      leaderEmail: claim.leader_email,
      courseName: COURSE_NAMES[claim.course_id] || 'Course Team',
      seatCount: claim.seat_count,
      expiresAt: claim.expires_at
    });
  }

  // POST — process the claim
  if (req.method === 'POST') {
    const { token, email } = req.body;
    if (!token || !email) return res.status(400).json({ error: 'Token and email are required' });

    const { data: claim, error: claimError } = await supabase
      .from('legacy_claims')
      .select('*')
      .eq('token', token)
      .single();

    if (claimError || !claim) return res.status(404).json({ error: 'Claim not found' });
    if (claim.claimed) return res.status(400).json({ error: 'This claim has already been used' });
    if (new Date(claim.expires_at) < new Date()) return res.status(400).json({ error: 'This claim link has expired' });

    // Verify email matches
    if (email.toLowerCase() !== claim.leader_email) {
      return res.status(400).json({ error: 'The email you entered does not match this claim. Please use the email you originally purchased with, or contact support.' });
    }

    // Check if leader already has an active team for this course
    const { data: existingTeam } = await supabase
      .from('teams')
      .select('id')
      .eq('leader_email', claim.leader_email)
      .eq('course_id', claim.course_id)
      .eq('status', 'active')
      .single();

    if (existingTeam) {
      return res.status(400).json({ error: 'You already have an active team for this course. Please log into your dashboard.' });
    }

    // Create the team
    const inviteToken = generateToken();

    const { data: team, error: teamError } = await supabase.from('teams').insert({
      leader_email: claim.leader_email,
      access_type: 'course',
      course_id: claim.course_id,
      circle_paywall_id: claim.circle_paywall_id,
      seat_limit: claim.seat_count,
      status: 'active'
    }).select().single();

    if (teamError) {
      console.error('Error creating team from claim:', teamError);
      return res.status(500).json({ error: 'Failed to create your team. Please contact support.' });
    }

    // Create invite token
    await supabase.from('invite_tokens').insert({
      team_id: team.id,
      token: inviteToken
    });

    // Add leader as first member
    await supabase.from('team_members').insert({
      team_id: team.id,
      member_email: claim.leader_email,
      status: 'active',
      invite_status: 'active'
    });

    // Mark claim as used
    await supabase.from('legacy_claims').update({
      claimed: true,
      claimed_at: new Date().toISOString()
    }).eq('token', token);

    console.log('Legacy claim processed for', claim.leader_email, '— team created:', team.id);

    // Grant Circle access to the leader
    await addCircleSpaceMember(claim.leader_email, claim.course_id);
    await addCircleTagByEmail(claim.leader_email, getCircleTagId(claim.circle_paywall_id));

    // Send magic link so leader lands straight on the dashboard
    const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const { error: magicLinkError } = await supabaseAdmin.auth.admin.generateLink({
      type: 'magiclink',
      email: claim.leader_email,
      options: {
        redirectTo: `${process.env.SITE_URL}/dashboard`
      }
    });

    if (magicLinkError) {
      console.error('Magic link error:', magicLinkError);
      // Team was still created successfully — just tell them to log in manually
      return res.status(200).json({ success: true, magicLinkSent: false });
    }

    return res.status(200).json({ success: true, magicLinkSent: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

function getCircleTagId(circlePaywallId) {
  const tagMap = {
    '144287': 234453,
    '144288': 234457,
    '144289': 234454,
    '144291': 234456,
    '144292': 234455,
  };
  return tagMap[String(circlePaywallId)] || null;
}

async function addCircleSpaceMember(email, spaceId) {
  const res = await fetch(
    'https://app.circle.so/api/admin/v2/space_members',
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + CIRCLE_API_TOKEN,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        community_id: parseInt(CIRCLE_COMMUNITY_ID),
        space_id: spaceId,
        email: email
      })
    }
  );
  const data = await res.json();
  console.log('Add ' + email + ' to space ' + spaceId + ': ' + data?.message);
}

async function getCircleMemberId(email) {
  const res = await fetch(
    'https://app.circle.so/api/admin/v2/community_members?email=' + encodeURIComponent(email) + '&community_id=' + CIRCLE_COMMUNITY_ID,
    { headers: { Authorization: 'Bearer ' + CIRCLE_API_TOKEN } }
  );
  const data = await res.json();
  return data?.records?.[0]?.id || null;
}

async function addCircleTag(memberId, tagId) {
  if (!tagId) return;
  const getRes = await fetch(
    'https://app.circle.so/api/admin/v2/community_members/' + memberId,
    { headers: { Authorization: 'Bearer ' + CIRCLE_API_TOKEN } }
  );
  const member = await getRes.json();
  const existingTagIds = (member.member_tags || []).map(t => t.id);

  if (existingTagIds.includes(tagId)) {
    console.log('Tag ' + tagId + ' already present on member ' + memberId + ', skipping');
    return;
  }

  await fetch(
    'https://app.circle.so/api/admin/v2/community_members/' + memberId,
    {
      method: 'PATCH',
      headers: {
        Authorization: 'Bearer ' + CIRCLE_API_TOKEN,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ member_tag_ids: [...existingTagIds, tagId] })
    }
  );
}

async function addCircleTagByEmail(email, tagId) {
  if (!tagId) return;
  const memberId = await getCircleMemberId(email);
  if (!memberId) {
    console.log('Circle member not found for email:', email);
    return;
  }
  await addCircleTag(memberId, tagId);
}

function generateToken() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}
